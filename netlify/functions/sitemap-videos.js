/* ================================================================
   GENZLOOP — Dynamic video sitemap, served from Netlify (FREE,
   no Firebase Blaze plan needed, no npm install needed).

   This file has ZERO external dependencies (no firebase-admin) —
   it signs its own short-lived Google access token using Node's
   built-in `crypto` module, then talks to the Firestore REST API
   directly with the built-in `fetch`. This matters because a plain
   drag-and-drop ("Netlify Drop") deploy never runs `npm install`,
   so any function that needed an npm package would crash with
   "Cannot find module" — this one can't, since it needs none.

   Needs 3 environment variables (Netlify -> Site configuration ->
   Environment variables) — see SETUP-NETLIFY-SITEMAP.md:
     FIREBASE_PROJECT_ID
     FIREBASE_CLIENT_EMAIL
     FIREBASE_PRIVATE_KEY
================================================================ */
const crypto = require("crypto");

const SITE_BASE = "https://genzloop.com"; // apna asli domain alag ho to yahan badal dein

function base64url(input) {
  return Buffer.from(input)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
}

/* Builds and signs a Google service-account JWT, trades it for a short-lived
   OAuth access token — this is the exact "JWT Bearer" flow Google documents,
   just written out by hand instead of via the firebase-admin/google-auth-library
   packages. */
async function getAccessToken(clientEmail, privateKey) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const claims = base64url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey)
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(jwt),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Google token exchange failed: " + JSON.stringify(data));
  }
  return data.access_token;
}

/* Firestore REST API's typed-value fields -> plain JS values */
function readField(fields, name) {
  const f = fields && fields[name];
  if (!f) return undefined;
  if ("stringValue" in f) return f.stringValue;
  if ("timestampValue" in f) return f.timestampValue;
  return undefined;
}

exports.handler = async function () {
  try {
    const missing = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]
        .filter((k) => !process.env[k]);
    if (missing.length) {
      return {
        statusCode: 500,
        headers: {"Content-Type": "text/plain; charset=UTF-8"},
        body: "Sitemap not configured yet — missing Netlify environment variable(s): " +
          missing.join(", ") + ". See SETUP-NETLIFY-SITEMAP.md.",
      };
    }

    const projectId = process.env.FIREBASE_PROJECT_ID.trim();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL.trim();

    // Mobile keyboards / copy-paste often mangle the "-----BEGIN/END-----" markers (smart
    // punctuation can turn "-----" into a single em-dash, whitespace can collapse, etc). None
    // of that matters for the actual key — only the base64 body between the markers is real
    // cryptographic material. So: pull out everything that looks like base64, throw away
    // whatever surrounds it (quotes, mangled markers, stray whitespace), and rebuild a
    // clean, guaranteed-valid PEM ourselves.
    let rawKey = process.env.FIREBASE_PRIVATE_KEY.trim();
    if (rawKey.startsWith("\"") && rawKey.endsWith("\"")) rawKey = rawKey.slice(1, -1);
    rawKey = rawKey.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");

    // Remove the marker phrases by their words (not by counting dashes — a mobile keyboard's
    // "smart punctuation" can turn "-----" into a single em-dash, which would otherwise leave
    // "BEGINPRIVATEKEY" stuck onto the real base64, since those letters are valid base64 too).
    rawKey = rawKey
        .replace(/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ")
        .replace(/END\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ");
    // Whatever is left that isn't a real base64 character (letters, digits, + / =) — any
    // flavour of dash, stray quotes, spaces — gets dropped too.
    const base64Body = rawKey.replace(/[^A-Za-z0-9+/=]/g, "");

    if (base64Body.length < 800) { // a real 2048-bit RSA PKCS8 key's base64 body is ~1600 chars
      return {
        statusCode: 500,
        headers: {"Content-Type": "text/plain; charset=UTF-8"},
        body: "FIREBASE_PRIVATE_KEY adhoori ya khali lag rahi hai (sirf " + base64Body.length +
          " valid characters mile, ek asli key mein ~1600+ hote hain). Firebase se JSON file " +
          "dobara kholo, private_key ki poori value copy-paste karke Netlify mein dobara save karein.",
      };
    }
    const wrapped = base64Body.match(/.{1,64}/g).join("\n");
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;

    let accessToken;
    try {
      accessToken = await getAccessToken(clientEmail, privateKey);
    } catch (signErr) {
      return {
        statusCode: 500,
        headers: {"Content-Type": "text/plain; charset=UTF-8"},
        body: "Google ko sign-in nahi ho saka — FIREBASE_PRIVATE_KEY ya FIREBASE_CLIENT_EMAIL galat/adhoori " +
          "lagti hai. Firebase se JSON file dobara kholo, private_key ki poori value (BEGIN se END tak, " +
          "quotes \" ke bina) dobara copy-paste karo. Asal error: " +
          (signErr && signErr.message ? signErr.message : String(signErr)),
      };
    }

    const queryRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            structuredQuery: {
              from: [{collectionId: "videos"}],
              orderBy: [{field: {fieldPath: "createdAt"}, direction: "DESCENDING"}],
              limit: 5000, // itni videos ke baad bhi kaafi hai; badhana ho to yahan number badla ja sakta hai
            },
          }),
        },
    );
    const rows = await queryRes.json();
    if (!queryRes.ok) {
      throw new Error("Firestore query failed: " + JSON.stringify(rows));
    }

    const urls = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row.document) return; // progress-only rows have no document
      const fields = row.document.fields || {};
      const visibility = readField(fields, "visibility");
      if (visibility === "Private" || visibility === "Unlisted") return; // sirf Public videos
      const id = row.document.name.split("/").pop();
      const lastmod = readField(fields, "createdAt") || new Date().toISOString();
      urls.push(
          "  <url>\n" +
          `    <loc>${SITE_BASE}/?v=${id}</loc>\n` +
          `    <lastmod>${lastmod}</lastmod>\n` +
          "    <changefreq>weekly</changefreq>\n" +
          "    <priority>0.7</priority>\n" +
          "  </url>",
      );
    });

    const xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
      "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
      urls.join("\n") + "\n" +
      "</urlset>";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/xml; charset=UTF-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
      body: xml,
    };
  } catch (err) {
    console.error("sitemap-videos error:", err);
    return {
      statusCode: 500,
      headers: {"Content-Type": "text/plain; charset=UTF-8"},
      body: "Sitemap generation failed: " + (err && err.message ? err.message : String(err)),
    };
  }
};

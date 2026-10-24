/* ================================================================
   GENZLOOP — Dynamic video sitemap on CLOUDFLARE (replaces the Netlify function).
   Route:  GET /sitemap-videos.xml
   Needs the SAME 3 variables your push/views worker already uses:
     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

   HOW TO USE (pick ONE):
   A) Add to your existing worker (arain-api): paste everything from "const SM_SITE_BASE"
      down to the end of smHandle() into that worker, then at the very top of its
      fetch(request, env, ctx) add:
          if (request.method === "GET" && new URL(request.url).pathname === "/sitemap-videos.xml") return smHandle(request, env, ctx);
   B) Or make a NEW worker and paste this WHOLE file (the "export default" at the bottom is
      only for this case); add the 3 variables to that new worker.
================================================================ */
const SM_SITE_BASE = "https://genzloop.com"; /* the domain that serves the videos */

const smEnc = new TextEncoder();
function smB64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function smPemToDer(raw) {
  raw = String(raw || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  raw = raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n")
    .replace(/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ").replace(/END\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ");
  const body = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  if (body.length < 800) throw new Error("FIREBASE_PRIVATE_KEY adhoori ya khali hai");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}
async function smAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = smB64u(smEnc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = smB64u(smEnc.encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL.trim(),
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  const unsigned = head + "." + claims;
  const key = await crypto.subtle.importKey("pkcs8", smPemToDer(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, smEnc.encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(unsigned + "." + smB64u(sig)),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error("Google token exchange failed: " + JSON.stringify(d));
  return d.access_token;
}
function smField(fields, name) {
  const f = fields && fields[name];
  if (!f) return undefined;
  if ("stringValue" in f) return f.stringValue;
  if ("timestampValue" in f) return f.timestampValue;
  return undefined;
}
async function smHandle(request, env, ctx) {
  const text = (code, msg) => new Response(msg, { status: code, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  try {
    const missing = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"].filter((k) => !env[k]);
    if (missing.length) return text(500, "Sitemap not configured — missing variable(s): " + missing.join(", "));

    /* edge cache for 1 hour so Firestore is not read on every request */
    const cache = (typeof caches !== "undefined" && caches.default) ? caches.default : null;
    const cacheKey = new Request("https://sitemap.cache/sitemap-videos.xml");
    if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }

    const token = await smAccessToken(env);
    const qr = await fetch(
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID.trim()}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: "videos" }],
          orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
          limit: 5000,
        } }),
      });
    const rows = await qr.json();
    if (!qr.ok) throw new Error("Firestore query failed: " + JSON.stringify(rows));

    const urls = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row.document) return;
      const fields = row.document.fields || {};
      const vis = smField(fields, "visibility");
      if (vis === "Private" || vis === "Unlisted") return; /* Public videos only */
      const id = row.document.name.split("/").pop();
      const lastmod = smField(fields, "createdAt") || new Date().toISOString();
      urls.push("  <url>\n    <loc>" + SM_SITE_BASE + "/?v=" + id + "</loc>\n    <lastmod>" + lastmod +
        "</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>");
    });
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join("\n") + "\n</urlset>";
    const res = new Response(xml, { status: 200, headers: {
      "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=3600, s-maxage=3600",
    } });
    if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return text(500, "Sitemap generation failed: " + (err && err.message ? err.message : String(err)));
  }
}

/* ---- ONLY for option B (new worker). Delete this block if you pasted into arain-api. ---- */
export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET" && new URL(request.url).pathname === "/sitemap-videos.xml") return smHandle(request, env, ctx);
    return new Response("not found", { status: 404 });
  },
};

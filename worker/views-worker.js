/* ================================================================
   GENZLOOP — "views" Worker (Cloudflare Workers, free plan is enough)

   Why: a view's COUNTRY must come from the server (the visitor's real IP),
   never from the phone/browser, otherwise anybody could claim "US" and take
   a bigger share of the US ad money.

   What it does for POST /view  { videoId, source, vpn, tz, off }:
     1. checks the Firebase login token
     2. reads the visitor's country from Cloudflare (request.cf.country)
     3. runs the VPN / proxy / hosting checks (see below)
     4. creates  views/{uid}_{videoId}  and does videos/{videoId}.views + 1
        in ONE atomic Firestore commit (a second view of the same video by the
        same account is ignored, exactly like before)

   VPN / proxy checks (any ONE hit => the view is saved with vpn:true and is
   paid from the "Other" pool, never from a high-paying country pool):
     - Tor exit node                          (Cloudflare reports country "T1")
     - IP belongs to a hosting / VPN company  (ASN name list below, free)
     - IP-reputation lookup                   (optional: PROXYCHECK_KEY or VPNAPI_KEY)
     - Android app says a VPN is switched on  (can only make a view stricter)
     - phone clock timezone does not fit the IP country (e.g. US IP + Pakistan clock)

   Secrets (Worker -> Settings -> Variables and Secrets) — same ones as push:
     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
   Optional: FIREBASE_API_KEY, PROXYCHECK_KEY, VPNAPI_KEY
================================================================ */

const DEFAULT_API_KEY = "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w"; /* public web key, same as push.js / turn.js */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* hosting / datacenter / VPN companies (matched against the IP's network name) */
const HOSTING_RE = new RegExp([
  "m247", "datacamp", "choopa", "vultr", "digitalocean", "digital ocean", "ovh", "hetzner", "amazon", "aws ", "google llc", "google cloud",
  "microsoft", "azure", "linode", "akamai", "leaseweb", "contabo", "oracle", "packethub", "clouvider", "quadranet", "zenlayer", "cdn77",
  "gsl networks", "tefincom", "nordvpn", "nord security", "mullvad", "proton ag", "protonvpn", "surfshark", "expressvpn", "private internet access",
  "cyberghost", "ipvanish", "windscribe", "hide.me", "tunnelbear", "hotspot shield", "anchorfree", "kape", "performive", "worldstream", "serverius",
  "frantech", "buyvm", "scaleway", "ionos", "psychz", "colocrossing", "sharktech", "dedipath", "rackspace", "softlayer", "ibm cloud", "alibaba",
  "tencent", "ucloud", "stark industries", "datapacket", "bl networks", "xtom", "tzulo", "path network", "g-core", "constant company",
  "cloudflare", "zscaler", "netskope", "fastly", "precision hawk", "hostinger", "namecheap", "godaddy", "web hosting", "datacenter", "data center",
  "vpn", "proxy",
].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

/* acceptable clock offsets (hours from UTC, DST included) for the countries that matter for ad money */
const TZ_OK = {
  US: [-10, -4], CA: [-8, -2.5], MX: [-8, -5], GB: [0, 1], IE: [0, 1], PT: [0, 1], ES: [0, 2], FR: [1, 2], DE: [1, 2], NL: [1, 2], BE: [1, 2],
  IT: [1, 2], CH: [1, 2], AT: [1, 2], SE: [1, 2], NO: [1, 2], DK: [1, 2], PL: [1, 2], FI: [2, 3], AU: [8, 11], NZ: [12, 14],
  AE: [4, 4], SA: [3, 3], QA: [3, 3], KW: [3, 3], PK: [5, 5], IN: [5.5, 5.5], BD: [6, 6], SG: [8, 8], JP: [9, 9], KR: [9, 9],
};

/* ---------- Firestore access (service account) ---------- */
const enc = new TextEncoder();
const b64u = (buf) => {
  let s = ""; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let cachedToken = { tok: "", exp: 0 };

async function accessToken(env) {
  if (cachedToken.tok && Date.now() < cachedToken.exp) return cachedToken.tok;
  const email = env.FIREBASE_CLIENT_EMAIL;
  let raw = (env.FIREBASE_PRIVATE_KEY || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  raw = raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n")
    .replace(/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ").replace(/END\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ");
  const body64 = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!email || body64.length < 800) throw new Error("missing service account secrets");
  const der = Uint8Array.from(atob(body64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64u(enc.encode(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head + "." + claim)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(head + "." + claim + "." + sig),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("token exchange failed");
  cachedToken = { tok: d.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
}

/* ---------- optional IP-reputation lookup ---------- */
async function reputationFlag(ip, env) {
  if (!ip) return "";
  if (env.PROXYCHECK_KEY) {
    try {
      const r = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?key=${encodeURIComponent(env.PROXYCHECK_KEY)}&vpn=1`, { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      const x = d && Object.values(d).find((v) => v && typeof v === "object" && "proxy" in v);
      if (x && String(x.proxy).toLowerCase() === "yes") return "ipdb";
    } catch (e) { /* ignore: a failed lookup must never block a view */ }
  }
  if (env.VPNAPI_KEY) {
    try {
      const r = await fetch(`https://vpnapi.io/api/${encodeURIComponent(ip)}?key=${encodeURIComponent(env.VPNAPI_KEY)}`, { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      const s = d && d.security;
      if (s && (s.vpn || s.proxy || s.tor || s.relay)) return "ipdb";
    } catch (e) { /* ignore */ }
  }
  return "";
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (request.method !== "POST" || path !== "/view") return json(404, { error: "not found" });
    try {
      const pid = env.FIREBASE_PROJECT_ID;
      if (!pid) return json(500, { error: "missing env vars" });

      /* 1. who is calling */
      const idToken = ((request.headers.get("Authorization") || "").replace(/^Bearer /i, "")).trim();
      if (!idToken) return json(401, { error: "no token" });
      const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + (env.FIREBASE_API_KEY || DEFAULT_API_KEY), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
      });
      const ld = await lr.json();
      const uid = ld.users && ld.users[0] && ld.users[0].localId;
      if (!uid) return json(401, { error: "bad token" });

      const body = await request.json().catch(() => ({}));
      const videoId = String(body.videoId || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) return json(400, { error: "bad videoId" });
      const source = body.source === "app" ? "app" : "web";

      /* 2. country = from the connection, not from the client */
      const cf = request.cf || {};
      let country = String(cf.country || request.headers.get("CF-IPCountry") || "").toUpperCase();
      const ip = request.headers.get("CF-Connecting-IP") || "";
      const why = [];
      if (country === "T1") { why.push("tor"); country = "XX"; }
      if (!/^[A-Z]{2}$/.test(country)) country = "XX";

      /* 3. VPN / proxy signals */
      if (cf.asOrganization && HOSTING_RE.test(String(cf.asOrganization))) why.push("asn");
      if (body.vpn === true) why.push("app-vpn");
      const off = Number(body.off);
      const range = TZ_OK[country];
      if (range && Number.isFinite(off) && Math.abs(off) <= 14 * 60) {
        const h = off / 60;
        if (h < range[0] - 0.01 || h > range[1] + 0.01) why.push("tz");
      }
      if (!why.length) { const rep = await reputationFlag(ip, env); if (rep) why.push(rep); }
      const vpn = why.length > 0;

      /* 4. write the view + bump the counter, atomically */
      const at = await accessToken(env);
      const base = `projects/${pid}/databases/(default)/documents`;
      const fields = {
        uid: { stringValue: uid }, videoId: { stringValue: videoId }, source: { stringValue: source },
        country: { stringValue: country }, vpn: { booleanValue: vpn },
      };
      if (vpn) fields.vpnWhy = { stringValue: why.join(",") };
      const cr = await fetch(`https://firestore.googleapis.com/v1/${base}:commit`, {
        method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" },
        body: JSON.stringify({ writes: [
          { update: { name: `${base}/views/${uid}_${videoId}`, fields }, currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }] },
          { transform: { document: `${base}/videos/${videoId}`, fieldTransforms: [{ fieldPath: "views", increment: { integerValue: "1" } }] },
            currentDocument: { exists: true } },
        ] }),
      });
      if (cr.ok) return json(200, { ok: true, counted: true, country, vpn });
      const err = await cr.json().catch(() => ({}));
      const st = err && err.error && err.error.status;
      if (cr.status === 409 || st === "ALREADY_EXISTS") return json(200, { ok: true, counted: false, reason: "already counted" });
      if (cr.status === 404 || st === "NOT_FOUND") return json(404, { ok: false, reason: "video not found" });
      return json(502, { ok: false, error: st || "firestore" });
    } catch (e) {
      return json(500, { ok: false, error: String((e && e.message) || e) });
    }
  },
};

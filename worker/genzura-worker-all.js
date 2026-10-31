/* ================================================================
   GUPZY (ex Arain Tube) — ONE Cloudflare Worker for everything (free plan)
     POST /push               -> push notifications
     GET  /turn               -> call TURN credentials
     POST /view               -> country-aware view count
     GET  /sitemap-videos.xml -> video sitemap for Google
     POST /ring-ack           -> phone confirms "call reached me" (caller sees Ringing)
     POST /anon-send          -> anonymous inbox message (server-side rate limit + push)   (NEW)
     POST /contacts           -> contacts sync / "who saved me" count                      (NEW)
     POST /translate          -> one-tap Urdu / English translate                         (NEW)
     CRON (every 5 min)       -> Real Moments: once a day at the random "Gupzy Time" sends ONE push to everybody   (NEW)
   Secrets: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
            EXPRESSTURN_USER, EXPRESSTURN_PASS
   Optional: PROXYCHECK_KEY or VPNAPI_KEY (better VPN detection), ALLOWED_ORIGIN, ANON_SALT
   ================================================================ */
const API = (() => {
/* ---- push + turn ---- */
const DEFAULT_API_KEY = "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w";
const enc = new TextEncoder();

const b64uBytes = (buf) => {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uStr = (str) => b64uBytes(enc.encode(str));

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}
const out = (env, code, o) =>
  new Response(JSON.stringify(o), { status: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) } });

/* --- Firebase ID token check (same as the Netlify version) --- */
async function verifyUser(request, env) {
  const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer /i, "").trim();
  if (!idToken) return { err: "no token" };
  const key = env.FIREBASE_API_KEY || DEFAULT_API_KEY;
  const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + key, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
  });
  const d = await r.json();
  const uid = d.users && d.users[0] && d.users[0].localId;
  return uid ? { uid } : { err: "bad token" };
}

/* --- service-account private key -> DER (accepts keys pasted with \n, quotes, spaces) --- */
function privateKeyDer(env) {
  let raw = (env.FIREBASE_PRIVATE_KEY || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  raw = raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n")
    .replace(/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ").replace(/END\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ");
  const body64 = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  if (body64.length < 800) return null;
  const bin = atob(body64); const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

let _tok = { v: "", exp: 0 };
async function accessToken(env) {
  if (_tok.v && Date.now() < _tok.exp) return _tok.v; /* reused for ~50 min */
  const der = privateKeyDer(env);
  if (!der) throw new Error("bad FIREBASE_PRIVATE_KEY");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const h = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const c = b64uStr(JSON.stringify({ iss: env.FIREBASE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64uBytes(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(h + "." + c)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(h + "." + c + "." + sig) });
  const d = await r.json();
  if (!d.access_token) throw new Error("token exchange failed");
  _tok = { v: d.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
}

const TEXT = {
  message: "sent you a message", call: "is calling you", like: "liked your post", comment: "commented on your post",
  follow: "started following you", reelLike: "liked your reel", reelComment: "commented on your reel",
  mention: "mentioned you", reply: "replied to your comment", commentLike: "liked your comment", tag: "tagged you in a post",
  game: "invited you to play Truth · Dare · Roast 🎲",
};

async function push(request, env) {
  if (request.method !== "POST") return out(env, 405, { error: "POST only" });
  const pid = env.FIREBASE_PROJECT_ID;
  if (!pid || !env.FIREBASE_CLIENT_EMAIL || !privateKeyDer(env)) return out(env, 500, { error: "missing env vars" });

  const u = await verifyUser(request, env);
  if (u.err) return out(env, 401, { error: u.err });
  const from = u.uid;

  let body = {}; try { body = await request.json(); } catch (e) {}
  const kind = String(body.kind || "");
  if (!TEXT[kind]) return out(env, 400, { error: "bad kind" });

  const at = await accessToken(env);
  const A = { Authorization: "Bearer " + at, "Content-Type": "application/json" };
  const DOCS = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

  let targets = [];
  if (kind === "message") {
    const cid = String(body.chatId || "").replace(/[^A-Za-z0-9_\-]/g, "");
    const cd = await (await fetch(`${DOCS}/chats/${cid}`, { headers: A })).json();
    const members = ((cd.fields && cd.fields.members && cd.fields.members.arrayValue.values) || []).map((v) => v.stringValue);
    if (!members.includes(from)) return out(env, 403, { error: "not a member" });
    const mf = (cd.fields && cd.fields.mute && cd.fields.mute.mapValue && cd.fields.mute.mapValue.fields) || {};
    targets = members.filter((x) => x !== from && !(mf[x] && mf[x].booleanValue === true));
  } else {
    const to = String(body.toUid || "");
    if (!to || to === from) return out(env, 200, { sent: 0 });
    targets = [to];
  }
  if (!targets.length) return out(env, 200, { sent: 0 });

  let name = "Gupzy";
  try {
    const nd = await (await fetch(`${DOCS}/channels/${from}`, { headers: A })).json();
    if (nd.fields && nd.fields.name) name = nd.fields.name.stringValue;
  } catch (e) {}

  let sent = 0;
  for (const uid of targets.slice(0, 50)) {
    const rows = await (await fetch(`${DOCS}:runQuery`, { method: "POST", headers: A, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "fcmTokens" }],
      where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 10 } }) })).json();
    const tokens = (Array.isArray(rows) ? rows : []).filter((r) => r.document).map((r) => r.document.name.split("/").pop());
    for (const token of tokens) {
      /* a CALL push must expire after 45 s: a phone that comes online later must NOT ring for an old call */
      const isCall = kind === "call";
      const mr = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, { method: "POST", headers: A,
        body: JSON.stringify({ message: { token, data: { title: name,
          body: TEXT[kind] + (kind === "call" ? (body.type === "video" ? " (video)" : " (voice)") : ""),
          tag: kind === "message" ? "c_" + (body.chatId || "") : "n_" + kind },
          webpush: { headers: { Urgency: "high", TTL: isCall ? "45" : "86400" } }, android: { priority: "HIGH", ttl: isCall ? "45s" : "86400s" } } }) });
      if (mr.ok) sent++;
      else if (mr.status === 404 || mr.status === 400) {
        await fetch(`${DOCS}/fcmTokens/${encodeURIComponent(token)}`, { method: "DELETE", headers: A }).catch(() => {});
      }
    }
  }
  return out(env, 200, { sent });
}

async function turn(request, env) {
  const u = await verifyUser(request, env);
  if (u.err) return out(env, 401, { error: u.err });

  if (env.EXPRESSTURN_USER && env.EXPRESSTURN_PASS) {
    const clean = (v) => String(v).trim().replace(/^["']+|["']+$/g, "").trim();
    const host = clean(env.EXPRESSTURN_HOST || "free.expressturn.com").replace(/:\d+$/, "");
    return out(env, 200, { iceServers: [
      { urls: "stun:" + host + ":3478" },
      { urls: ["turn:" + host + ":3478?transport=udp", "turn:" + host + ":3478?transport=tcp", "turn:" + host + ":443?transport=tcp", "turn:" + host + ":80?transport=tcp"],
        username: clean(env.EXPRESSTURN_USER), credential: clean(env.EXPRESSTURN_PASS) },
    ] });
  }
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST", headers: { Authorization: "Bearer " + env.CF_TURN_API_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 86400 }) });
    const d = await r.json();
    if (!r.ok || !d.iceServers) return out(env, 502, { error: "cloudflare", detail: d });
    return out(env, 200, { iceServers: d.iceServers });
  }
  if (env.METERED_APP && env.METERED_API_KEY) {
    const r = await fetch(`https://${env.METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${env.METERED_API_KEY}`);
    const d = await r.json();
    if (!r.ok || !Array.isArray(d)) return out(env, 502, { error: "metered", detail: d });
    return out(env, 200, { iceServers: d });
  }
  return out(env, 404, { error: "TURN not configured" });
}

return {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    const p = new URL(request.url).pathname.replace(/\/+$/, "");
    try {
      if (p === "/push") return await push(request, env);
      if (p === "/turn") return await turn(request, env);
      return out(env, 200, { ok: true, service: "genzura-api" });
    } catch (e) {
      return out(env, 500, { error: String((e && e.message) || e) });
    }
  },
};

})();
const VIEWS = (() => {
/* ---- country-aware view counting (a view's COUNTRY must come from the server, never from the phone) ---- */

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

return {
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

})();

/* ================================================================
   Video sitemap  (GET /sitemap-videos.xml)
================================================================ */
const SM_SITE_BASE = "https://gupzy.com"; /* the domain that serves the videos */

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

/* ================================================================
   ring-ack  (POST /ring-ack)
   The callee's Android app calls this the moment the call notification reaches the phone (even if the
   app is closed). It sets calls/{id}.calleeRinging = true, so the caller sees "Ringing" (phone online)
   instead of "Calling" (phone offline / unreachable).
   body: { "token": "<FCM token of the phone>" }  ->  token -> user -> that user's newest ringing call
================================================================ */
const rkEnc = new TextEncoder();
function rkB64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function rkPemToDer(raw) {
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
async function rkAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = rkB64u(rkEnc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = rkB64u(rkEnc.encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL.trim(),
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  const unsigned = head + "." + claims;
  const key = await crypto.subtle.importKey("pkcs8", rkPemToDer(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, rkEnc.encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(unsigned + "." + rkB64u(sig)),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error("Google token exchange failed");
  return d.access_token;
}
async function rkHandle(request, env) {
  const J = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { "Content-Type": "application/json" } });
  try {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return J(500, { error: "missing variables" });
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || "");
    if (token.length < 20) return J(400, { error: "bad token" });
    const at = await rkAccessToken(env);
    const A = { Authorization: "Bearer " + at, "Content-Type": "application/json" };
    const DOCS = "https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID.trim() + "/databases/(default)/documents";

    const tr = await fetch(DOCS + "/fcmTokens/" + encodeURIComponent(token), { headers: A });
    if (!tr.ok) return J(404, { error: "unknown token" });
    const uid = (((await tr.json()).fields || {}).uid || {}).stringValue;
    if (!uid) return J(404, { error: "no user" });
    const qr = await fetch(DOCS + ":runQuery", { method: "POST", headers: A, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "calls" }],
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "calleeId" }, op: "EQUAL", value: { stringValue: uid } } },
        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "ringing" } } } ] } },
      limit: 10 } }) });
    const rows = await qr.json();
    let best = null, bt = 0;
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (!r.document) return;
      const t = Date.parse((((r.document.fields || {}).createdAt) || {}).timestampValue || "") || 0;
      if (t > bt) { bt = t; best = r.document.name.split("/").pop(); }
    });
    if (!best || Date.now() - bt > 90000) return J(200, { ok: false });
    const pr = await fetch(DOCS + "/calls/" + best + "?updateMask.fieldPaths=calleeRinging", {
      method: "PATCH", headers: A, body: JSON.stringify({ fields: { calleeRinging: { booleanValue: true } } }) });
    return J(200, { ok: pr.ok });
  } catch (e) {
    return J(500, { error: String((e && e.message) || e) });
  }
}

/* ================================================================
   NEW: Anonymous Inbox  (POST /anon-send)
   - message server se likhta hai (Firestore rules mein client ko create ki ijazat NAHI)
   - cooldown SERVER par:
       ek IP -> ek creator ko: 30 second mein 1 message
       ek IP: ghante mein 20 message (sab creators milakar)
       ek creator: ghante mein 100 anonymous message
   - creator ke phone par generic push: "You got a new anonymous message" (text push mein nahi)
   Sender ki pehchan message mein SAVE NAHI hoti. Rate-limit ke liye sirf IP ka salted hash
   anonRate/ collection mein 1-2 ghante ke liye rehta hai (expireAt par TTL policy laga dein).
   Body: { "toUid": "<creator uid>", "text": "..." }
   Optional variable: ANON_SALT (lamba random text; na dein to client email use hota hai)
================================================================ */
const anEnc = new TextEncoder();
const AN_ORIGINS = ["https://gupzy.com", "https://www.gupzy.com", "https://genzura.netlify.app", "https://genzura.muhammadqasimishtiaq0604.workers.dev"]; /* new domain + old links, so nothing breaks while moving */
const AN_MAX = 300, AN_COOLDOWN_MS = 30000, AN_IP_PER_HOUR = 20, AN_TO_PER_HOUR = 100, AN_HOUR = 3600000;

function anB64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function anPemToDer(raw) {
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
/* cloud-platform scope = Firestore + FCM dono */
async function anAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = anB64u(anEnc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = anB64u(anEnc.encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL.trim(),
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  const unsigned = head + "." + claims;
  const key = await crypto.subtle.importKey("pkcs8", anPemToDer(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, anEnc.encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(unsigned + "." + anB64u(sig)),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error("Google token exchange failed");
  return d.access_token;
}
async function anHash(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", anEnc.encode(s)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
/* rate-limit counters live in anonRate/{id}: {last, start, count, expireAt} */
async function anGet(DOCS, A, id) {
  const r = await fetch(DOCS + "/anonRate/" + id, { headers: A });
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  const n = (k) => +((f[k] || {}).integerValue || 0);
  return { last: n("last"), start: n("start"), count: n("count") };
}
function anPut(DOCS, A, id, o) {
  return fetch(DOCS + "/anonRate/" + id, { method: "PATCH", headers: A, body: JSON.stringify({ fields: {
    last: { integerValue: String(o.last) }, start: { integerValue: String(o.start) }, count: { integerValue: String(o.count) },
    expireAt: { timestampValue: new Date(o.start + 2 * AN_HOUR).toISOString() } } }) }).catch(() => {});
}
function anWindow(doc, now) {
  return (!doc || now - doc.start > AN_HOUR) ? { start: now, count: 0, last: 0 } : doc;
}

async function anHandle(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const AN_ORIGIN = AN_ORIGINS.indexOf(reqOrigin) >= 0 ? reqOrigin : AN_ORIGINS[0];
  const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": AN_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
  const J = (code, o) => new Response(JSON.stringify(o), { status: code, headers: H });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  if (request.method !== "POST") return J(405, { error: "POST only" });
  try {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return J(500, { error: "missing variables" });
    const body = await request.json().catch(() => ({}));
    const toUid = String(body.toUid || "").trim();
    const text = String(body.text || "").trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(toUid)) return J(400, { error: "bad toUid" });
    if (!text || text.length > AN_MAX) return J(400, { error: "bad text" });

    const pid = env.FIREBASE_PROJECT_ID.trim();
    const at = await anAccessToken(env);
    const A = { Authorization: "Bearer " + at, "Content-Type": "application/json" };
    const DOCS = "https://firestore.googleapis.com/v1/projects/" + pid + "/databases/(default)/documents";

    /* creator must exist (random uids par junk likhne se bachata hai) */
    const cr = await fetch(DOCS + "/channels/" + toUid, { headers: A });
    if (cr.status === 404) return J(404, { error: "no-channel" });
    if (!cr.ok) return J(502, { error: "lookup failed" });

    /* ---- server-side rate limit ---- */
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const salt = env.ANON_SALT || env.FIREBASE_CLIENT_EMAIL;
    const ipH = await anHash(ip + "|" + salt);
    const pairId = "p_" + await anHash(ip + "|" + toUid + "|" + salt);
    const ipId = "i_" + ipH, toId = "t_" + toUid;
    const now = Date.now();
    const [pair, ipDoc, toDoc] = await Promise.all([anGet(DOCS, A, pairId), anGet(DOCS, A, ipId), anGet(DOCS, A, toId)]);
    if (pair && now - pair.last < AN_COOLDOWN_MS) return J(429, { error: "slow-down", retryAfter: Math.ceil((AN_COOLDOWN_MS - (now - pair.last)) / 1000) });
    const ipc = anWindow(ipDoc, now), toc = anWindow(toDoc, now);
    if (ipc.count >= AN_IP_PER_HOUR || toc.count >= AN_TO_PER_HOUR) return J(429, { error: "too-many", retryAfter: 600 });

    /* ---- save the message (no sender info at all) ---- */
    const wr = await fetch(DOCS + "/anonMessages", { method: "POST", headers: A, body: JSON.stringify({ fields: {
      toUid: { stringValue: toUid }, text: { stringValue: text }, read: { booleanValue: false },
      createdAt: { timestampValue: new Date(now).toISOString() } } }) });
    if (!wr.ok) return J(502, { error: "save failed" });
    await Promise.all([
      anPut(DOCS, A, pairId, { last: now, start: now, count: 1 }),
      anPut(DOCS, A, ipId, { last: now, start: ipc.start, count: ipc.count + 1 }),
      anPut(DOCS, A, toId, { last: now, start: toc.start, count: toc.count + 1 }),
    ]);

    /* ---- push (generic text, message content never leaves Firestore). Failure here never fails the send. ---- */
    let pushed = 0;
    try {
      const qr = await fetch(DOCS + ":runQuery", { method: "POST", headers: A, body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "fcmTokens" }],
        where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: toUid } } }, limit: 10 } }) });
      const rows = await qr.json();
      const tokens = (Array.isArray(rows) ? rows : []).filter((r) => r.document).map((r) => r.document.name.split("/").pop());
      for (const token of tokens) {
        const mr = await fetch("https://fcm.googleapis.com/v1/projects/" + pid + "/messages:send", { method: "POST", headers: A,
          body: JSON.stringify({ message: { token,
            data: { title: "Anonymous inbox", body: "You got a new anonymous message \uD83E\uDD2B", tag: "n_anon", callId: "" },
            webpush: { headers: { Urgency: "high", TTL: "86400" } }, android: { priority: "HIGH", ttl: "86400s" } } }) });
        if (mr.ok) pushed++;
        else if (mr.status === 404 || mr.status === 400) await fetch(DOCS + "/fcmTokens/" + encodeURIComponent(token), { method: "DELETE", headers: A }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    return J(200, { ok: true, pushed });
  } catch (e) {
    return J(500, { error: String(e.message || e) });
  }
}

/* ================================================================
   NEW: Real Moments daily push  (Cron Trigger, no URL)
   Once a day, at the random "Gupzy Time", sends ONE push to every phone with a saved FCM token.
   Free plan allows only 50 outgoing requests per run, so tokens are subscribed to an FCM topic
   (1000 per request) and ONE topic message is sent. A Firestore doc momentPush/{day} makes sure it is sent only once a day.
   The daily time uses the SAME formula as index.html (Real Moments block): keep MM_START_MIN / MM_SPAN_MIN / MM_STEP_MIN equal.
   Cron Trigger to add in Cloudflare:  every 5 minutes  (the value is written in REAL_MOMENTS_SETUP.txt)
================================================================ */
const MM_START_MIN = 300, MM_SPAN_MIN = 660, MM_STEP_MIN = 5;   /* 05:00-16:00 UTC = 10:00-21:00 Pakistan */
const MM_TOPIC = "genzura_moment";
function mmHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mmMomentAt(day) {
  const slots = Math.floor(MM_SPAN_MIN / MM_STEP_MIN);
  return Date.parse(day + "T00:00:00Z") + (MM_START_MIN + MM_STEP_MIN * (mmHash("genzura-moment-" + day) % slots)) * 60000;
}
async function mmRun(env) {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), t0 = mmMomentAt(day);
  if (now < t0 || now >= t0 + 4 * 60000) return { skipped: true };   /* only in the first 4 minutes after the daily time */
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return { error: "missing variables" };
  const pid = env.FIREBASE_PROJECT_ID.trim();
  const at = await anAccessToken(env);
  const A = { Authorization: "Bearer " + at, "Content-Type": "application/json" };
  const DOCS = "https://firestore.googleapis.com/v1/projects/" + pid + "/databases/(default)/documents";

  /* claim today's send: create fails with 409 if it was already done -> never sends twice */
  const lock = await fetch(DOCS + "/momentPush?documentId=" + day, { method: "POST", headers: A, body: JSON.stringify({ fields: { startedAt: { integerValue: String(now) } } }) });
  if (lock.status === 409) return { skipped: true, reason: "already sent" };
  if (!lock.ok) return { error: "lock failed " + lock.status };

  let page = "", total = 0, calls = 0, batch = [];
  const flush = async () => {
    if (!batch.length) return; calls++;
    await fetch("https://iid.googleapis.com/iid/v1:batchAdd", { method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json", access_token_auth: "true" },
      body: JSON.stringify({ to: "/topics/" + MM_TOPIC, registration_tokens: batch }) }).catch(() => {});
    batch = [];
  };
  do {
    const lr = await fetch(DOCS + "/fcmTokens?pageSize=300&mask.fieldPaths=uid" + (page ? "&pageToken=" + encodeURIComponent(page) : ""), { headers: A });
    const ld = await lr.json(); calls++;
    for (const d of (ld.documents || [])) { batch.push(decodeURIComponent(d.name.split("/").pop())); total++; if (batch.length >= 1000) await flush(); }
    page = ld.nextPageToken || "";
  } while (page && calls < 40);   /* free plan: max 50 requests per run */
  await flush();

  const mr = await fetch("https://fcm.googleapis.com/v1/projects/" + pid + "/messages:send", { method: "POST", headers: A, body: JSON.stringify({ message: {
    topic: MM_TOPIC,
    data: { title: "Gupzy Time! \u23F0", body: "Post what you are doing right now. You have 2 minutes.", tag: "n_moment", url: "./?moment=1" },
    webpush: { headers: { Urgency: "high", TTL: "300" } }, android: { priority: "HIGH", ttl: "300s" } } }) });
  return { day, tokens: total, sent: mr.ok, status: mr.status };
}

/* ================================================================
   CONTACTS + TRANSLATE  (ported from netlify/functions/contacts.js and translate.js)
     POST /contacts   {action: register | sync | clear | savedCount}
     POST /translate  {text, to: "ur" | "roman" | "en"}
   Both need  Authorization: Bearer <Firebase ID token>.
   Uses the SAME secrets as the rest of this worker (FIREBASE_*). Optional: CONTACTS_PEPPER (copy it from Netlify ONLY if it was set there).
   ================================================================ */
const CT_KEY_DEFAULT = "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w"; /* public web key, same as the other routes */
const CT_H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type", "Content-Type": "application/json" };
const ctJ = (code, o) => new Response(JSON.stringify(o), { status: code, headers: CT_H });
const ctHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const ctSha = async (s) => ctHex(await crypto.subtle.digest("SHA-256", anEnc.encode(s)));
const CT_MAX_HASHES = 5000;

/* same normalised PEM text the Netlify version used as fallback pepper (keeps old hashes valid) */
function ctPem(rawIn) {
  let raw = String(rawIn || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  raw = raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n")
    .replace(/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ").replace(/END\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ");
  const body64 = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  return body64.length > 800 ? "-----BEGIN PRIVATE KEY-----\n" + body64.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n" : "";
}

/* ---- translate ---- */
function ctParseGoogle(d) {
  const rows = Array.isArray(d) && Array.isArray(d[0]) ? d[0] : [];
  let text = "", roman = "";
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    if (typeof r[0] === "string") text += r[0];
    else if (r[0] === null && typeof r[3] === "string") roman += r[3];
  }
  return { text: text.trim(), roman: roman.trim() };
}
async function ctGoogle(text, tl) {
  const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + tl + "&dt=t&dt=rm&q=" + encodeURIComponent(text),
    { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("google " + r.status);
  return ctParseGoogle(await r.json());
}
async function ctMyMemory(text, tl) {
  const r = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text.slice(0, 450)) + "&langpair=autodetect|" + tl);
  if (!r.ok) throw new Error("mymemory " + r.status);
  const d = await r.json();
  const t = d && d.responseData && d.responseData.translatedText;
  if (!t) throw new Error("mymemory empty");
  return { text: String(t), roman: "" };
}
async function ctTranslate(body) {
  const text = String(body.text || "").trim().slice(0, 1500);
  if (!text) return ctJ(400, { error: "empty" });
  const tl = String(body.to || "ur") === "en" ? "en" : "ur";
  let res;
  try { res = await ctGoogle(text, tl); if (!res.text) throw new Error("empty"); }
  catch (e) { res = await ctMyMemory(text, tl); }
  return ctJ(200, { text: res.text, roman: res.roman });
}

/* ---- contacts ---- */
async function ctContacts(env, user, body) {
  const pid = String(env.FIREBASE_PROJECT_ID || "").trim(), email = String(env.FIREBASE_CLIENT_EMAIL || "").trim();
  const pk = ctPem(env.FIREBASE_PRIVATE_KEY);
  if (!pid || !email || !pk) return ctJ(500, { error: "missing env vars" });
  const pepper = env.CONTACTS_PEPPER || pk;
  const hk = await crypto.subtle.importKey("raw", anEnc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hmac = async (s) => ctHex(await crypto.subtle.sign("HMAC", hk, anEnc.encode(String(s))));

  const me = user.localId;
  const emailOk = !!(user.email && user.emailVerified);
  const phone = user.phoneNumber || ((user.providerUserInfo || []).find((p) => p.providerId === "phone") || {}).phoneNumber || "";
  const action = String(body.action || "");

  const at = await anAccessToken(env);
  const A = { Authorization: "Bearer " + at, "Content-Type": "application/json" };
  const ROOT = `projects/${pid}/databases/(default)/documents`;
  const DOCS = `https://firestore.googleapis.com/v1/${ROOT}`;
  const getDoc = async (p) => { const r = await fetch(`${DOCS}/${p}`, { headers: A }); return r.ok ? r.json() : null; };
  const setDoc = (p, fields) => fetch(`${DOCS}/${p}`, { method: "PATCH", headers: A, body: JSON.stringify({ fields }) });
  const commit = (writes) => fetch(`${DOCS}:commit`, { method: "POST", headers: A, body: JSON.stringify({ writes }) });
  const strArr = (a) => ({ arrayValue: { values: a.map((s) => ({ stringValue: s })) } });
  const query = async (sq) => {
    const r = await fetch(`${DOCS}:runQuery`, { method: "POST", headers: A, body: JSON.stringify({ structuredQuery: sq }) });
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).filter((x) => x.document).map((x) => x.document);
  };
  /* fewer sub-requests than one-by-one (Cloudflare free plan allows 50 per call) */
  const batchGet = async (coll, ids, field, size) => {
    const found = {};
    for (let i = 0; i < ids.length; i += size) {
      const r = await fetch(`${DOCS}:batchGet`, { method: "POST", headers: A, body: JSON.stringify({
        documents: ids.slice(i, i + size).map((x) => `${ROOT}/${coll}/${x}`), mask: { fieldPaths: field } }) });
      const rows = await r.json();
      for (const x of (Array.isArray(rows) ? rows : [])) if (x.found) found[x.found.name.split("/").pop()] = x.found.fields || {};
    }
    return found;
  };
  const myLinkDocs = () => query({ from: [{ collectionId: "contactLinks" }],
    where: { fieldFilter: { field: { fieldPath: "members" }, op: "ARRAY_CONTAINS", value: { stringValue: me } } }, limit: 1000 });

  const prev = await getDoc(`userPhone/${me}`);
  const prevIds = ((prev && prev.fields && prev.fields.ids && prev.fields.ids.arrayValue && prev.fields.ids.arrayValue.values) || []).map((v) => v.stringValue);

  async function clearMine() {
    const ws = prevIds.map((h) => ({ delete: `${ROOT}/phoneIndex/${h}` }));
    ws.push({ delete: `${ROOT}/userPhone/${me}` }, { delete: `${ROOT}/contactBooks/${me}` });
    for (const d of await myLinkDocs()) ws.push({ delete: d.name });
    for (let i = 0; i < ws.length; i += 400) await commit(ws.slice(i, i + 400));
  }

  if (action === "clear") { await clearMine(); return ctJ(200, { ok: true }); }

  if (action === "savedCount") {
    const opt = await getDoc(`savedCountOpt/${me}`);
    if (!(opt && opt.fields && opt.fields.on && opt.fields.on.booleanValue)) return ctJ(403, { error: "Turn this feature on first" });
    const ids = [];
    if (emailOk) ids.push(await hmac(await ctSha("mailto:" + user.email.trim().toLowerCase())));
    if (phone) ids.push(await hmac(await ctSha(phone)));
    if (!ids.length) return ctJ(400, { error: "Verify your phone number or Google e-mail first (Contacts sync)" });
    const who = new Set();
    for (const h of ids) {
      const docs = await query({ from: [{ collectionId: "contactBooks" }],
        where: { fieldFilter: { field: { fieldPath: "h" }, op: "ARRAY_CONTAINS", value: { stringValue: h } } },
        select: { fields: [{ fieldPath: "n" }] }, limit: 5000 });
      for (const d of docs) { const u = d.name.split("/").pop(); if (u !== me) who.add(u); }
    }
    return ctJ(200, { ok: true, count: who.size >= 3 ? who.size : null, few: who.size < 3 });
  }

  if (action === "register" || action === "sync") {
    const myIds = [];
    if (emailOk) myIds.push(await hmac(await ctSha("mailto:" + user.email.trim().toLowerCase())));
    if (phone) myIds.push(await hmac(await ctSha(phone)));
    if (!myIds.length) return ctJ(400, { error: "no verified e-mail or phone" });
    if (prevIds.some((h) => !myIds.includes(h))) await clearMine();
    const mine = [];
    for (const h of myIds) {
      const owner = await getDoc(`phoneIndex/${h}`);
      const ownerUid = owner && owner.fields && owner.fields.uid && owner.fields.uid.stringValue;
      if (ownerUid && ownerUid !== me) continue;
      await setDoc(`phoneIndex/${h}`, { uid: { stringValue: me } });
      mine.push(h);
    }
    if (!mine.length) return ctJ(409, { error: "identity already used by another account" });
    await setDoc(`userPhone/${me}`, { ids: strArr(mine) });
    if (action === "register") return ctJ(200, { ok: true });

    const hashes = [...new Set((Array.isArray(body.hashes) ? body.hashes : [])
      .map((h) => String(h).toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)))].slice(0, CT_MAX_HASHES);
    const book = await Promise.all(hashes.map(hmac));
    await setDoc(`contactBooks/${me}`, { h: strArr(book), n: { integerValue: String(book.length) } });

    /* which of my contacts are Genzura users? */
    const idx = await batchGet("phoneIndex", book, ["uid"], 300);
    const matches = {};
    for (const k in idx) { const u = idx[k].uid && idx[k].uid.stringValue; if (u && u !== me) matches[u] = true; }
    const uids = Object.keys(matches).slice(0, 500);

    /* mutual = MY id is inside THEIR contact book */
    const books = await batchGet("contactBooks", uids, ["h"], 50);
    const chans = await batchGet("channels", uids, ["name", "logoURL"], 300);
    const people = [], writes = [];
    for (const u of uids) {
      const list = (books[u] && books[u].h && books[u].h.arrayValue && books[u].h.arrayValue.values) || [];
      const mutual = list.some((v) => mine.includes(v.stringValue));
      const f = chans[u] || {};
      people.push({ id: u, name: (f.name && f.name.stringValue) || "Genzura user", logo: (f.logoURL && f.logoURL.stringValue) || null, mutual });
      if (mutual) {
        const id = [me, u].sort().join("_");
        writes.push({ update: { name: `${ROOT}/contactLinks/${id}`, fields: { members: strArr([me, u].sort()), at: { timestampValue: new Date().toISOString() } } } });
      }
    }
    for (let i = 0; i < writes.length; i += 400) await commit(writes.slice(i, i + 400));

    /* remove links to people who are no longer mutual contacts */
    const keep = new Set(people.filter((p) => p.mutual).map((p) => p.id));
    const dels = [];
    for (const d of await myLinkDocs()) {
      const id = d.name.split("/").pop();
      const other = id.split("_").find((x) => x !== me);
      if (!keep.has(other)) dels.push({ delete: d.name });
    }
    for (let i = 0; i < dels.length; i += 400) await commit(dels.slice(i, i + 400));
    return ctJ(200, { ok: true, contacts: book.length, people });
  }
  return ctJ(400, { error: "bad action" });
}

async function ctHandle(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CT_H });
  if (request.method !== "POST") return ctJ(405, { error: "POST only" });
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  try {
    const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer /i, "").trim();
    if (!idToken) return ctJ(401, { error: "no token" });
    const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + (env.FIREBASE_API_KEY || CT_KEY_DEFAULT).trim(),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
    const ld = await lr.json();
    const user = ld.users && ld.users[0];
    if (!user || !user.localId) return ctJ(401, { error: "bad token" });
    const body = await request.json().catch(() => ({}));
    if (path === "/translate") return await ctTranslate(body);
    return await ctContacts(env, user, body);
  } catch (e) {
    return ctJ(500, { error: String((e && e.message) || e) });
  }
}

export default {
  async fetch(request, env, ctx) {
    const p = new URL(request.url).pathname.replace(/\/+$/, "");
    if (p === "/anon-send") return anHandle(request, env); /* handles its own OPTIONS preflight */
    if (request.method === "POST" && p === "/ring-ack") return rkHandle(request, env);
    if (request.method === "GET" && p === "/sitemap-videos.xml") return smHandle(request, env, ctx);
    if (p === "/contacts" || p === "/translate") return ctHandle(request, env); /* handles its own OPTIONS preflight */
    if (p === "/view") return VIEWS.fetch(request, env, ctx);
    return API.fetch(request, env, ctx);
  },
  /* Cron Trigger -> Real Moments daily push */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(mmRun(env).then((r) => console.log(JSON.stringify(r))).catch((e) => console.log("moment-push error", String((e && e.message) || e))));
  },
};

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
  groupcall: "started a group call \uD83D\uDCDE",
  gcmessage: "sent you a message",   // Gupchats app (separate app, separate FCM tokens: app == "gc")
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
  let groupName = "";   /* set when the chat is a group: the notification then shows the group name and opens the group */
  if (kind === "message") {
    const cid = String(body.chatId || "").replace(/[^A-Za-z0-9_\-]/g, "");
    const cd = await (await fetch(`${DOCS}/chats/${cid}`, { headers: A })).json();
    const members = ((cd.fields && cd.fields.members && cd.fields.members.arrayValue.values) || []).map((v) => v.stringValue);
    if (!members.includes(from)) return out(env, 403, { error: "not a member" });
    if (cd.fields && cd.fields.isGroup && cd.fields.isGroup.booleanValue === true) groupName = (cd.fields.name && cd.fields.name.stringValue) || "Group";
    const mf = (cd.fields && cd.fields.mute && cd.fields.mute.mapValue && cd.fields.mute.mapValue.fields) || {};
    targets = members.filter((x) => x !== from && !(mf[x] && mf[x].booleanValue === true));
  } else if (kind === "gcmessage" || kind === "groupcall") {
    /* Gupchats now shares the Gupzy inbox (collection "chats"), so this reads the same chat doc as kind "message" */
    const cid = String(body.chatId || "").replace(/[^A-Za-z0-9_\-]/g, "");
    const cd = await (await fetch(`${DOCS}/chats/${cid}`, { headers: A })).json();
    const members = ((cd.fields && cd.fields.members && cd.fields.members.arrayValue && cd.fields.members.arrayValue.values) || []).map((v) => v.stringValue);
    if (!members.includes(from)) return out(env, 403, { error: "not a member" });
    if (cd.fields && cd.fields.isGroup && cd.fields.isGroup.booleanValue === true) groupName = (cd.fields.name && cd.fields.name.stringValue) || "Group";
    const mf2 = (cd.fields && cd.fields.mute && cd.fields.mute.mapValue && cd.fields.mute.mapValue.fields) || {};
    targets = members.filter((x) => x !== from && !(mf2[x] && mf2[x].booleanValue === true));
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

  /* one query per 30 people (not one per person): a 30-member group used to need 60+ sub-requests and failed on the free plan */
  const tl = targets.slice(0, 50);
  const byUid = {};
  let used = 5;                                   /* token check + chat doc + name + token exchange + spare */
  const CAP = Number(env.SUBREQ_CAP) || 48;       /* free plan 50; set SUBREQ_CAP higher on a paid plan */
  for (let i = 0; i < tl.length; i += 30) {
    used++;
    const rr = await (await fetch(`${DOCS}:runQuery`, { method: "POST", headers: A, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "fcmTokens" }],
      where: { fieldFilter: { field: { fieldPath: "uid" }, op: "IN", value: { arrayValue: { values: tl.slice(i, i + 30).map((x) => ({ stringValue: x })) } } } },
      limit: 300 } }) })).json();
    for (const r of (Array.isArray(rr) ? rr : [])) {
      if (!r.document) continue;
      const tu = r.document.fields && r.document.fields.uid && r.document.fields.uid.stringValue;
      if (tu) (byUid[tu] = byUid[tu] || []).push(r);
    }
  }
  let sent = 0;
  for (const uid of tl) {
    const rows = (byUid[uid] || []).slice(0, 10);
    /* chat messages (from Gupzy OR Gupchats) go to every phone of the person (Gupzy + Gupchats); all other pushes stay on Gupzy phones only */
    const isGc = kind === "gcmessage" || kind === "groupcall";
    /* CALLS now also reach Gupchats phones (tokens with app == "gc"); each token carries its own app flag so Gupchats rings only in Gupchats and Gupzy only in Gupzy */
    const tokenRows = (Array.isArray(rows) ? rows : []).filter((r) => r.document)
      .filter((r) => { const f = r.document.fields || {}; const a = f.app && f.app.stringValue; return (kind === "message" || kind === "gcmessage" || kind === "groupcall" || kind === "call") ? true : a !== "gc"; })
      .map((r) => { const f = r.document.fields || {}; return { token: r.document.name.split("/").pop(), app: (f.app && f.app.stringValue) || "" }; });
    /* chats + calls: a person who has Gupchats installed (token app == "gc") gets them ONLY in Gupchats, never in Gupzy.
       Gupzy phones are used only as a fallback when every Gupchats token turned out dead (uninstalled). Likes / follows etc. stay on Gupzy. */
    const chatKind = (kind === "message" || kind === "gcmessage" || kind === "groupcall" || kind === "call");
    const gcRows = tokenRows.filter((t) => t.app === "gc"), restRows = tokenRows.filter((t) => t.app !== "gc");
    const stages = (chatKind && gcRows.length) ? [gcRows, restRows] : [tokenRows];
    for (let si = 0; si < stages.length; si++) {
    let okCount = 0;
    for (const tr of stages[si]) {
      if (used >= CAP) break;                     /* never cross the sub-request limit: a clean partial send beats a crash */
      used++;
      const token = tr.token;
      /* a CALL push must expire after 45 s: a phone that comes online later must NOT ring for an old call */
      const isCall = kind === "call";
      const mr = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, { method: "POST", headers: A,
        body: JSON.stringify({ message: { token, data: { title: groupName || name, fromUid: String(from || ""),
          body: kind === "groupcall" ? (name + " started a group call \uD83D\uDCDE") : groupName ? (name + " sent a message") : (TEXT[kind] + (kind === "call" ? (body.type === "video" ? " (video)" : " (voice)") : "")),
          gid: groupName ? String(body.chatId || "").replace(/[^A-Za-z0-9_\-]/g, "") : "",
          tag: (kind === "message" || kind === "gcmessage") ? "c_" + (body.chatId || "") : kind === "groupcall" ? "c_gcall_" + (body.chatId || "") : "n_" + kind,
          app: chatKind ? (tr.app === "gc" ? "gc" : "gupzy") : "gupzy",
          callId: kind === "call" ? String(body.callId || "").replace(/[^A-Za-z0-9]/g, "") : "" },
          webpush: { headers: { Urgency: "high", TTL: isCall ? "45" : "86400" } }, android: { priority: "HIGH", ttl: isCall ? "45s" : "86400s" } } }) });
      if (mr.ok) { sent++; okCount++; }
      else if (mr.status === 404 || mr.status === 400) {
        if (used < CAP) { used++; await fetch(`${DOCS}/fcmTokens/${encodeURIComponent(token)}`, { method: "DELETE", headers: A }).catch(() => {}); }
      }
    }
    if (okCount) break;
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
   - the message is written by the server (Firestore rules do NOT let the client create it)
   - cooldown on the SERVER:
       one IP -> one creator: 1 message per 30 seconds
       one IP: 20 messages per hour (all creators combined)
       one creator: 100 anonymous messages per hour
   - creator ke phone par generic push: "You got a new anonymous message" (the text is not in the push)
   The sender's identity is NOT saved in the message. For rate limiting only a salted hash of the IP
   is kept in the anonRate/ collection for 1-2 hours (set a TTL policy on expireAt).
   Body: { "toUid": "<creator uid>", "text": "..." }
   Optional variable: ANON_SALT (long random text; if not set, the client email is used)
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
async function ctGoogle2(text, tl) {
  const r = await fetch("https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=" + tl + "&q=" + encodeURIComponent(text),
    { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("google2 " + r.status);
  const d = await r.json();
  const first = Array.isArray(d) ? d[0] : null;
  const t = Array.isArray(first) ? first[0] : (typeof first === "string" ? first : "");
  return { text: String(t || "").trim(), roman: "" };
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
  let res = null;
  try { res = await ctGoogle(text, tl); if (!res.text) throw new Error("empty"); }
  catch (e) {
    res = null;
    try { res = await ctGoogle2(text, tl); if (!res.text) throw new Error("empty"); } catch (e2) { res = null; }
    if (!res) { try { res = await ctMyMemory(text, tl); } catch (e3) { res = null; } }
  }
  if (!res) res = { text, roman: "" }; /* every provider failed: show the original instead of an error */
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
    const origOf = {}; hashes.forEach((h, i) => { origOf[book[i]] = h; });   /* each match echoes back the caller's OWN hash, so the phone can find the saved name locally */
    await setDoc(`contactBooks/${me}`, { h: strArr(book), n: { integerValue: String(book.length) } });

    /* which of my contacts are Genzura users? */
    const idx = await batchGet("phoneIndex", book, ["uid"], 300);
    const matches = {};
    for (const k in idx) { const u = idx[k].uid && idx[k].uid.stringValue; if (u && u !== me) (matches[u] = matches[u] || []).push(origOf[k]); }
    const uids = Object.keys(matches).slice(0, 500);

    /* mutual = MY id is inside THEIR contact book */
    const books = await batchGet("contactBooks", uids, ["h"], 50);
    const chans = await batchGet("channels", uids, ["name", "logoURL"], 300);
    const people = [], writes = [];
    for (const u of uids) {
      const list = (books[u] && books[u].h && books[u].h.arrayValue && books[u].h.arrayValue.values) || [];
      const mutual = list.some((v) => mine.includes(v.stringValue));
      const f = chans[u] || {};
      people.push({ id: u, name: (f.name && f.name.stringValue) || "Gupzy user", logo: (f.logoURL && f.logoURL.stringValue) || null, mutual, h: mutual ? (matches[u] || []).filter(Boolean).slice(0, 5) : [] });
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

/* ---- Gupzy AI assistant (Groq). The Groq key lives ONLY in the worker secret GROQ_API_KEY, never in the app. ---- */
const AI_RL = new Map();
const AI_FACTS = [
  "GUPZY FACTS (this is the ONLY source for Gupzy details; if something is not listed here, say you are not sure and suggest emailing support).",
  "BASICS: Gupzy (earlier called Arain Tube / Genzura) is a video and social app on the web (gupzy.com) and on Android. Creators have a channel and upload reels, long videos, photos/posts and stories. Gupzy Studio (studio.gupzy.com, also an Android app) is the creator dashboard: analytics, earnings, withdrawals. The Google Play listing is 'coming soon'. Go Live (live streaming) is 'coming soon' and is NOT available yet.",
  "SUPPORT: email gupzysupport@gmail.com for account problems, bug reports, feedback, privacy requests, account deletion without the app (subject 'Delete my Gupzy account', done within 30 days), paid video promotion, copyright complaints and reports. A good email has: the account email or username, a clear description (screenshot if possible), and the link to the video/reel/profile. Pages: gupzy.com About, Contact, Privacy Policy, Terms, Copyright & Reporting, delete-account.html.",
  "RULES AND SAFETY: minimum age 16. New videos and posts are reviewed by the team before they go public. Not allowed: illegal, hateful, threatening or harassing content, sexual content involving minors or any explicit sexual content, copyright/privacy violations, spam, scams, fake engagement, impersonation, hacking. Users can report videos, posts, stories, local posts and users, and can block people. Reports are acted on within about 48 hours (faster for serious content). A suspended channel can send one appeal inside the app; the decision on it is final. Repeat copyright offenders can be suspended. Delete account inside the app: Profile menu > Delete my account (deletes channel, content, follows, notification tokens and chat keys right away).",
  "CONTENT: reels, long videos, photo posts, comments, likes, follow/subscribe, saved items, share links (WhatsApp, Telegram, etc.). Stories last 24 hours (photo or video up to 30 seconds and 50 MB) and are seen by friends. Video uploads up to 100 MB (larger needs compression). One-tap Translate under captions and comments (Urdu, Roman Urdu, English). Boost: before uploading a reel you can watch one short ad and the reel is pushed to the top of Reels for 5 minutes. Paid promotion of a video for a limited time is arranged by email with support. No-Algorithm mode (switch on Home): only people you follow, newest first, no promoted reels. Shared Albums: friends build one album together with photos and short videos.",
  "CHATS AND CALLS: 1-to-1 chats and group chats (up to 50 members, group admin can rename, change photo, add and remove members). Text, photos, voice messages, videos. Voice and video calls are 1-to-1 only, and only with people you follow mutually or mutual phone contacts. Screen sharing in calls works on desktop browsers only for now. Disappearing messages per chat: off, 1 hour, 24 hours, 7 days. Mood status and Do-not-disturb (quiet hours; Close Friends can still reach you). Gupchats is a separate Android chat app that uses the SAME chats as Gupzy (messages, groups, calls, stories); the other person does not need it; it uses the same chat-backup password; sharing posts/reels, story replies and reactions are only in Gupzy.",
  "FRIEND FEATURES (friends = mutual follow or phone-contact link): Real Moments: once a day at a random time between 10:00 and 21:00 Pakistan time everybody gets a notification, you have 2 minutes to post a live back-camera + front-camera photo (late posts are tagged Late), and you see friends' moments after you post yours. Near Me (pin icon on Home): posts and events (concert, match, food, other) within 5 or 10 km on a list or map; posts show only a rough ~1 km area and expire after 24 hours; location is asked only when you open it. Vibe status: a 2-hour mood like Bored, Down for Chai, Gaming; friends' vibes float at the top of Messages; when you and 2 friends share a vibe a temporary group is created (you can opt out). My Aura: colors, traits and a 3D-style avatar made from your own activity on your phone, it is rule-based and not a cloud AI model; friends' avatars react to their mood; you can hide your avatar. Ghost Meter: shows how fast you reply in 1-to-1 chats (only reply timing is measured, never message text); needs 8+ replies; badges Super Responder or Certified Ghost; can be switched off. Crush Vote: you turn it on yourself, friends secretly vote Secret Crush or Legend, you only see totals; if two people vote Secret Crush on each other a small Spark shows. Who saved me: shows ONE number of people who saved your number (hidden if fewer than 3), never names. Side Quest: one real-world local quest per day, record a 5-second clip, +10 points plus a streak bonus, safety rules apply. Co-Reel / Watch Party: up to 4 friends watch the same reels together with optional voice chat. Truth-Dare-Roast Spin: friends join one voice call (max 6) and spin a wheel of tasks. Soundbite Maker: mix voice clips with beats and effects and share a link. Daku Ledger in group chats: 'I'm coming in N min' with Busted button, Udhaar (money/chai owed) and a leaderboard. Contacts sync is optional; phone numbers are hashed before upload, names never leave your phone, and you can stop any time.",
  "MONETIZATION: creators earn from ad revenue. Ads run in the Android app (Google AdMob). Monthly ad revenue is shared between monetized channels by their share of views, country by country: views from higher-paying countries earn more, views via VPN/proxy are paid at the lowest rate. The creator gets 70% of their share, the platform 30%. Eligibility within the last 7 days: upload 7 reels, get 7 followers, watch 1000 reels (a reel counts after 3+ seconds), refer 5 new channels. When all four are done the channel is monetized automatically (the Earn page is inside Gupzy Studio). Withdraw from $2. Payment methods: JazzCash, EasyPaisa or bank in Pakistan, Payoneer for international. The first withdrawal asks a one-time form (phone, address, ID number and photo, payment details). Never promise a specific amount of earnings. Creator Tip Jar: a creator can add an EasyPaisa/JazzCash number and fans tip wallet-to-wallet; Gupzy does not process that money. Gupzy does not store payment card information in the app.",
  "ENCRYPTION (be accurate): 1-to-1 chats and group chats are end-to-end encrypted. Each device makes its own key pair, the private key never leaves the device, and the server stores only encrypted text. Photos, voice messages and videos are encrypted on the phone before upload. Notification text for chats is generic. Chat backup: Menu > Chat backup, protected by a backup password; on a new phone or after reinstall use Restore chat backup with the same password. If the password is forgotten the old messages cannot be recovered by anyone, including Gupzy. If a friend reinstalls without a backup, old messages with them can become unreadable. NOT end-to-end encrypted: voice/video calls (the media is encrypted in transit, but this is not E2EE), chats with Gupzy AI (sent through the Gupzy server to the AI provider Groq; history is kept only on the user's own device and can be cleared with the bin icon), posts, comments, stories and other public content, and translation (the text is sent to a translation provider).",
  "HOW TO ANSWER ABOUT GUPZY: use only the facts above, keep the answer short and practical, mention the menu path when you know it, and for billing, account, safety or legal problems give the support email gupzysupport@gmail.com. Never promise future features or dates."
].join("\n");
const AI_SYSTEM = [
  "You are Gupzy AI, the friendly assistant inside Gupzy (gupzy.com), a social video app with reels, posts, stories, chats, calls and live streaming.",
  "Reply in the same language and style as the user: Roman Urdu, Urdu, Hindi or English. Keep answers short, warm and clear (a few sentences).",
  "You know about Gupzy: creators make a channel and upload reels, long videos and posts; every new video and post is reviewed before it goes public; there are report and block buttons; the minimum age is 16; accounts can be deleted inside the app.",
  "If something about Gupzy is not in the GUPZY FACTS below, say you are not sure and suggest gupzysupport@gmail.com. Never invent features, prices or policies.",
  "You are an AI, never claim to be a human. Never ask for passwords, OTP codes or card numbers.",
  "Do not write sexual content, hate speech, content that attacks a religion, or help with violence, hacking or illegal activity. Refuse politely and offer something safe instead.",
  "For medical, legal or money questions give general information only and suggest a qualified professional."
].join(" ") + "\n\n" + AI_FACTS;
async function aiChat(env, user, body) {
  const key = String(env.GROQ_API_KEY || "").trim();
  if (!key) return ctJ(503, { error: "Gupzy AI is not switched on yet" });
  const now = Date.now(), me = user.localId;
  const hits = (AI_RL.get(me) || []).filter((t) => now - t < 600000);
  if (hits.length >= 30) return ctJ(429, { error: "Too many messages. Please wait a few minutes" });
  hits.push(now); AI_RL.set(me, hits);
  if (AI_RL.size > 5000) AI_RL.clear();
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .map((m) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, 1500) }))
    .filter((m) => m.content.trim());
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return ctJ(400, { error: "empty message" });
  const models = [String(env.GROQ_MODEL || "llama-3.3-70b-versatile").trim(), "llama-3.1-8b-instant", "openai/gpt-oss-20b", "openai/gpt-oss-120b"].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr = "", sawBusy = false, reply = "";
  for (const model of models) {
    const oss = /gpt-oss/i.test(model);   /* reasoning models: keep thinking short and leave room for the real answer */
    const payload = { model, messages: [{ role: "system", content: AI_SYSTEM }].concat(msgs), temperature: 0.6, max_tokens: oss ? 1200 : 500 };
    if (oss) payload.reasoning_effort = "low";
    let r, d = {};
    try {
      r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(payload),
      });
    } catch (e) { lastErr = "network [" + model + "]: " + String((e && e.message) || e).slice(0, 80); continue; }
    d = await r.json().catch(() => ({}));
    if (r.ok) {
      const t = String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (t) { reply = t; break; }
      lastErr = "empty reply [" + model + "]";   /* 200 but no text -> try the next model */
      continue;
    }
    lastErr = "Groq " + r.status + " [" + model + "]: " + String((d && d.error && d.error.message) || "").slice(0, 110);
    if (r.status === 429) sawBusy = true;
    if (r.status === 401 || r.status === 403) break;
  }
  if (!reply) {
    console.log("gupzy-ai failed: " + lastErr);   /* details stay in the worker logs, not in the app */
    if (sawBusy) return ctJ(429, { error: "Gupzy AI is very busy right now. Please try again in a minute" });
    return ctJ(502, { error: "Gupzy AI is not available right now. Please try again in a moment" });
  }
  return ctJ(200, { reply });
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
    if (path === "/ai") return await aiChat(env, user, body);
    if (path === "/translate") return await ctTranslate(body);
    return await ctContacts(env, user, body);
  } catch (e) {
    return ctJ(500, { error: String((e && e.message) || e) });
  }
}

/* ---- Google Play Billing: verify a purchase and grant Blue Tick / Premium (POST /play-verify) ----
   Body: { idToken, productId, purchaseToken }.  Products: gupzy_bluetick_1m, gupzy_premium_{1|3|6|12}m.
   Needs: the service account (FIREBASE_* or optional PLAY_CLIENT_EMAIL + PLAY_PRIVATE_KEY) added in Play Console >
   Users and permissions with "View financial data" + "Manage orders and subscriptions", and Google Play Android Developer API enabled.
   Optional env: PLAY_PACKAGE (default com.gupzy.app). Each purchaseToken can be used once (playPurchases/{hash}). */
async function pvToken(env, scope) {
  const email = String(env.PLAY_CLIENT_EMAIL || env.FIREBASE_CLIENT_EMAIL || "").trim();
  const pk = env.PLAY_PRIVATE_KEY || env.FIREBASE_PRIVATE_KEY;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = anB64u(anEnc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." +
    anB64u(anEnc.encode(JSON.stringify({ iss: email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const key = await crypto.subtle.importKey("pkcs8", anPemToDer(pk), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, anEnc.encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(unsigned + "." + anB64u(sig)) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("Google Play token exchange failed");
  return d.access_token;
}
const PV_DAY = 86400000;
function pvProduct(id) {
  id = String(id || "");
  if (id === "gupzy_bluetick_1m") return { kind: "blue", field: "blueUntil", days: 30 };
  const m = /^gupzy_premium_(1|3|6|12)m$/.exec(id);
  if (m) return { kind: "premium", field: "premiumUntil", days: 30 * Number(m[1]) };
  return null;
}
async function pvHandle(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CT_H });
  if (request.method !== "POST") return ctJ(405, { error: "POST only" });
  try {
    const pid = String(env.FIREBASE_PROJECT_ID || "").trim();
    if (!pid || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return ctJ(500, { error: "missing env vars" });
    const body = await request.json().catch(() => ({}));
    const idToken = String(body.idToken || (request.headers.get("Authorization") || "").replace(/^Bearer /i, "")).trim();
    const productId = String(body.productId || ""), token = String(body.purchaseToken || "").trim();
    const prod = pvProduct(productId);
    if (!idToken) return ctJ(401, { error: "Please sign in first" });
    if (!prod || token.length < 20 || token.length > 2000) return ctJ(400, { error: "bad purchase" });
    const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + (env.FIREBASE_API_KEY || CT_KEY_DEFAULT).trim(),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
    const ld = await lr.json().catch(() => ({}));
    const user = ld.users && ld.users[0];
    if (!user || !user.localId) return ctJ(401, { error: "Please sign in again" });
    const me = user.localId;

    /* 1) ask Google Play if this purchase is real and paid */
    const pkg = String(env.PLAY_PACKAGE || "com.gupzy.app").trim();
    const PT = await pvToken(env, "https://www.googleapis.com/auth/androidpublisher");
    const PH = { Authorization: "Bearer " + PT, "Content-Type": "application/json" };
    const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + pkg;
    const tk = encodeURIComponent(token);
    let until = 0, needAck = false, ackUrl = "", acct = "";
    let r = await fetch(`${API}/purchases/products/${encodeURIComponent(productId)}/tokens/${tk}`, { headers: PH });
    if (r.ok) {                                   /* one-time product */
      const p = await r.json();
      if (p.purchaseState === 2) return ctJ(402, { error: "Payment is pending. Premium starts when it is completed." });
      if (p.purchaseState !== 0) return ctJ(402, { error: "This purchase was cancelled or refunded." });
      acct = p.obfuscatedExternalAccountId || "";
      needAck = p.acknowledgementState === 0;
      ackUrl = `${API}/purchases/products/${encodeURIComponent(productId)}/tokens/${tk}:acknowledge`;
    } else {                                      /* subscription */
      r = await fetch(`${API}/purchases/subscriptionsv2/tokens/${tk}`, { headers: PH });
      if (!r.ok) {
        console.log("play-verify google " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
        return ctJ(r.status === 401 || r.status === 403 ? 502 : 400, { error: r.status === 401 || r.status === 403 ? "Payment check is not set up yet. Please contact support." : "Purchase not found." });
      }
      const s = await r.json();
      const li = (s.lineItems || []).find((x) => x.productId === productId) || (s.lineItems || [])[0];
      const exp = li && li.expiryTime ? Date.parse(li.expiryTime) : 0;
      if (!li || li.productId !== productId) return ctJ(400, { error: "Purchase does not match the product." });
      if (!(exp > Date.now())) return ctJ(402, { error: "This subscription is not active." });
      until = exp;
      acct = (s.externalAccountIdentifiers && s.externalAccountIdentifiers.obfuscatedExternalAccountId) || "";
      needAck = s.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING";
      ackUrl = `${API}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${tk}:acknowledge`;
    }
    if (acct && acct !== me) return ctJ(403, { error: "This purchase belongs to another account." });

    /* 2) one purchase token = one grant */
    const at = await anAccessToken(env);
    const A = { Authorization: "Bearer " + at, "Content-Type": "application/json" };
    const DOCS = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
    const dh = await anHash(token);
    const num = (f, k) => Number(f && f[k] && (f[k].integerValue || f[k].doubleValue) || 0);
    const rd = await fetch(`${DOCS}/playPurchases/${dh}`, { headers: A });
    let granted = false;
    if (rd.ok) {
      const f = (await rd.json()).fields || {};
      if ((f.uid && f.uid.stringValue) !== me) return ctJ(409, { error: "This purchase was already used on another account." });
      granted = !!(f.granted && f.granted.booleanValue);
    } else {
      const cr = await fetch(`${DOCS}/playPurchases/${dh}?currentDocument.exists=false`, { method: "PATCH", headers: A, body: JSON.stringify({ fields: {
        uid: { stringValue: me }, productId: { stringValue: productId }, granted: { booleanValue: false }, at: { integerValue: String(Date.now()) } } }) });
      if (!cr.ok && cr.status !== 409 && cr.status !== 400) return ctJ(500, { error: "Could not save the purchase. Please retry." });
    }

    /* 3) grant (adds on top of the remaining time; subscriptions use Google's expiry time) */
    const cd = await fetch(`${DOCS}/channels/${me}`, { headers: A });
    if (!cd.ok) return ctJ(404, { error: "Create your channel first, then restore the purchase." });
    const cf = (await cd.json()).fields || {};
    const cur = num(cf, prod.field);
    if (!granted) {
      const now = Date.now();
      const next = until ? Math.max(cur, until) : Math.max(cur, now) + prod.days * PV_DAY;
      const pr = await fetch(`${DOCS}/channels/${me}?updateMask.fieldPaths=${prod.field}`, { method: "PATCH", headers: A,
        body: JSON.stringify({ fields: { [prod.field]: { integerValue: String(next) } } }) });
      if (!pr.ok) return ctJ(500, { error: "Could not activate. It will be retried automatically." });
      await fetch(`${DOCS}/playPurchases/${dh}?updateMask.fieldPaths=granted&updateMask.fieldPaths=until`, { method: "PATCH", headers: A,
        body: JSON.stringify({ fields: { granted: { booleanValue: true }, until: { integerValue: String(next) } } }) });
      if (needAck) await fetch(ackUrl, { method: "POST", headers: PH, body: "{}" }).catch(() => {});   /* Play refunds unacknowledged purchases after 3 days */
      return ctJ(200, { ok: true, kind: prod.kind, [prod.field]: next });
    }
    return ctJ(200, { ok: true, kind: prod.kind, [prod.field]: cur });
  } catch (e) {
    return ctJ(500, { error: String((e && e.message) || e) });
  }
}

const BASE_HANDLER = {
  async fetch(request, env, ctx) {
    const p = new URL(request.url).pathname.replace(/\/+$/, "");
    if (p === "/anon-send") return new Response(JSON.stringify({error:"disabled"}), {status:410, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}}); /* anonymous inbox removed */
    if (request.method === "POST" && p === "/ring-ack") return rkHandle(request, env);
    if (request.method === "GET" && p === "/sitemap-videos.xml") return smHandle(request, env, ctx);
    if (p === "/play-verify") return pvHandle(request, env); /* handles its own OPTIONS preflight */
    if (p === "/contacts" || p === "/translate" || p === "/ai") return ctHandle(request, env); /* handles its own OPTIONS preflight */
    if (p === "/view") return VIEWS.fetch(request, env, ctx);
    return API.fetch(request, env, ctx);
  },
  /* Cron Trigger -> Real Moments daily push */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(mmRun(env).then((r) => console.log(JSON.stringify(r))).catch((e) => console.log("moment-push error", String((e && e.message) || e))));
  },
};

/* ================================================================
   FREEZE SWITCH  (Admin Panel -> Freeze)
   While settings/appFreeze.on == true: every route of this worker (push, turn, view, ring-ack, contacts,
   translate, ai, play-verify) answers 503 "paused" and the daily Real Moments cron sends nothing.
   Only the admin's own requests (Firebase login token of the admin) still work. The video sitemap stays public.
   The state is cached for 15 seconds inside the worker; if Firestore cannot be read, the last known state is kept.
   ================================================================ */
const FZ_ADMIN_UID = "zLq96Q4K6iNJoUHDxrE0GwBL1vk1";
const FZ_WEB_KEY = "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w";
let FZ = { on: false, at: 0 };
let FZ_TOK = { v: "", exp: 0 };
async function fzToken(env) {
  if (FZ_TOK.v && Date.now() < FZ_TOK.exp) return FZ_TOK.v;
  const t = await anAccessToken(env);
  FZ_TOK = { v: t, exp: Date.now() + 50 * 60 * 1000 };
  return t;
}
async function fzFrozen(env) {
  const now = Date.now();
  if (now - FZ.at < 15000) return FZ.on;
  try {
    const pid = String(env.FIREBASE_PROJECT_ID || "").trim();
    if (!pid) return FZ.on;
    const at = await fzToken(env);
    const r = await fetch("https://firestore.googleapis.com/v1/projects/" + pid + "/databases/(default)/documents/settings/appFreeze",
      { headers: { Authorization: "Bearer " + at } });
    if (r.status === 404) { FZ = { on: false, at: now }; return false; }
    if (r.ok) {
      const d = await r.json();
      FZ = { on: !!(d.fields && d.fields.on && d.fields.on.booleanValue === true), at: now };
      return FZ.on;
    }
  } catch (e) { /* keep the last known state */ }
  return FZ.on;
}
async function fzIsAdmin(request, env) {
  try {
    const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer /i, "").trim();
    if (!idToken) return false;
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + String(env.FIREBASE_API_KEY || FZ_WEB_KEY).trim(),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
    const d = await r.json();
    return !!(d.users && d.users[0] && d.users[0].localId === FZ_ADMIN_UID);
  } catch (e) { return false; }
}

export default {
  async fetch(request, env, ctx) {
    const p = new URL(request.url).pathname.replace(/\/+$/, "");
    if (request.method !== "OPTIONS" && p !== "/sitemap-videos.xml" && (await fzFrozen(env))) {
      if (!(await fzIsAdmin(request, env))) {
        return new Response(JSON.stringify({ ok: false, frozen: true, error: "The app is temporarily paused. Please try again later." }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" },
        });
      }
    }
    return BASE_HANDLER.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    if (await fzFrozen(env)) return;   /* frozen: no daily push */
    return BASE_HANDLER.scheduled(event, env, ctx);
  },
};

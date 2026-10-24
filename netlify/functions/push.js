/* ================================================================
   GENZURA — Push notifications via Netlify (FREE, no Firebase Blaze).
   No npm packages needed. Uses the SAME 3 env variables as the sitemap function:
     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
   The app calls this after sending a message / like / call etc.
   Security: caller must send a valid Firebase ID token. The server decides the
   notification text itself (generic, no message content -> works with E2EE).
================================================================ */
const crypto = require("crypto");
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w";
const b64u = (i) => Buffer.from(i).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function accessToken(email, key) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const c = b64u(JSON.stringify({iss: email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600}));
  const sig = b64u(crypto.sign("RSA-SHA256", Buffer.from(h + "." + c), key));
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(h + "." + c + "." + sig)});
  const d = await r.json();
  if (!d.access_token) throw new Error("token exchange failed");
  return d.access_token;
}

const TEXT = {
  message: "sent you a message", call: "is calling you", like: "liked your post", comment: "commented on your post",
  follow: "started following you", reelLike: "liked your reel", reelComment: "commented on your reel",
  mention: "mentioned you", reply: "replied to your comment", commentLike: "liked your comment", tag: "tagged you in a post",
  game: "invited you to play Truth · Dare · Roast 🎲",
};

exports.handler = async (event) => {
  const H = {"Content-Type": "application/json"};
  const out = (code, o) => ({statusCode: code, headers: H, body: JSON.stringify(o)});
  try {
    if (event.httpMethod !== "POST") return out(405, {error: "POST only"});
    const pid = process.env.FIREBASE_PROJECT_ID, email = process.env.FIREBASE_CLIENT_EMAIL;
    let raw = (process.env.FIREBASE_PRIVATE_KEY || "").trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    raw = raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n")
        .replace(/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ").replace(/END\s+(RSA\s+)?PRIVATE\s+KEY/gi, " ");
    const body64 = raw.replace(/[^A-Za-z0-9+/=]/g, "");
    const pk = body64.length > 800 ? "-----BEGIN PRIVATE KEY-----\n" + body64.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n" : "";
    if (!pid || !email || !pk) return out(500, {error: "missing env vars"});

    const idToken = ((event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "")).trim();
    if (!idToken) return out(401, {error: "no token"});
    const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + API_KEY, {method: "POST",
      headers: H, body: JSON.stringify({idToken})});
    const ld = await lr.json();
    const from = ld.users && ld.users[0] && ld.users[0].localId;
    if (!from) return out(401, {error: "bad token"});

    const body = JSON.parse(event.body || "{}");
    const kind = String(body.kind || "");
    if (!TEXT[kind]) return out(400, {error: "bad kind"});

    const at = await accessToken(email, pk);
    const A = {Authorization: "Bearer " + at, "Content-Type": "application/json"};
    const DOCS = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

    /* who gets it */
    let targets = [];
    if (kind === "message") {
      const cid = String(body.chatId || "").replace(/[^A-Za-z0-9_\-]/g, "");
      const cr = await fetch(`${DOCS}/chats/${cid}`, {headers: A});
      const cd = await cr.json();
      const members = ((cd.fields && cd.fields.members && cd.fields.members.arrayValue.values) || []).map((v) => v.stringValue);
      if (!members.includes(from)) return out(403, {error: "not a member"});
      targets = members.filter((u) => u !== from);
    } else {
      const to = String(body.toUid || "");
      if (!to || to === from) return out(200, {sent: 0});
      targets = [to];
    }
    if (!targets.length) return out(200, {sent: 0});

    /* sender name */
    let name = "Genzura";
    try {
      const nr = await fetch(`${DOCS}/channels/${from}`, {headers: A});
      const nd = await nr.json();
      if (nd.fields && nd.fields.name) name = nd.fields.name.stringValue;
    } catch (e) {}

    /* Do-Not-Disturb: skip people whose quiet-hours schedule is on right now (close friends still get through) */
    const strOf = (f) => (f && f.stringValue) || "";
    const numOf = (f) => (f && (f.integerValue !== undefined ? Number(f.integerValue) : f.doubleValue !== undefined ? Number(f.doubleValue) : 0)) || 0;
    const toMin = (hhmm) => { const m = /^(\d\d):(\d\d)$/.exec(hhmm || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const inDnd = async (uid) => {
      try {
        const pr = await fetch(`${DOCS}/presence/${uid}`, {headers: A});
        if (!pr.ok) return false;
        const f = (await pr.json()).fields || {};
        if (!(f.dndOn && f.dndOn.booleanValue)) return false;
        const a = toMin(strOf(f.dndFrom) || "22:00"), b = toMin(strOf(f.dndTo) || "07:00");
        if (a === null || b === null || a === b) return false;
        const now = (Math.floor(Date.now() / 60000) + numOf(f.tz)) % 1440, cur = (now + 1440) % 1440;
        const active = a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
        if (!active) return false;
        const cr = await fetch(`${DOCS}/closeFriends/${uid}`, {headers: A});
        if (cr.ok) {
          const cf = await cr.json();
          const list = ((cf.fields && cf.fields.uids && cf.fields.uids.arrayValue && cf.fields.uids.arrayValue.values) || []).map((v) => v.stringValue);
          if (list.includes(from)) return false;
        }
        return true;
      } catch (e) { return false; }
    };

    let sent = 0;
    for (const uid of targets.slice(0, 50)) {
      if (await inDnd(uid)) continue;
      const qr = await fetch(`${DOCS}:runQuery`, {method: "POST", headers: A, body: JSON.stringify({structuredQuery: {
        from: [{collectionId: "fcmTokens"}],
        where: {fieldFilter: {field: {fieldPath: "uid"}, op: "EQUAL", value: {stringValue: uid}}}, limit: 10}})});
      const rows = await qr.json();
      const tokens = (Array.isArray(rows) ? rows : []).filter((r) => r.document).map((r) => r.document.name.split("/").pop());
      for (const token of tokens) {
        const mr = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {method: "POST", headers: A,
          body: JSON.stringify({message: {token, data: {title: name, body: TEXT[kind] + (kind === "call" ? (body.type === "video" ? " (video)" : " (voice)") : ""), tag: kind === "message" ? "c_" + (body.chatId || "") : "n_" + kind, callId: kind === "call" ? String(body.callId || "").replace(/[^A-Za-z0-9]/g, "") : ""},
            webpush: {headers: {Urgency: "high", TTL: kind === "call" ? "45" : "86400"}}, android: {priority: "HIGH", ttl: kind === "call" ? "45s" : "86400s"}}})});
        if (mr.ok) sent++;
        else if (mr.status === 404 || mr.status === 400) { await fetch(`${DOCS}/fcmTokens/${encodeURIComponent(token)}`, {method: "DELETE", headers: A}).catch(() => {}); }
      }
    }
    return out(200, {sent});
  } catch (e) {
    return out(500, {error: String(e.message || e)});
  }
};

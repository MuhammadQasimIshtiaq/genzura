/* ================================================================
   GENZLOOP - ring-ack on CLOUDFLARE.
   The callee's Android app calls this the moment the call notification reaches the phone
   (even if the app is closed). It marks calls/{id}.calleeRinging = true, so the caller sees
   "Ringing" (phone online) instead of "Calling" (phone offline).
   Route:  POST /ring-ack      body: { "token": "<FCM token of the phone>" }
   Needs the SAME 3 variables your push worker already uses:
     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

   HOW TO USE (pick ONE):
   A) Add to your existing worker (arain-api) - NO new variables needed:
      paste everything from "const rkEnc" down to the end of rkHandle() into that worker, then at the
      very top of its fetch(request, env, ctx) add:
          if (request.method === "POST" && new URL(request.url).pathname === "/ring-ack") return rkHandle(request, env);
   B) Or make a NEW worker, paste this WHOLE file (the "export default" at the bottom is only for
      this case) and add the 3 variables to that new worker. Then change RING_ACK_URL in PushService.kt.
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

    /* FCM token -> user id -> that user's newest ringing call */
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
    return J(500, { error: String(e.message || e) });
  }
}

/* only for option B (a NEW worker); delete this block when you paste into arain-api */
export default {
  async fetch(request, env) {
    if (request.method === "POST" && new URL(request.url).pathname === "/ring-ack") return rkHandle(request, env);
    return new Response("ring-ack worker", { status: 200 });
  },
};

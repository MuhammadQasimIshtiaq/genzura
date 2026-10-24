/* ================================================================
   GENZURA — Contacts matching ("contact = no follow needed for chat/call").
   Same 3 env vars as push.js:  FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
   Optional: CONTACTS_PEPPER (any long random string; falls back to the private key).

   PRIVACY MODEL
   - The phone never uploads raw contact numbers: it sends SHA-256(E.164 number) per contact.
   - Here every hash is re-hashed with a server secret (HMAC), so the stored index cannot be
     brute-forced from a leaked database.
   - Collections phoneIndex / contactBooks are server-only (Firestore rules deny clients).
   - A chat/call link (contactLinks/{uidA_uidB}) is created ONLY when it is mutual:
       A's verified phone is in B's contacts  AND  B's verified phone is in A's contacts.
   - A phone number must be verified (Firebase phone OTP) before it can be matched.

   Actions (POST JSON, Authorization: Bearer <Firebase ID token>):
     {action:"register"}                 -> index my verified phone number
     {action:"sync", hashes:[sha256...]} -> store my contact hashes, return matches + create links
     {action:"clear"}                    -> delete my index entry, my contact book and my links
     {action:"savedCount"}               -> opt-in only: how many phone books contain my number (count only, hidden if < 3)
================================================================ */
const crypto = require("crypto");
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w";
const b64u = (i) => Buffer.from(i).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const MAX_HASHES = 5000;

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
    const pepper = process.env.CONTACTS_PEPPER || pk;
    const hmac = (s) => crypto.createHmac("sha256", pepper).update(String(s)).digest("hex");

    /* who is calling (must be a signed-in user; phone number comes from Firebase, not from the client) */
    const idToken = ((event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "")).trim();
    if (!idToken) return out(401, {error: "no token"});
    const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + API_KEY, {method: "POST",
      headers: H, body: JSON.stringify({idToken})});
    const ld = await lr.json();
    const user = ld.users && ld.users[0];
    if (!user || !user.localId) return out(401, {error: "bad token"});
    const me = user.localId;
    const emailOk = !!(user.email && user.emailVerified);
    const phone = user.phoneNumber || ((user.providerUserInfo || []).find((p) => p.providerId === "phone") || {}).phoneNumber || "";

    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "");

    const at = await accessToken(email, pk);
    const A = {Authorization: "Bearer " + at, "Content-Type": "application/json"};
    const ROOT = `projects/${pid}/databases/(default)/documents`;
    const DOCS = `https://firestore.googleapis.com/v1/${ROOT}`;
    const del = (path) => fetch(`${DOCS}/${path}`, {method: "DELETE", headers: A}).catch(() => {});
    const getDoc = async (path) => { const r = await fetch(`${DOCS}/${path}`, {headers: A}); return r.ok ? r.json() : null; };
    const setDoc = (path, fields) => fetch(`${DOCS}/${path}`, {method: "PATCH", headers: A, body: JSON.stringify({fields})});
    const strArr = (a) => ({arrayValue: {values: a.map((s) => ({stringValue: s}))}});

    /* my currently indexed phone hash (if any) */
    const prev = await getDoc(`userPhone/${me}`);
    const prevIds = ((prev && prev.fields && prev.fields.ids && prev.fields.ids.arrayValue && prev.fields.ids.arrayValue.values) || []).map((v) => v.stringValue);

    async function clearMine() {
      for (const h of prevIds) await del(`phoneIndex/${h}`);
      await del(`userPhone/${me}`);
      await del(`contactBooks/${me}`);
      const qr = await fetch(`${DOCS}:runQuery`, {method: "POST", headers: A, body: JSON.stringify({structuredQuery: {
        from: [{collectionId: "contactLinks"}],
        where: {fieldFilter: {field: {fieldPath: "members"}, op: "ARRAY_CONTAINS", value: {stringValue: me}}}, limit: 1000}})});
      const rows = await qr.json();
      for (const r of (Array.isArray(rows) ? rows : [])) if (r.document) await del(`contactLinks/${r.document.name.split("/").pop()}`);
    }

    if (action === "clear") { await clearMine(); return out(200, {ok: true}); }

    /* ---- savedCount: ONLY a number. Needs the person's own opt-in (savedCountOpt/{uid}.on). Hidden when fewer than 3. ---- */
    if (action === "savedCount") {
      const opt = await getDoc(`savedCountOpt/${me}`);
      if (!(opt && opt.fields && opt.fields.on && opt.fields.on.booleanValue)) return out(403, {error: "Turn this feature on first"});
      const shaX = (x) => crypto.createHash("sha256").update(x).digest("hex");
      const ids = [];
      if (emailOk) ids.push(hmac(shaX("mailto:" + user.email.trim().toLowerCase())));
      if (phone) ids.push(hmac(shaX(phone)));
      if (!ids.length) return out(400, {error: "Verify your phone number or Google e-mail first (Contacts sync)"});
      const who = new Set();
      for (const h of ids) {
        const qr = await fetch(`${DOCS}:runQuery`, {method: "POST", headers: A, body: JSON.stringify({structuredQuery: {
          from: [{collectionId: "contactBooks"}],
          where: {fieldFilter: {field: {fieldPath: "h"}, op: "ARRAY_CONTAINS", value: {stringValue: h}}},
          select: {fields: [{fieldPath: "n"}]}, limit: 5000}})});
        const rows = await qr.json();
        for (const r of (Array.isArray(rows) ? rows : [])) if (r.document) { const u = r.document.name.split("/").pop(); if (u !== me) who.add(u); }
      }
      return out(200, {ok: true, count: who.size >= 3 ? who.size : null, few: who.size < 3});
    }

    if (action === "register" || action === "sync") {
      /* my identities: verified Google e-mail (no typing needed) + verified phone number (optional) */
      const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
      const myIds = [];
      if (emailOk) myIds.push(hmac(sha("mailto:" + user.email.trim().toLowerCase())));
      if (phone) myIds.push(hmac(sha(phone)));
      if (!myIds.length) return out(400, {error: "no verified e-mail or phone"});
      if (prevIds.some((h) => !myIds.includes(h))) await clearMine();                  // e-mail / phone changed
      const mine = [];
      for (const h of myIds) {
        const owner = await getDoc(`phoneIndex/${h}`);
        const ownerUid = owner && owner.fields && owner.fields.uid && owner.fields.uid.stringValue;
        if (ownerUid && ownerUid !== me) continue;                                     // already used by another account
        await setDoc(`phoneIndex/${h}`, {uid: {stringValue: me}});
        mine.push(h);
      }
      if (!mine.length) return out(409, {error: "identity already used by another account"});
      await setDoc(`userPhone/${me}`, {ids: strArr(mine)});
      if (action === "register") return out(200, {ok: true});
      const myHash = mine;   // array

      /* ---- sync ---- */
      const hashes = [...new Set((Array.isArray(body.hashes) ? body.hashes : [])
        .map((h) => String(h).toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)))].slice(0, MAX_HASHES);
      const book = hashes.map(hmac);
      await setDoc(`contactBooks/${me}`, {h: strArr(book), n: {integerValue: String(book.length)}});

      /* which of my contacts are Genzura users? */
      const matches = {};
      for (let i = 0; i < book.length; i += 300) {
        const names = book.slice(i, i + 300).map((h) => `${ROOT}/phoneIndex/${h}`);
        const br = await fetch(`${DOCS}:batchGet`, {method: "POST", headers: A, body: JSON.stringify({documents: names})});
        const rows = await br.json();
        for (const r of (Array.isArray(rows) ? rows : [])) {
          const u = r.found && r.found.fields && r.found.fields.uid && r.found.fields.uid.stringValue;
          if (u && u !== me) matches[u] = true;
        }
      }
      const uids = Object.keys(matches).slice(0, 500);

      const people = [];
      const writes = [];
      for (const u of uids) {
        /* mutual: is MY phone inside THEIR contact book? */
        const cb = await getDoc(`contactBooks/${u}`);
        const list = (cb && cb.fields && cb.fields.h && cb.fields.h.arrayValue && cb.fields.h.arrayValue.values) || [];
        const mutual = list.some((v) => myHash.includes(v.stringValue));
        const ch = await getDoc(`channels/${u}`);
        const f = (ch && ch.fields) || {};
        people.push({id: u, name: (f.name && f.name.stringValue) || "Genzura user", logo: (f.logoURL && f.logoURL.stringValue) || null, mutual});
        if (mutual) {
          const id = [me, u].sort().join("_");
          writes.push({update: {name: `${ROOT}/contactLinks/${id}`, fields: {members: strArr([me, u].sort()), at: {timestampValue: new Date().toISOString()}}}});
        }
      }
      for (let i = 0; i < writes.length; i += 400) {
        await fetch(`${DOCS}:commit`, {method: "POST", headers: A, body: JSON.stringify({writes: writes.slice(i, i + 400)})});
      }
      /* remove links to people who are no longer mutual contacts */
      const keep = new Set(people.filter((p) => p.mutual).map((p) => p.id));
      const qr = await fetch(`${DOCS}:runQuery`, {method: "POST", headers: A, body: JSON.stringify({structuredQuery: {
        from: [{collectionId: "contactLinks"}],
        where: {fieldFilter: {field: {fieldPath: "members"}, op: "ARRAY_CONTAINS", value: {stringValue: me}}}, limit: 1000}})});
      const old = await qr.json();
      for (const r of (Array.isArray(old) ? old : [])) {
        if (!r.document) continue;
        const id = r.document.name.split("/").pop();
        const other = id.split("_").find((x) => x !== me);
        if (!keep.has(other)) await del(`contactLinks/${id}`);
      }
      return out(200, {ok: true, contacts: book.length, people});
    }
    return out(400, {error: "bad action"});
  } catch (e) {
    return out(500, {error: String(e.message || e)});
  }
};

/* ================================================================
   GUPZY - one-tap translate (Urdu / Roman Urdu / English) for captions and comments.
   POST {text, to: "ur" | "roman" | "en"}  with  Authorization: Bearer <Firebase ID token>
   Returns {text, roman}.  No API key and no npm package needed:
   uses the free Google Translate web endpoint, falls back to MyMemory.
================================================================ */
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w";

function parseGoogle(d) {
  const rows = Array.isArray(d) && Array.isArray(d[0]) ? d[0] : [];
  let text = "", roman = "";
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    if (typeof r[0] === "string") text += r[0];
    else if (r[0] === null && typeof r[3] === "string") roman += r[3];
  }
  return {text: text.trim(), roman: roman.trim()};
}

async function google(text, tl) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + tl + "&dt=t&dt=rm&q=" + encodeURIComponent(text);
  const r = await fetch(url, {headers: {"User-Agent": "Mozilla/5.0"}});
  if (!r.ok) throw new Error("google " + r.status);
  return parseGoogle(await r.json());
}

async function myMemory(text, tl) {
  const r = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text.slice(0, 450)) + "&langpair=autodetect|" + tl);
  if (!r.ok) throw new Error("mymemory " + r.status);
  const d = await r.json();
  const t = d && d.responseData && d.responseData.translatedText;
  if (!t) throw new Error("mymemory empty");
  return {text: String(t), roman: ""};
}

exports.handler = async (event) => {
  const H = {"Content-Type": "application/json"};
  const out = (c, o) => ({statusCode: c, headers: H, body: JSON.stringify(o)});
  try {
    if (event.httpMethod !== "POST") return out(405, {error: "POST only"});
    const idToken = ((event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "")).trim();
    if (!idToken) return out(401, {error: "no token"});
    const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + API_KEY, {method: "POST", headers: H, body: JSON.stringify({idToken})});
    const ld = await lr.json();
    if (!(ld.users && ld.users[0] && ld.users[0].localId)) return out(401, {error: "bad token"});

    const body = JSON.parse(event.body || "{}");
    const text = String(body.text || "").trim().slice(0, 1500);
    const to = String(body.to || "ur");
    if (!text) return out(400, {error: "empty"});
    const tl = to === "en" ? "en" : "ur";
    let res;
    try { res = await google(text, tl); if (!res.text) throw new Error("empty"); }
    catch (e) { res = await myMemory(text, tl); }
    return out(200, {text: res.text, roman: res.roman});
  } catch (e) {
    return out(500, {error: String(e.message || e)});
  }
};

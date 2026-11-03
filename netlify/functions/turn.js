/* GUPZY — gives the app TURN relay credentials so calls work between phones on different mobile networks.
   Needs ONE of these (free) setups in Netlify env variables:
   0) ExpressTURN (free 1TB/month): EXPRESSTURN_USER + EXPRESSTURN_PASS
   B) Metered.ca:                METERED_APP (your app name, e.g. "arain") + METERED_API_KEY
   Caller must be logged in (Firebase ID token). */
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w";
exports.handler = async (event) => {
  const H = {"Content-Type": "application/json", "Cache-Control": "no-store"};
  const out = (c, o) => ({statusCode: c, headers: H, body: JSON.stringify(o)});
  try {
    const idToken = ((event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "")).trim();
    if (!idToken) return out(401, {error: "no token"});
    const lr = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + API_KEY, {method: "POST", headers: H, body: JSON.stringify({idToken})});
    const ld = await lr.json();
    if (!(ld.users && ld.users[0])) return out(401, {error: "bad token"});

    if (process.env.EXPRESSTURN_USER && process.env.EXPRESSTURN_PASS) {
      const clean = v => String(v).trim().replace(/^["']+|["']+$/g, "").trim();
      const host = clean(process.env.EXPRESSTURN_HOST || "free.expressturn.com").replace(/:\d+$/, "");
      return out(200, {iceServers: [
        {urls: "stun:" + host + ":3478"},
        {urls: ["turn:" + host + ":3478?transport=udp", "turn:" + host + ":3478?transport=tcp", "turn:" + host + ":443?transport=tcp", "turn:" + host + ":80?transport=tcp"],
          username: clean(process.env.EXPRESSTURN_USER), credential: clean(process.env.EXPRESSTURN_PASS)},
      ]});
    }
    if (process.env.METERED_APP && process.env.METERED_API_KEY) {
      const r = await fetch(`https://${process.env.METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`);
      const d = await r.json();
      if (!r.ok || !Array.isArray(d)) return out(502, {error: "metered", detail: d});
      return out(200, {iceServers: d});
    }
    return out(404, {error: "TURN not configured"});
  } catch (e) { return out(500, {error: String(e.message || e)}); }
};

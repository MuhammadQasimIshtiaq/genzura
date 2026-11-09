// Gupzy TURN credentials  (Netlify function: /.netlify/functions/turn)
// Uses Cloudflare Realtime TURN (first 1,000 GB / month free).
// Netlify > Site settings > Environment variables:
//   CF_TURN_KEY_ID      = TURN key ID   (Cloudflare dashboard > Realtime > TURN Server)
//   CF_TURN_API_TOKEN   = TURN key API token (shown once when you create the key)
//   FIREBASE_API_KEY    = (optional) Firebase web apiKey; default below is the one in your app
const FB_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyATkLM81knrj_enQUsg1L9XRXt9_jdvL0w';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const json = (code, body) => ({ statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS), body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    // 1) only signed-in Gupzy users get credentials
    const auth = (event.headers.authorization || event.headers.Authorization || '');
    const idToken = auth.replace(/^Bearer\s+/i, '');
    if (!idToken) return json(401, { error: 'no token' });
    const chk = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FB_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    if (!chk.ok) return json(401, { error: 'bad token' });

    // 2) short-lived Cloudflare TURN credentials (24 h; the app caches them for 12 h)
    const keyId = process.env.CF_TURN_KEY_ID, apiToken = process.env.CF_TURN_API_TOKEN;
    if (!keyId || !apiToken) return json(500, { error: 'TURN not configured' });
    const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + keyId + '/credentials/generate-ice-servers', {
      method: 'POST', headers: { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 })
    });
    if (!r.ok) return json(502, { error: 'cloudflare ' + r.status });
    const d = await r.json();
    let ice = Array.isArray(d.iceServers) ? d.iceServers : (d.iceServers ? [d.iceServers] : []);
    // drop port-53 URLs (browsers warn about them and they are not needed)
    ice = ice.map(s => Object.assign({}, s, { urls: [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);
    return json(200, { iceServers: ice });
  } catch (e) {
    return json(500, { error: 'turn failed' });
  }
};

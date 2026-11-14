/* Gupzy — service worker (fast version)
   - Only handles the site's own files (same-origin). Videos (Cloudinary), Firebase/Firestore,
     ads and CDN scripts are loaded directly by the browser — before, all of these went through the SW and
     were copied into the cache, which made videos and the app slow.
   - Range requests (video seeking/streaming) are bypassed too.
   - Page (index.html): network-first, but if the network is slow (4 sec) the cached copy is shown right away.
   - Static files like icons/manifest: cache-first + refresh in the background (instant load). */

const CACHE_NAME = 'gupzy-shell-v198';
const APP_SHELL = [
  './',
  './icon-192.png',
  './icon-512.png',
  './genzura-logo.png',
  './genzura-z.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  /* delete old caches (v1 also saved videos/data) */
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   /* videos, Firebase, ads, CDN: browser handles directly */
  if (url.pathname.endsWith('.apk')) return;          /* big APK download: never cache */
  if (url.pathname.startsWith('/__/')) return;         /* Firebase login handler: never cache */
  if (url.pathname.startsWith('/studio') || url.pathname.startsWith('/gupchats')) return;     /* Gupzy Studio is a separate app: never serve the main app's cached page for it */
  if (req.headers.has('range')) return;              /* video streaming/seeking */

  const isPage = req.mode === 'navigate' || req.destination === 'document';
  /* Only the app itself ( / and /index.html ) may be served from the saved shell. Every other page (privacy, terms, contact, copyright, about …)
     is a real page: always load it straight from the network. (Before, a not-yet-saved page fell back to the app shell -> logo animation + white screen.) */
  const isApp = url.pathname === '/' || url.pathname === '/index.html';
  if (isPage && !isApp) return;

  if (isPage) {
    /* OPEN INSTANTLY: show the saved copy of the app right away and refresh it in the background (new version is used on the next launch).
       Only the very first launch (nothing saved yet) has to wait for the network. */
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = url.origin + url.pathname;            /* ?v=… / ?qa=… links share one saved copy */
      const cached = (await cache.match(key)) || (await cache.match('./'));
      const refresh = fetch(req).then((res) => {
        if (res && res.ok && res.status === 200) { cache.put(key, res.clone()).catch(() => {}); }
        return res;
      });
      if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
      try { return await refresh; } catch (e) { return Response.error(); }
    })());
    return;
  }

  /* static files: serve from cache instantly, refresh in the background */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});

/* ---------- Push notifications (FCM data messages) ---------- */
self.addEventListener('push', (event) => {
  let d = {};
  try { const j = event.data ? event.data.json() : {}; d = j.data || j.notification || j; } catch (e) {}
  const title = d.title || 'Gupzy';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', icon: 'icon-192.png', badge: 'badge-mono.png',
    tag: d.tag || undefined, data: d
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

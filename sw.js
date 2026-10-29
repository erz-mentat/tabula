// Tabula Service Worker: startet sofort aus dem Zwischenspeicher und holt Updates im Hintergrund.
const CACHE = 'tabula-v20';
const ASSETS = ['./', './index.html', './icon.png', './manifest.webmanifest'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    let cached = await c.match(req, { ignoreSearch: true });
    if (!cached && req.mode === 'navigate') cached = await c.match('./index.html');
    const net = fetch(req).then(res => { if (res && res.ok) return c.put(req, res.clone()).then(() => res); return res; }).catch(() => null);
    if (cached) { e.waitUntil(net); return cached; }
    return (await net) || new Response('Tabula ist offline und noch nicht zwischengespeichert. Starte einmal den Server in a-Shell.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});

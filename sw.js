// RunSync service worker — offline app shell (stale-while-revalidate)
const CACHE = 'runsync-v4';
const SHELL = ['./', 'index.html', 'desktop.html', 'css/app.css', 'js/app.js', 'js/engine.js', 'js/fit.js', 'js/formats.js', 'js/export.js', 'js/plan.js', 'js/laps.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok && (new URL(req.url).origin === location.origin || req.url.includes('fonts.g'))) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

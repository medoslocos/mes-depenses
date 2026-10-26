// Service worker : l'app s'ouvre hors connexion (coquille en cache) ; Firestore gère lui-même la file d'attente des données.
const VERSION = 'dev';
const CACHE = 'depenses-' + VERSION;
const SHELL = ['./', './index.html', './app.js', './lib.js', './store.js', './firebase-config.js', './style.css', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
const SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('depenses-') && k !== CACHE && k !== 'depenses-sdk').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // SDK Firebase (URL versionnée, donc immuable) : cache d'abord
  if (url.href.startsWith(SDK)) {
    e.respondWith(caches.open('depenses-sdk').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // Coquille de l'app : cache d'abord (ouverture instantanée), mise à jour par nouvelle version du SW
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch { return (await c.match('./index.html')) || Response.error(); }
  }));
});

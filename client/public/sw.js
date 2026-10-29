const CACHE_NAME = 'hifz-warsh-v2';
const STATIC_DATA_ASSETS = [
  '/manifest.json',
  '/icon.svg',
  '/warsh.10.woff2',
  '/warsh_quran.json',
  '/warsh_surahs.json',
  '/mutashabihat.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_DATA_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Never cache API calls, WebSockets, or HTML documents (index.html)
  if (url.includes('/api/') || url.startsWith('ws') || e.request.mode === 'navigate') {
    return;
  }

  // Cache-first for large static Quran data and fonts
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return cached || fetch(e.request);
    })
  );
});

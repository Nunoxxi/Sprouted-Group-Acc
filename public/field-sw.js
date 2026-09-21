// Service worker for /field: keeps the purchase form usable with no signal.
// The page shell is network-first with a cached fallback; Next's hashed
// static assets are cache-first (they never change under one URL). Nothing
// else is cached — the rest of the app is online-only.
const CACHE = 'sprouted-field-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/field').catch(() => undefined)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(request)) ?? fetch(request).then((response) => { if (response.ok) cache.put(request, response.clone()); return response; })));
    return;
  }

  if (url.pathname === '/field') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) cache.put('/field', response.clone());
          return response;
        } catch {
          const cached = await cache.match('/field');
          return cached ?? new Response('Offline and no saved copy of the form yet. Open it once with signal.', { status: 503, headers: { 'content-type': 'text/plain' } });
        }
      }),
    );
  }
});

// Service worker for /capture: keeps the phone capture page usable with no
// signal. The page shell is network-first with a cached fallback; Next's
// hashed static assets are cache-first (they never change under one URL).
// Captures themselves are kept by the page, in IndexedDB, not here.
const CACHE = 'sprouted-capture-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/capture').catch(() => undefined)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('sprouted-capture') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
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

  if (url.pathname === '/capture') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const response = await fetch(request);
          // Only a real page is kept: a redirect to sign-in is not the form.
          if (response.ok && !response.redirected) cache.put('/capture', response.clone());
          return response;
        } catch {
          const cached = await cache.match('/capture');
          return cached ?? new Response('Offline, and this phone has no saved copy of the page yet. Open it once with signal.', { status: 503, headers: { 'content-type': 'text/plain' } });
        }
      }),
    );
  }
});

// LimoPay Service Worker — Network First
// Auto-updates on every deploy. Bump CACHE_NAME to force cache invalidation.
const CACHE_NAME = 'limopay-v4';

// ── INSTALL: pre-cache nothing, go network-first always ───────────────────────
self.addEventListener('install', event => {
  // Don't wait — activate immediately on first install
  self.skipWaiting();
});

// ── ACTIVATE: clear old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: Network First ──────────────────────────────────────────────────────
// Always try the network first. Only fall back to cache if offline.
// This ensures drivers always get the latest version after every deploy.
self.addEventListener('fetch', event => {
  // Only intercept GET requests for our own origin (not API calls)
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // Got fresh response — update cache
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed — serve from cache (offline fallback)
        return caches.match(event.request);
      })
  );
});

// ── MESSAGE: allow page to trigger skipWaiting ────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

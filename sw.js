const CACHE = 'votre-chance-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/lib/account.js',
  '/lib/stats-engine.js',
  '/lib/stats-advanced.js',
  '/lib/grid-generator.js',
  '/lib/backtest.js',
  '/lib/fdj-merge.js',
  '/lib/fdj-client.js',
  '/data/draws.js',
  '/data/backtest.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(SHELL);
      // The CDN script is optional for offline use: never let it block installation.
      try { await cache.add(new Request(SUPABASE_LIB, { mode: 'cors' })); } catch (_) {}
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put('/index.html', response.clone());
    return response;
  } catch (_) {
    return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.origin === self.location.origin) {
    // Live data (FDJ results) must always come from the network.
    if (url.pathname.startsWith('/api/')) return;
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (request.url === SUPABASE_LIB) event.respondWith(staleWhileRevalidate(request));
  // Supabase API/auth calls and other origins are left untouched.
});

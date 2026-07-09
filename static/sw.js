/**
 * FreeHub Pro Service Worker — does TWO jobs:
 *
 *   1. App shell caching (offline support, instant repeat loads).
 *   2. Cross-Origin-Isolation header injection so WebAssembly can use
 *      threads + SIMD and WebGPU can run. Without this, ONNX inference
 *      falls back to single-threaded WASM (~10× slower).
 *
 * Bump CACHE_VERSION on every release. Old caches are auto-deleted.
 * The MI-GAN model is NOT cached here — it lives in IndexedDB (see model-cache.js).
 */

const CACHE_VERSION = 'freehub-pro-v2.1.0';

const APP_SHELL = [
  './',
  './index.html',
  './about.html',
  './help.html',
  './legal.html',
  './license.html',
  './privacy.html',
  './offline.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/about.css',
  './js/app.js',
  './js/upload.js',
  './js/mask.js',
  './js/inpainter.js',
  './js/model-cache.js',
  './js/updates.js',
  './js/version.js',
  './js/toast.js',
  './js/debug.js',
  './js/video.js',
  './js/coi-bootstrap.js',
  './js/fs-folder.js',
  './assets/logo.svg',
  './assets/logo-icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

// External CDN deps
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(
      APP_SHELL.map(url => cache.add(url).catch(err => console.warn('SW cache miss', url, err)))
    );
    await Promise.all(
      CDN_ASSETS.map(url => cache.add(url).catch(err => console.warn('SW CDN miss', url, err)))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// === Header injection (COI) helper =========================================
function withCOIHeaders(response) {
  if (response.status === 0) return response;  // opaque (no-cors)
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// === Fetch strategy =========================================================
//   - Same-origin: cache-first, then network, with COI headers either way
//   - HuggingFace model: passthrough (IndexedDB handles its own caching)
//   - CDN libs: stale-while-revalidate, with COI headers
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  const url = new URL(req.url);

  // Don't intercept the model fetch — let it stream straight to JS for IndexedDB.
  if (url.hostname.includes('huggingface.co') || url.hostname.includes('xethub.hf.co')) {
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(cacheFirstWithCOI(req));
  } else {
    event.respondWith(staleWhileRevalidateWithCOI(req));
  }
});

async function cacheFirstWithCOI(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return withCOIHeaders(cached);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return withCOIHeaders(res);
  } catch {
    const fallback = await cache.match('./offline.html');
    return withCOIHeaders(fallback || new Response('Offline', { status: 503 }));
  }
}

async function staleWhileRevalidateWithCOI(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  const res = cached || await networkPromise;
  return res ? withCOIHeaders(res) : new Response(null, { status: 503 });
}

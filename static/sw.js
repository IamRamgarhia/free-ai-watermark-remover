/**
 * WatermarkOut Service Worker — does TWO jobs:
 *
 *   1. App shell caching (offline support, instant repeat loads).
 *   2. Cross-Origin-Isolation header injection so WebAssembly can use
 *      threads + SIMD and WebGPU can run. Without this, ONNX inference
 *      falls back to single-threaded WASM (~10× slower).
 *
 * Bump CACHE_VERSION on every release — it must match APP_VERSION in
 * js/version.js (tools/check.mjs enforces this). Old caches are auto-deleted.
 * The AI model is NOT cached here — it lives in IndexedDB (see model-cache.js).
 */

const CACHE_VERSION = 'watermarkout-v1.3.1';

// Everything needed to render both pages with no network. If you add an asset
// that either HTML file references, add it here too — otherwise it 404s for
// installed-PWA users who go offline before happening to load it once.
const APP_SHELL = [
  './',
  './index.html',
  './about.html',
  './guide.html',
  './offline.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/about.css',
  './css/fonts.css',
  './js/app.js',
  './js/about.js',
  './js/upload.js',
  './js/mask.js',
  './js/inpainter.js',
  './js/watermark-detect.js',
  './js/dewatermark.js',
  './js/model-cache.js',
  './js/updates.js',
  './js/version.js',
  './js/toast.js',
  './js/debug.js',
  './js/video.js',
  './js/coi-bootstrap.js',
  './js/fs-folder.js',
  './assets/fonts/syne-variable.woff2',
  './assets/fonts/dm-mono-400.woff2',
  './assets/fonts/dm-mono-500.woff2',
  './assets/logo.svg',
  './assets/logo-icon.svg',
  './assets/hero-illustration.svg',
  './assets/social-preview.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable.png',
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
  // frame-ancestors can only be set as a real header, never via <meta>, so the
  // anti-clickjacking rule lives here while the resource directives live in the
  // pages' <meta> CSP (which also covers the very first load, before this SW is
  // active). Two policies both apply — the browser enforces the intersection.
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
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
    // Only a page navigation should fall back to offline.html. Returning HTML
    // for a failed image/script/JSON request just produces a confusing parse
    // error instead of an honest network failure.
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./offline.html');
      if (fallback) return withCOIHeaders(fallback);
    }
    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
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

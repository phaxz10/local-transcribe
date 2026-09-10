/**
 * Scribe service worker, two jobs in one registration. The `lt-shell-` cache prefix below
 * keeps its old name on purpose: renaming it orphans every shell already on a device.
 *
 * 1. Cross-origin isolation. Static hosts (Pages/Netlify/S3) can't set COOP/COEP, and without
 *    them there is no SharedArrayBuffer, so no threaded ffmpeg/ORT. We stamp the headers onto
 *    every response ourselves — the well-known SW header-injection trick, inlined here so it can
 *    share the fetch handler with the cache below (two service workers can't both own `fetch`).
 * 2. App-shell precache, so an offline launch actually boots. The `__PRECACHE__` / `__BUILD_ID__`
 *    globals below are rewritten at build time by the `app-shell-precache` plugin in
 *    vite.config.ts; unrewritten (dev) they are undefined and the caching half no-ops.
 *
 * ponytail: ort wasm chunks are ~24 MB; precaching them makes first install heavier but offline
 * launch actually works.
 */

const PRECACHE = ["/","/index.html","/manifest.webmanifest","/favicon.svg","/assets/archivo-latin-ext-wdth-normal-7khWdh9v.woff2","/assets/archivo-latin-wdth-normal-DY7AcnAa.woff2","/assets/archivo-vietnamese-wdth-normal-rJmnGBSt.woff2","/assets/engine.worker-AVG-H-rI.js","/assets/index-B668nRxz.js","/assets/index-BEAKe-pV.css","/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm","/assets/worker-D1KsWRGg.js","/ffmpeg/ffmpeg-core.js","/ffmpeg/ffmpeg-core.wasm","/ffmpeg/ffmpeg-core.worker.js"] || []
const CACHE = 'lt-shell-' + ("00bb410c97fe" || 'dev')
/** Content-addressed build output + self-hosted ffmpeg core: immutable, so cache-first. */
const IMMUTABLE = /^\/(assets|ffmpeg)\//

/** Re-wrap a response with the isolation headers. Consumes `res.body` — clone first if needed. */
function isolate(res) {
  if (res.status === 0) return res // opaque; headers can't be touched
  const headers = new Headers(res.headers)
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  if (!PRECACHE.length) return
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('lt-shell-') && key !== CACHE) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

async function networkFirst(request) {
  try {
    return isolate(await fetch(request))
  } catch (err) {
    const cache = await caches.open(CACHE)
    const hit = (await cache.match(request)) || (await cache.match('/index.html'))
    if (hit) return isolate(hit)
    throw err
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return isolate(hit)
  const res = await fetch(request)
  if (res.status === 200) cache.put(request, res.clone()).catch(() => {})
  return isolate(res)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  // Chrome's back/forward cache probe — responding to it breaks navigation.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin
  const get = request.method === 'GET'

  if (sameOrigin && get && request.mode === 'navigate') return event.respondWith(networkFirst(request))
  if (sameOrigin && get && IMMUTABLE.test(url.pathname)) return event.respondWith(cacheFirst(request))

  // Everything else — model weights from huggingface.co above all — goes to the network
  // untouched. Transformers.js keeps its own `transformers-cache`; mirroring gigabytes of
  // weights into ours would double the storage for nothing.
  event.respondWith(fetch(request).then(isolate))
})

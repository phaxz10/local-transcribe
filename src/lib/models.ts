/**
 * Model provisioning truth + lifecycle (ADR-0008).
 *
 * Transformers.js stores model weights in the Cache Storage bucket `transformers-cache`,
 * keyed by the resolved request URL: `https://huggingface.co/{hfId}/resolve/{revision}/{file}`.
 * (Verified against @huggingface/transformers v4 `buildResourcePaths`.)
 *
 * We keep a lightweight provisioned-id *index* in IndexedDB settings for instant UI, but
 * Cache Storage is the source of truth. `reconcile` self-corrects a stale index (e.g. an
 * entry the browser evicted under storage pressure). `evictModel` is the inverse of Provision.
 */
import { deleteDownloadParts, getSetting, listDownloadPartUrls, setSetting } from './db'

const WEIGHTS_CACHE = 'transformers-cache'
const HASH_CACHE = 'experimental_transformers-hash-cache'
const PROVISIONED_KEY = 'provisionedModelIds'

const hasCaches = (): boolean => typeof caches !== 'undefined'

/**
 * Does a cached request URL belong to this HF model? The `/resolve/` anchor disambiguates
 * prefixes. `/Xenova/whisper-tiny/resolve/` does NOT match `.../whisper-tiny.en/resolve/...`.
 */
function urlMatchesHfId(url: string, hfId: string): boolean {
  return url.includes(`/${hfId}/resolve/`)
}

async function cacheUrls(name: string): Promise<string[]> {
  if (!hasCaches()) return []
  try {
    const cache = await caches.open(name)
    return (await cache.keys()).map((r) => r.url)
  } catch {
    return []
  }
}

/* ── Provisioned-id index (a hint; always reconciled against Cache Storage) ── */

async function getProvisionedIds(): Promise<string[]> {
  return (await getSetting<string[]>(PROVISIONED_KEY).catch(() => undefined)) ?? []
}

async function setProvisionedIds(ids: string[]): Promise<void> {
  await setSetting(PROVISIONED_KEY, [...new Set(ids)])
}

export async function markProvisioned(id: string): Promise<void> {
  const ids = await getProvisionedIds()
  if (!ids.includes(id)) await setProvisionedIds([...ids, id])
}

async function unmarkProvisioned(id: string): Promise<void> {
  await setProvisionedIds((await getProvisionedIds()).filter((x) => x !== id))
}

/* ── Cache Storage truth ── */

/** Are this model's weights actually present in Cache Storage right now? */
async function isCached(hfId: string): Promise<boolean> {
  const urls = await cacheUrls(WEIGHTS_CACHE)
  return urls.some((u) => urlMatchesHfId(u, hfId))
}

/** Approximate bytes a model occupies in Cache Storage (sum of cached Content-Length). */
async function cachedBytes(hfId: string): Promise<number> {
  if (!hasCaches()) return 0
  try {
    const cache = await caches.open(WEIGHTS_CACHE)
    const reqs = (await cache.keys()).filter((r) => urlMatchesHfId(r.url, hfId))
    let total = 0
    for (const req of reqs) {
      const res = await cache.match(req)
      const len = res?.headers.get('content-length')
      if (len) total += Number(len)
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Drop cached files of a model that the current dtype policy no longer loads (e.g. Parakeet's
 * q4f16 export, retired for producing NaN logits on WebGPU). Cheap: one key scan per boot.
 */
export async function evictStaleFiles(hfId: string, stale: RegExp): Promise<void> {
  if (!hasCaches()) return
  try {
    const cache = await caches.open(WEIGHTS_CACHE)
    const reqs = (await cache.keys()).filter((r) => urlMatchesHfId(r.url, hfId) && stale.test(r.url))
    await Promise.all(reqs.map((r) => cache.delete(r)))
  } catch {
    /* ignore */
  }
}

/**
 * Evict a model's weights from Cache Storage (+ its LFS-hash entries and any resumable
 * `downloadParts` rows) and drop it from the provisioned index. The inverse of Provision.
 * Transcripts and settings are untouched.
 */
export async function evictModel(hfId: string, id?: string): Promise<void> {
  if (hasCaches()) {
    for (const name of [WEIGHTS_CACHE, HASH_CACHE]) {
      try {
        const cache = await caches.open(name)
        const reqs = (await cache.keys()).filter((r) => urlMatchesHfId(r.url, hfId))
        await Promise.all(reqs.map((r) => cache.delete(r)))
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const urls = (await listDownloadPartUrls()).filter((u) => urlMatchesHfId(u, hfId))
    await Promise.all(urls.map(deleteDownloadParts))
  } catch {
    /* ignore */
  }
  if (id) await unmarkProvisioned(id)
}

/**
 * Reconcile the provisioned-id index against Cache Storage truth in a single key scan.
 * `resolveHfId` maps a stored catalog id → its hfId. Returns the verified id set and rewrites
 * the index if it drifted.
 */
export async function reconcileProvisioned(
  resolveHfId: (id: string) => string | null,
): Promise<string[]> {
  const claimed = await getProvisionedIds()
  if (!claimed.length) return claimed
  const urls = await cacheUrls(WEIGHTS_CACHE)
  const present = (hfId: string) => urls.some((u) => urlMatchesHfId(u, hfId))
  const verified = claimed.filter((id) => {
    const hfId = resolveHfId(id)
    return hfId ? present(hfId) : false
  })
  if (verified.length !== claimed.length) await setProvisionedIds(verified)
  return verified
}

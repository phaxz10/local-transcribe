/**
 * Resumable model Download (ADR-0008).
 *
 * Transformers.js fetches the weights itself and has no resume: a cancelled or failed 1.6 GB
 * Download used to start again from zero. So we fetch the files first, with HTTP Range, parking
 * every ~8 MB into IndexedDB as it arrives, then seed the library's own Cache Storage bucket so
 * its loader finds everything already there and "downloads" instantly.
 *
 * The seeding is what makes this work at all: `transformers-cache`, keyed by the URL the library
 * builds itself (`https://huggingface.co/{hfId}/resolve/main/{file}`, verified against
 * `buildResourcePaths` in @huggingface/transformers v4.2.0, which puts the response under that
 * pre-redirect URL, not the CDN location it ends up at). Same key `models.ts` matches for Eviction.
 *
 * ponytail: this is a *prefetch*, not a replacement loader. If it doesn't run, or the device falls
 * back webgpu→wasm and needs different dtypes, Transformers.js just downloads them the old way.
 */
import type { CatalogModel, EngineDevice } from './types'
import type { LoadStatus } from './engine.worker'
import { CancelledError } from './cancel'
import { deleteDownloadParts, getDownloadParts, putDownloadPart } from './db'

const WEIGHTS_CACHE = 'transformers-cache'
const HF_HOST = 'https://huggingface.co'
const REVISION = 'main'
/** A reload loses at most this much of the file in flight. */
const PART_BYTES = 8 * 1024 * 1024

/** Verified against DEFAULT_DTYPE_SUFFIX_MAPPING in @huggingface/transformers v4.2.0. */
const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', int8: '_int8', q4f16: '_q4f16' } as const
type Dtype = keyof typeof DTYPE_SUFFIX

/**
 * The worker loads Silero VAD alongside *every* ASR model, so it prefetches with every model:
 * 2.2 MB, one file, no config.json (the repo has none). Cheap insurance that a user who
 * downloaded a model while online still gets silence gating offline.
 *
 * It is a separate hfId on purpose. `evictModel`/`reconcileProvisioned` in `models.ts` key on
 * `/${hfId}/resolve/`, so evicting an ASR model leaves the shared VAD in place and reconcile
 * never counts it as belonging to one — no change needed there.
 */
const VAD_HF_ID = 'onnx-community/silero-vad'
const VAD_FILES = ['onnx/model.onnx']

const CONFIG_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
]

/** Mirror of `DTYPE_OVERRIDES` in `engine.worker.ts` (the "why" lives there). Cohere Transcribe
 * has no CPU build at all — `dtypeFor` throws on WASM — so its q4f16 is listed for both devices:
 * a prefetch that never gets loaded is wasteful, a missing one would be broken. */
const DTYPE_OVERRIDES: Record<
  string,
  Partial<Record<EngineDevice, { encoder: Dtype; decoder: Dtype }>>
> = {
  'onnx-community/whisper-small-cantonese-ONNX': { webgpu: { encoder: 'fp16', decoder: 'q4' } },
  'onnx-community/cohere-transcribe-03-2026-ONNX': {
    webgpu: { encoder: 'q4f16', decoder: 'q4f16' },
    wasm: { encoder: 'q4f16', decoder: 'q4f16' },
  },
}

/**
 * Mirror of `dtypeFor` in `engine.worker.ts`: that is the SOURCE OF TRUTH and carries the "why"
 * for every choice. It can't be imported here: it lives in a module that pulls in the whole
 * Transformers.js bundle at top level. If the dtype policy changes there, change it here too, or
 * this prefetches files nobody then loads (wasteful, not broken).
 */
function dtypesFor(model: CatalogModel, device: EngineDevice): { encoder: Dtype; decoder: Dtype } {
  const override = DTYPE_OVERRIDES[model.hfId]?.[device]
  if (override) return override
  // Parakeet CTC has no encoder/decoder split: one dtype, reported in both slots so the single
  // `modelFiles` branch below can read either. int8 is deliberate (the "never an int8 encoder" rule
  // is Whisper-specific — a CTC model has no autoregressive decoder to amplify the noise).
  if (model.family === 'parakeet-ctc') {
    const d: Dtype = device === 'webgpu' ? 'q4f16' : 'int8'
    return { encoder: d, decoder: d }
  }
  const large = model.family === 'large-v3-turbo'
  if (device === 'webgpu') {
    return large ? { encoder: 'fp16', decoder: 'q4' } : { encoder: 'fp16', decoder: 'fp16' }
  }
  return large ? { encoder: 'fp16', decoder: 'q8' } : { encoder: 'fp32', decoder: 'q8' }
}

/**
 * The repo-relative files the pipeline will ask for.
 *
 * The Whisper entries list no `.onnx_data` sibling: only `whisper-large-v3-turbo_timestamped`'s
 * *fp32* encoder declares `use_external_data_format`, and no dtype policy above ever picks fp32
 * for that model. (Verified: every other `*.onnx_data` candidate 404s on the Hub.)
 *
 * Cohere Transcribe is the opposite case: its `transformers.js_config.use_external_data_format`
 * declares 1 chunk for both `encoder_model_q4f16.onnx` and `decoder_model_merged`, which
 * `getExternalDataChunkNames` (v4.2.0) turns into a single `<name>.onnx_data` each, fetched
 * through the same `getModelFile` path we seed. It also needs `processor_config.json`
 * (`CohereAsrProcessor.uses_processor_config = true`), which no Whisper export has.
 */
export function modelFiles(
  model: CatalogModel,
  device: EngineDevice,
): Array<{ hfId: string; file: string }> {
  const { encoder, decoder } = dtypesFor(model, device)
  const own = (file: string) => ({ hfId: model.hfId, file })
  const enc = `onnx/encoder_model${DTYPE_SUFFIX[encoder]}.onnx`
  const dec = `onnx/decoder_model_merged${DTYPE_SUFFIX[decoder]}.onnx`
  const vad = VAD_FILES.map((file) => ({ hfId: VAD_HF_ID, file }))
  if (model.family === 'parakeet-ctc') {
    // One `onnx/model_<dtype>.onnx` + its `.onnx_data` sibling (config.json declares
    // `transformers.js_config.use_external_data_format: true`, which the loader resolves to exactly
    // one `<file>.onnx_data` chunk). The repo has NO generation_config.json (404), and the tokenizer
    // loader only ever asks for tokenizer.json + tokenizer_config.json.
    const onnx = `onnx/model${DTYPE_SUFFIX[encoder]}.onnx`
    return [
      ...CONFIG_FILES.filter((f) => f !== 'generation_config.json').map(own),
      own(onnx),
      own(`${onnx}_data`),
      ...vad,
    ]
  }
  if (model.family === 'cohere-transcribe') {
    return [
      ...CONFIG_FILES.map(own),
      own('processor_config.json'),
      own(enc),
      own(`${enc}_data`),
      own(dec),
      own(`${dec}_data`),
      ...vad,
    ]
  }
  return [...CONFIG_FILES.map(own), own(enc), own(dec), ...vad]
}

export function fileUrl(hfId: string, file: string): string {
  return `${HF_HOST}/${hfId}/resolve/${REVISION}/${file}`
}

export interface DownloadOpts {
  signal?: AbortSignal
  onProgress?: (s: LoadStatus) => void
}

interface FilePlan {
  file: string
  url: string
  /** 0 when the server wouldn't say; progress is then just less precise. */
  size: number
  cached: boolean
}

async function planFile(cache: Cache, hfId: string, file: string): Promise<FilePlan> {
  const url = fileUrl(hfId, file)
  const hit = await cache.match(url)
  if (hit) return { file, url, size: Number(hit.headers.get('content-length')) || 0, cached: true }
  let size = 0
  try {
    const head = await fetch(url, { method: 'HEAD' })
    if (head.ok) size = Number(head.headers.get('content-length')) || 0
  } catch {
    /* offline / CORS hiccup: let the GET below produce the real error */
  }
  return { file, url, size, cached: false }
}

/** Belt for the UI's fit-check: a half-written model is worse than an upfront error. */
async function assertRoom(model: CatalogModel): Promise<void> {
  let est: StorageEstimate | null = null
  try {
    est = (await navigator.storage?.estimate?.()) ?? null
  } catch {
    return
  }
  if (!est || est.quota == null || est.usage == null) return
  const free = est.quota - est.usage
  if (free >= model.sizeMb * 1.3 * 1e6) return
  throw new Error(
    `Not enough free storage for ${model.label}: about ${Math.round(model.sizeMb * 1.3)} MB is ` +
      `needed and ${Math.round(free / 1e6)} MB is available. Free some space and try again.`,
  )
}

/**
 * Prefetch every file of a model into `transformers-cache`, resuming whatever a previous attempt
 * left behind. Already-cached files are skipped. Aborting keeps the partial bytes, which is the
 * whole point, and rejects with `CancelledError`; a real failure throws and also keeps them, so
 * the next attempt continues.
 */
export async function downloadModel(
  model: CatalogModel,
  device: EngineDevice,
  opts: DownloadOpts = {},
): Promise<void> {
  if (typeof caches === 'undefined') return // no Cache Storage: nothing to seed
  await assertRoom(model)

  const cache = await caches.open(WEIGHTS_CACHE)
  const plans: FilePlan[] = []
  for (const { hfId, file } of modelFiles(model, device)) plans.push(await planFile(cache, hfId, file))

  const totalBytes = plans.reduce((n, p) => n + p.size, 0)
  let doneBytes = plans.reduce((n, p) => n + (p.cached ? p.size : 0), 0)
  let peak = 0
  const report = (plan: FilePlan, index: number, received: number) => {
    const loadedBytes = doneBytes + received
    peak = Math.max(peak, loadedBytes) // monotonic: a restarted file must not run backward
    opts.onProgress?.({
      ratio: totalBytes > 0 ? Math.min(peak / totalBytes, 1) : 0,
      file: plan.file,
      loadedBytes: peak,
      totalBytes,
      fileIndex: index + 1,
      fileCount: plans.length,
    })
  }

  for (const [index, plan] of plans.entries()) {
    if (plan.cached) {
      report(plan, index, 0)
      continue
    }
    await fetchFile(cache, plan, opts.signal, (received) => report(plan, index, received))
    doneBytes += plan.size
    report(plan, index, 0)
  }
}

async function fetchFile(
  cache: Cache,
  plan: FilePlan,
  signal: AbortSignal | undefined,
  onBytes: (received: number) => void,
): Promise<void> {
  // Parts are appended strictly in order, so their total size IS the byte offset we resume from.
  let parts = await getDownloadParts(plan.url)
  let received = parts.reduce((n, p) => n + p.blob.size, 0)
  if (plan.size > 0 && received > plan.size) {
    await deleteDownloadParts(plan.url) // stale/corrupt leftovers
    parts = []
    received = 0
  }
  let nextIndex = parts.length ? parts[parts.length - 1].index + 1 : 0

  // An abort surfaces as a DOMException; the app only understands `CancelledError`.
  const cancelled = (e: unknown): never => {
    if (signal?.aborted) throw new CancelledError('Download cancelled')
    throw e
  }

  const res = await fetch(
    plan.url,
    received > 0 ? { headers: { Range: `bytes=${received}-` }, signal } : { signal },
  ).catch(cancelled)
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${plan.file}`)
  if (received > 0 && res.status !== 206) {
    // Server ignored the Range header and is sending the whole file: start this one over.
    await deleteDownloadParts(plan.url)
    received = 0
    nextIndex = 0
  }
  const body = res.body
  if (!body) throw new Error(`Download failed (no body) for ${plan.file}`)

  const reader = body.getReader()
  // BlobPart, not Uint8Array[]: a stream chunk is typed over ArrayBufferLike (i.e. possibly a
  // SharedArrayBuffer), which BlobPart doesn't accept. Fetch never hands one back.
  let buffer: BlobPart[] = []
  let buffered = 0
  const flush = async () => {
    if (!buffered) return
    await putDownloadPart({ url: plan.url, index: nextIndex++, blob: new Blob(buffer) })
    buffer = []
    buffered = 0
  }
  // Cancelling the reader ends the stream cleanly so the tail we already hold still gets stored.
  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer.push(value as BlobPart)
      buffered += value.byteLength
      received += value.byteLength
      onBytes(received)
      if (buffered >= PART_BYTES) await flush()
    }
  } catch (e) {
    cancelled(e)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await flush().catch(() => {})
  }
  if (signal?.aborted) throw new CancelledError('Download cancelled')

  const all = await getDownloadParts(plan.url)
  const blob = new Blob(all.map((p) => p.blob))
  if (plan.size > 0 && blob.size !== plan.size) {
    throw new Error(`Download incomplete for ${plan.file} (${blob.size}/${plan.size} bytes)`)
  }
  await cache.put(
    plan.url,
    new Response(blob, {
      status: 200,
      headers: {
        'content-length': String(blob.size),
        'content-type': 'application/octet-stream',
      },
    }),
  )
  if (!plan.size) plan.size = blob.size
  await deleteDownloadParts(plan.url)
}

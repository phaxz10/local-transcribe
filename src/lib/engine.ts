/**
 * Page-side handle on the ASR Engine. The inference session itself lives in `engine.worker.ts`;
 * this file is only the request/event plumbing plus the language mapping.
 *
 * Cancel is deliberately brutal: there is no cooperative abort inside onnxruntime, so an abort
 * terminates the worker and the next call lazily recreates it. Same for a crash (an ORT OOM shows
 * up as a worker `error` event), every in-flight request is rejected and the worker is replaced.
 */
import type { CatalogModel, EngineDevice, PrimaryLanguage } from './types'
import type {
  ASRResult,
  LoadStatus,
  TranscribeProgress,
  WorkerEvent,
  WorkerRequest,
} from './engine.worker'
import type { TranslationPair } from './translation'
import { evictModel } from './models'
import { CancelledError, isCancelled as isCancelledError } from './cancel'

export { isCancelled } from './cancel'
export type { ASRChunk, ASRResult, LoadStatus, TranscribeProgress } from './engine.worker'
export type { Region as SpeechRegion } from './vad-chunks'

const LANG_NAMES: Record<string, string> = {
  en: 'english',
  zh: 'chinese',
  yue: 'cantonese',
  ja: 'japanese',
  tl: 'tagalog',
}

export function languageName(
  primary: PrimaryLanguage,
  englishOnly: boolean,
  forceLanguage?: string,
): string | undefined {
  // English-only models must NOT receive a language/task (Transformers.js throws).
  if (englishOnly) return undefined
  if (forceLanguage) return forceLanguage
  if (primary === 'auto') return undefined
  return LANG_NAMES[primary]
}

/* ── Worker lifecycle ─────────────────────────────────────────────────────── */

const CRASH_MESSAGE =
  'The transcription engine crashed (probably out of memory). Try a smaller model or a shorter file.'

type DoneEvent = Extract<WorkerEvent, { type: 'done' }>

interface Pending {
  resolve: (ev: DoneEvent) => void
  reject: (e: unknown) => void
  onEvent: (ev: WorkerEvent) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

/** Terminate the worker and fail everything in flight. The next call recreates it. */
function killWorker(reason: unknown): void {
  const w = worker
  worker = null
  const inflight = [...pending.values()]
  pending.clear()
  w?.terminate()
  for (const p of inflight) p.reject(reason)
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<WorkerEvent>) => {
    const ev = e.data
    const p = pending.get(ev.id)
    if (!p) return
    if (ev.type === 'done') {
      pending.delete(ev.id)
      p.resolve(ev)
    } else if (ev.type === 'error') {
      pending.delete(ev.id)
      p.reject(new Error(ev.message))
    } else {
      p.onEvent(ev)
    }
  }
  const onCrash = () => killWorker(new Error(CRASH_MESSAGE))
  w.onerror = onCrash
  w.onmessageerror = onCrash
  worker = w
  return w
}

interface CallOpts {
  transfer?: Transferable[]
  signal?: AbortSignal
  cancelMessage: string
  onEvent?: (ev: WorkerEvent) => void
}

function call(build: (id: number) => WorkerRequest, opts: CallOpts): Promise<DoneEvent> {
  const id = nextId++
  const w = getWorker()
  return new Promise<DoneEvent>((resolve, reject) => {
    const { signal } = opts
    const onAbort = () => killWorker(new CancelledError(opts.cancelMessage))
    const detach = () => signal?.removeEventListener('abort', onAbort)
    pending.set(id, {
      resolve: (ev) => (detach(), resolve(ev)),
      reject: (e) => (detach(), reject(e)),
      onEvent: opts.onEvent ?? (() => {}),
    })
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    w.postMessage(build(id), opts.transfer ?? [])
  })
}

/* ── Public API ───────────────────────────────────────────────────────────── */

export type LoadProgress = (s: LoadStatus) => void

export interface GetEngineOpts {
  signal?: AbortSignal
  onProgress?: LoadProgress
}

/**
 * Load (or reuse) the Engine for a model on a device in the worker; resolves to the device
 * actually in use after the WebGPU→WASM fallback.
 * Cancellable via `opts.signal`: on abort the worker is terminated but whatever `download.ts`
 * already banked is KEPT, so the next attempt resumes (ADR-0008). A genuine load failure still
 * Evicts the partial, since a broken file would otherwise resume forever.
 */
export async function getEngine(
  model: CatalogModel,
  device: EngineDevice,
  opts: GetEngineOpts = {},
): Promise<EngineDevice> {
  try {
    const done = await call((id) => ({ id, type: 'load', model, device }), {
      signal: opts.signal,
      cancelMessage: 'Download cancelled',
      onEvent: (ev) => {
        if (ev.type === 'loadProgress') opts.onProgress?.(ev.status)
      },
    })
    return done.device ?? device
  } catch (e) {
    // Cancel keeps the partial on purpose: that is what makes a Download resumable.
    if (!isCancelledError(e)) await evictModel(model.hfId).catch(() => {}) // purge broken partial
    throw e
  }
}

export async function getAsrEngine(
  model: CatalogModel,
  device: EngineDevice,
  opts: GetEngineOpts = {},
): Promise<EngineDevice> {
  return await getEngine(model, device, opts)
}

/** Dispose the warm Engine (e.g. after Evicting the Active Model). */
export async function disposeEngine(): Promise<void> {
  worker?.postMessage({ type: 'dispose' } satisfies WorkerRequest)
}

export interface TranscribeOpts {
  language?: string
  task?: 'transcribe' | 'translate'
  /** English-only models reject language/task. */
  englishOnly?: boolean
  onPartial?: (text: string) => void
  onProgress?: (s: TranscribeProgress) => void
  signal?: AbortSignal
}

export interface TranscribeWithEngineOpts extends TranscribeOpts {
  onLoadProgress?: LoadProgress
  onDeviceReady?: (device: EngineDevice) => void
  onFallback?: (device: EngineDevice) => void
}

/**
 * Transcribe 16 kHz mono Int16 PCM. The worker loads the engine itself, so no prior `getEngine`
 * is needed.
 *
 * `pcm`'s buffer is TRANSFERRED to the worker, the caller must not touch the array afterwards.
 */
export async function transcribeWithEngine(
  model: CatalogModel,
  preferredDevice: EngineDevice,
  pcm: Int16Array,
  opts: TranscribeWithEngineOpts = {},
): Promise<ASRResult> {
  // The worker emits `device` on ready, and on a mid-run WASM fallback emits it again (once for the
  // fallback itself, once when the WASM engine is ready), a change of device is the fallback.
  // It doubles as the load/run divider: still null when the request fails ⇒ it died during the
  // load, so purge the partial exactly as `getEngine` would have.
  let lastDevice: EngineDevice | null = null
  try {
    const done = await call(
      (id) => ({
        id,
        type: 'transcribe',
        model,
        device: preferredDevice,
        pcm,
        opts: {
          language: opts.language,
          task: opts.task,
          englishOnly: opts.englishOnly,
          partial: Boolean(opts.onPartial),
        },
      }),
      {
        transfer: [pcm.buffer as ArrayBuffer],
        signal: opts.signal,
        cancelMessage: 'Transcription stopped',
        onEvent: (ev) => {
          if (ev.type === 'partial') opts.onPartial?.(ev.text)
          else if (ev.type === 'progress') opts.onProgress?.(ev.status)
          else if (ev.type === 'loadProgress') opts.onLoadProgress?.(ev.status)
          else if (ev.type === 'device') {
            if (lastDevice !== null && ev.device !== lastDevice) opts.onFallback?.(ev.device)
            else opts.onDeviceReady?.(ev.device)
            lastDevice = ev.device
          }
        },
      },
    )
    return done.result ?? { text: '' }
  } catch (e) {
    if (lastDevice === null && !isCancelledError(e)) {
      await evictModel(model.hfId).catch(() => {}) // purge broken partial (cancel keeps it)
    }
    throw e
  }
}

export interface TranslateOpts {
  signal?: AbortSignal
  onProgress?: (s: TranscribeProgress) => void
  onLoadProgress?: LoadProgress
}

/**
 * Machine-translate Segment texts into English (ADR-0018). One output per input, empty in → empty
 * out. The MT pipeline lives in its own worker slot, so this does not evict the ASR Engine.
 *
 * Cancel is the usual terminate, which also drops the ASR Engine — acceptable, since translation
 * only ever runs after its transcription has finished.
 */
export async function translateTexts(
  pair: TranslationPair,
  texts: string[],
  opts: TranslateOpts = {},
): Promise<string[]> {
  const done = await call((id) => ({ id, type: 'translate', pair, texts }), {
    signal: opts.signal,
    cancelMessage: 'Translation stopped',
    onEvent: (ev) => {
      if (ev.type === 'progress') opts.onProgress?.(ev.status)
      else if (ev.type === 'loadProgress') opts.onLoadProgress?.(ev.status)
    },
  })
  return done.translations ?? []
}

/** Quick ×realtime benchmark; loads (or reuses) the engine in the worker. */
export async function benchmark(model: CatalogModel, device: EngineDevice): Promise<number> {
  const done = await call((id) => ({ id, type: 'benchmark', model, device }), {
    cancelMessage: 'Benchmark cancelled',
  })
  return done.rtf ?? 0
}

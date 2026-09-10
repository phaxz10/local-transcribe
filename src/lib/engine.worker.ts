/**
 * The ASR Engine, off the main thread.
 *
 * Everything that touches the Transformers.js pipeline (feature extraction + onnxruntime-web)
 * lives here: on WASM devices a long file would otherwise freeze the UI for the whole run, and an
 * ORT out-of-memory would take the tab down with it. The page owns no pipeline object; it talks to
 * this worker over the tiny request/event protocol below. Cancel is a `terminate()` from the page,
 * so nothing in here needs an AbortSignal.
 */
import { AutoModel, Tensor, pipeline, env, WhisperTextStreamer } from '@huggingface/transformers'
import type { CatalogModel, EngineDevice } from './types'
import { interpolateWords, type SpeechRegion } from './interpolate-times'
import { translationModelId, type TranslationPair } from './translation'
import {
  MAX_CHUNK_SECONDS,
  VAD_WINDOW_SAMPLES,
  gridChunks,
  packChunks,
  regionsFromProbs,
} from './vad-chunks'
import type { Region } from './vad-chunks'

// Remote HF models only; Transformers.js caches weights in Cache Storage.
env.allowLocalModels = false

const WHISPER_SAMPLE_RATE = 16000
/** Languages whose Whisper tokens run 1-3 per character (decode budgets differ). */
const CJK_LANGS = new Set(['chinese', 'cantonese', 'japanese', 'korean'])
const MAX_DIRECT_TRANSCRIBE_SECONDS = 30
/** Int16 equivalent of the old 0.0008 float peak threshold (0.0008 × 32768). */
const SIGNAL_THRESHOLD = 26

/* ── Protocol ─────────────────────────────────────────────────────────────── */

export interface ASRChunk {
  text: string
  timestamp: [number, number | null]
}
export interface ASRResult {
  text: string
  chunks?: ASRChunk[]
  /**
   * Absolute-second speech regions from the VAD pass. Carried on the result so a later
   * diarization pass can reuse them instead of re-running the VAD. Absent when the VAD
   * was unavailable and the peak-based fallback ran.
   */
  speech?: Region[]
  /**
   * Where the word times in `chunks` came from. Absent = 'word' (the normal Whisper case).
   * 'chunk' = the cross-attention degrade below; 'interpolated' = manufactured (ADR-0016).
   */
  timing?: 'word' | 'chunk' | 'interpolated'
}

export interface LoadStatus {
  /** Monotonic 0..1 overall ratio (byte-weighted across files). */
  ratio: number
  /** File currently downloading. */
  file: string
  loadedBytes: number
  totalBytes: number
  fileIndex: number
  fileCount: number
}

export interface TranscribeProgress {
  ratio: number
  chunkIndex: number
  chunkCount: number
  completedSeconds: number
  totalSeconds: number
}

/** The decode knobs a request carries; the callbacks stay on the page side. */
export interface WorkerTranscribeOpts {
  language?: string
  task?: 'transcribe' | 'translate'
  /** English-only models reject language/task. */
  englishOnly?: boolean
  /** Only attach the token streamer when the page actually listens (one postMessage per token). */
  partial?: boolean
}

export type WorkerRequest =
  | { id: number; type: 'load'; model: CatalogModel; device: EngineDevice }
  | {
      id: number
      type: 'transcribe'
      model: CatalogModel
      device: EngineDevice
      pcm: Int16Array
      opts: WorkerTranscribeOpts
    }
  | { id: number; type: 'benchmark'; model: CatalogModel; device: EngineDevice }
  /** Stage two of translation (ADR-0018): one English string back per Segment text. */
  | { id: number; type: 'translate'; pair: TranslationPair; srcLang?: string; texts: string[] }
  | { type: 'dispose' }

export type WorkerEvent =
  | { id: number; type: 'loadProgress'; status: LoadStatus }
  | { id: number; type: 'progress'; status: TranscribeProgress }
  | { id: number; type: 'partial'; text: string }
  | { id: number; type: 'device'; device: EngineDevice }
  | {
      id: number
      type: 'done'
      device?: EngineDevice
      result?: ASRResult
      rtf?: number
      translations?: string[]
    }
  | { id: number; type: 'error'; message: string }

/* ── Pipeline ─────────────────────────────────────────────────────────────── */

/** The bits of a Transformers.js Tensor the CTC alignment below touches. */
interface LogitsTensor {
  dims: number[]
  to(type: 'float32'): { data: { [i: number]: number } }
}

// Transformers.js ASR pipeline type is complex; alias loosely.
type ASR = Awaited<ReturnType<typeof pipeline>> & {
  (audio: Float32Array, opts?: Record<string, unknown>): Promise<ASRResult>
  /**
   * `PreTrainedTokenizer` (v4.2.0) has no public `.model`/`id_to_token` — those live on the
   * internal engine it wraps. `AutoTokenizer` falls back to the base `PreTrainedTokenizer` class
   * for Parakeet (its `ParakeetTokenizer` class isn't in this library build), but that fallback
   * still builds a real `_tokenizer` underneath, so this path is unaffected by the fallback.
   */
  tokenizer: { _tokenizer: { id_to_token(id: number): string | undefined } }
  /** Reached directly only on the CTC path (see `transcribeCtc`). */
  model: ((inputs: unknown) => Promise<{ logits: LogitsTensor }>) & {
    config: { model_type?: string; pad_token_id?: number }
  }
  processor: (audio: Float32Array) => Promise<unknown>
  dispose?: () => Promise<void>
}

/** "No build for this device at all" — `dtypeFor` turns it into a readable error. */
const UNSUPPORTED = Symbol('unsupported')

/**
 * Per-model dtype escapes, keyed by hfId. MIRRORED in `download.ts#DTYPE_OVERRIDES`, keep in step.
 *
 * `whisper-small-cantonese-ONNX`: the family default on WebGPU is uniform fp16, but this repo's
 * fp16 merged decoder is 308 MB against 233 MB for q4, and q4 is what the sibling large-v3-turbo
 * export proved loads cleanly through onnxruntime-web's graph validator. Its q4f16 encoder (54 MB)
 * is tempting and rejected: 4-bit is *below* the int8 encoder the family rule already forbids.
 * WASM is left to the family default (fp32 encoder + q8 decoder), which is already right.
 *
 * `cohere-transcribe-03-2026-ONNX`: 2B params, >90% of them in the Conformer encoder. q4f16
 * (1.44 GB encoder + 98 MB decoder) is the only variant in the GPU budget, and the repo's own
 * `transformers.js_config` pins the kv-cache to float16 for exactly that dtype. It ships no CPU
 * build at all, hence UNSUPPORTED on WASM: the catalog entry is `requiresWebGPU`, so that only
 * fires if something forces the fallback, and a clear error beats Whisper dtype names on a
 * non-Whisper graph.
 */
const DTYPE_OVERRIDES: Record<string, Partial<Record<EngineDevice, unknown>>> = {
  'onnx-community/whisper-small-cantonese-ONNX': {
    webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
  },
  'onnx-community/cohere-transcribe-03-2026-ONNX': {
    webgpu: 'q4f16',
    wasm: UNSUPPORTED,
  },
}

function dtypeFor(model: CatalogModel, device: EngineDevice): unknown {
  const override = DTYPE_OVERRIDES[model.hfId]?.[device]
  if (override === UNSUPPORTED) {
    throw new Error(`${model.label} needs WebGPU and has no CPU build; pick another model.`)
  }
  if (override) return override
  // Parakeet CTC ships ONE `onnx/model_<dtype>.onnx` (+ external `.onnx_data`), no encoder/decoder
  // split, so the dtype is a single string. int8 is safe here: the "never an int8 encoder" rule
  // below is WHISPER-specific (an autoregressive decoder amplifies encoder noise into a repetition
  // loop). A CTC model emits one label per frame and cannot loop, so it takes the small download.
  if (model.family === 'parakeet-ctc') return device === 'webgpu' ? 'q4' : 'int8'
  const large = model.family === 'large-v3-turbo'
  if (device === 'webgpu') {
    // large-v3-turbo: fp16 encoder + 4-bit decoder. (The onnx-community fp16 *merged decoder* trips
    // onnxruntime-web's graph validator, "outer scope value ... add an Identity node", but q4,
    // quantized from fp32 rather than float16-converted, loads cleanly.) Small: uniform fp16 is fine
    // on the Xenova export.
    return large ? { encoder_model: 'fp16', decoder_model_merged: 'q4' } : 'fp16'
  }
  // WASM. Whisper is "extremely sensitive to quantization, especially of the encoder" (HF docs): an
  // int8 ENCODER is what makes small spiral into the "I'm I'm so so" repetition loop on hard audio.
  // Keep the encoder full precision and quantize only the decoder (q8 tolerates int8 fine). large is
  // WebGPU-only in practice; fp16 encoder here avoids dragging in its multi-GB fp32 weight.
  if (large) {
    return { encoder_model: 'fp16', decoder_model_merged: 'q8' }
  }
  return { encoder_model: 'fp32', decoder_model_merged: 'q8' }
}

interface RawProgress {
  status?: string
  file?: string
  name?: string
  loaded?: number
  total?: number
  progress?: number
  files?: Record<string, { loaded: number; total: number }>
}

/**
 * Byte-weighted download progress.
 *
 * We deliberately IGNORE Transformers.js's synthetic `progress_total` event. That aggregate is
 * summed over every file the loader *touches*, including ones it only size-probes but never
 * downloads. A model that ships a self-contained fp16 weight beside an fp32 weight with external
 * data poisons it: whisper-large-v3-turbo loads `encoder_model_fp16.onnx` (~1.2 GB) but the repo
 * also has `encoder_model.onnx` + a 2.4 GB `encoder_model.onnx_data`, which the aggregate counts , 
 * showing ~4 GB while the real download is ~1.5 GB. Instead we track only files that enter the
 * real download lifecycle (an `initiate` event from getModelFile) and sum their byte totals.
 */
function makeReporter(onProgress?: (s: LoadStatus) => void) {
  // Only files that fired `initiate` (a real fetch) are tracked, phantoms never do.
  const files = new Map<string, { loaded: number; total: number }>()
  let shown = 0
  let currentFile = 'model'

  function sums() {
    let loaded = 0
    let total = 0
    let done = 0
    for (const f of files.values()) {
      loaded += f.loaded
      total += f.total
      if (f.total > 0 && f.loaded >= f.total) done++
    }
    return { loaded, total, done }
  }

  function emit(file: string) {
    const { loaded, total, done } = sums()
    const fileCount = files.size
    const fileIndex = fileCount > 0 ? Math.min(done + 1, fileCount) : 0
    const ratio = total > 0 ? loaded / total : 0
    // Never report 100% until the engine says `ready`; a not-yet-sized file could still register.
    shown = Math.max(shown, Math.min(ratio, 0.994))
    onProgress?.({ ratio: shown, file, loadedBytes: loaded, totalBytes: total, fileIndex, fileCount })
  }

  return (info: RawProgress) => {
    if (!onProgress) return
    const status = info.status ?? ''

    if (status === 'ready') {
      const { loaded, total } = sums()
      onProgress({
        ratio: 1,
        file: currentFile,
        loadedBytes: loaded || total,
        totalBytes: total,
        fileIndex: files.size,
        fileCount: files.size,
      })
      return
    }

    // Phantom-inflated aggregate (see the function doc), ignore it entirely.
    if (status === 'progress_total') return

    const file = info.file || info.name || 'model'

    if (status === 'initiate') {
      currentFile = file
      if (!files.has(file)) files.set(file, { loaded: 0, total: 0 })
      emit(file)
      return
    }

    // Count progress only for files that began a real download (fired `initiate`).
    if (!files.has(file)) return
    if (status !== 'progress' && status !== 'done' && status !== 'download') return

    currentFile = file
    const prev = files.get(file) ?? { loaded: 0, total: 0 }
    const total = info.total ?? prev.total
    const loaded =
      status === 'done' ? Math.max(prev.loaded, total) : Math.max(prev.loaded, info.loaded ?? 0)
    files.set(file, { loaded, total })
    emit(file)
  }
}

/** Build the pipeline, reporting the device actually used (WebGPU → WASM graceful fallback). */
async function buildPipeline(
  model: CatalogModel,
  device: EngineDevice,
  report: (info: RawProgress) => void,
): Promise<{ engine: ASR; device: EngineDevice }> {
  const make = (dev: EngineDevice) =>
    pipeline('automatic-speech-recognition', model.hfId, {
      device: dev,
      dtype: dtypeFor(model, dev) as never,
      progress_callback: report as never,
    }) as unknown as Promise<ASR>
  try {
    return { engine: await make(device), device }
  } catch (e) {
    if (device === 'webgpu') return { engine: await make('wasm'), device: 'wasm' } // graceful fallback
    throw e
  }
}

interface Loaded {
  key: string
  engine: ASR
  device: EngineDevice
}
let current: Loaded | null = null

async function disposeCurrent(): Promise<void> {
  const c = current
  current = null
  try {
    await c?.engine.dispose?.()
  } catch {
    /* ignore */
  }
}

/** Get (or load + warm) the pipeline for a model on a device. Keyed by the *requested* device. */
async function loadEngine(
  model: CatalogModel,
  device: EngineDevice,
  onProgress?: (s: LoadStatus) => void,
): Promise<Loaded> {
  const key = `${model.task}|${model.hfId}|${device}`
  if (current?.key === key) return current
  if (current) await disposeCurrent()
  const built = await buildPipeline(model, device, makeReporter(onProgress))
  current = { key, engine: built.engine, device: built.device }
  return current
}

/* ── Machine translation (ADR-0018) ───────────────────────────────────────── */

/** The translation pipeline: an array in, `{ translation_text }` per item out. */
type MT = ((texts: string[], opts?: Record<string, unknown>) => Promise<{ translation_text: string }[]>) & {
  dispose?: () => Promise<void>
}

/**
 * Its OWN slot, separate from the ASR `current`, so switching Transcription Model does not evict a
 * translator that is about to translate the result of that very run. `dispose` clears both. Keyed
 * by model id, since the Marian pairs and NLLB share this one slot.
 *
 * Always WASM: int8 graphs where GPU dispatch overhead would dominate the arithmetic.
 */
let currentMt: { id: string; engine: MT } | null = null

async function disposeMt(): Promise<void> {
  const m = currentMt
  currentMt = null
  try {
    await m?.engine.dispose?.()
  } catch {
    /* ignore */
  }
}

async function loadMt(pair: TranslationPair, onProgress?: (s: LoadStatus) => void): Promise<MT> {
  // ponytail: NLLB's ~900 MB of int8 weights sit in the wasm32 heap alongside whatever ASR engine
  // is loaded. Nowhere near the 4 GB address-space ceiling with today's models, but that is the
  // ceiling — if a bigger translator ever lands here, evict `current` before loading it.
  const id = translationModelId(pair)
  if (currentMt?.id === id) return currentMt.engine
  if (currentMt) await disposeMt()
  const engine = (await pipeline('translation', id, {
    device: 'wasm',
    dtype: 'q8',
    // onnxruntime-web's extended QDQ pass chokes on this export's shared embedding:
    // "TransposeDQWeightsForMatMulNBits Missing required scale: model.shared.weight_merged_0_scale".
    // `basic` skips that whole family of rewrites; on a 77 M-param Marian the lost fusions cost
    // nothing we can measure, and the alternative is the ~310 MB fp32 graph.
    session_options: { graphOptimizationLevel: 'basic' },
    progress_callback: makeReporter(onProgress) as never,
  })) as unknown as MT
  currentMt = { id, engine }
  return engine
}

/**
 * Texts per generate call. The pipeline pads to the longest member, so a big batch wastes decode —
 * and NLLB is 8x the parameters of a Marian, so it gets half the batch.
 */
const MT_BATCH = { marian: 8, nllb: 4 }

async function translateTexts(
  engine: MT,
  texts: string[],
  srcLang: string | undefined,
  onProgress: (s: TranscribeProgress) => void,
): Promise<string[]> {
  const out = texts.map(() => '')
  const todo = texts.map((_, i) => i).filter((i) => texts[i].trim())
  // Empty Segments cost nothing and are already "done", so the ratio doesn't stall on them.
  let done = texts.length - todo.length
  const report = () =>
    onProgress({
      ratio: texts.length ? done / texts.length : 1,
      chunkIndex: done,
      chunkCount: texts.length,
      completedSeconds: 0,
      totalSeconds: 0,
    })
  report()
  const step = srcLang ? MT_BATCH.nllb : MT_BATCH.marian
  for (let at = 0; at < todo.length; at += step) {
    const slice = todo.slice(at, at + step)
    const batch = slice.map((i) => texts[i])
    const longest = Math.max(...batch.map((t) => [...t].length))
    const res = await engine(batch, {
      // ~4 tokens per source character is generous for zh/ja→en; the cap stops a runaway decode.
      max_new_tokens: Math.min(256, 4 * longest + 16),
      // NLLB is one multilingual graph: it needs to be told both ends of the direction. Marian
      // pairs are single-direction and reject these.
      ...(srcLang ? { src_lang: srcLang, tgt_lang: 'eng_Latn' } : {}),
    })
    slice.forEach((i, k) => (out[i] = (res[k]?.translation_text ?? '').trim()))
    done += slice.length
    report()
  }
  return out
}

/* ── Transcription ────────────────────────────────────────────────────────── */

/* ── Voice activity detection ─────────────────────────────────────────────── */

const VAD_HF_ID = 'onnx-community/silero-vad'
/** Silero's recurrent state: [2 LSTM layers, batch 1, 128 hidden]. */
const VAD_STATE_DIMS = [2, 1, 128]

/** The raw ONNX graph: inputs `input`/`sr`/`state`, outputs `output`/`stateN`. */
type VadSession = (i: Record<string, unknown>) => Promise<{ output: Tensor; stateN: Tensor }>

let vadSession: Promise<VadSession> | null = null
let vadFailed = false

/**
 * `onnx-community/silero-vad` ships `onnx/model.onnx` and *no config.json* (it 404s), so there is
 * no pipeline and no model class to dispatch on. `config: { model_type: 'custom' }` is
 * transformers.js's documented escape hatch: passing a config skips the config.json fetch, and an
 * unmapped model_type falls through to the default single-session path, whose forward is a plain
 * `sessionRun` returning the graph's own output names.
 *
 * Always WASM, even when the ASR pipeline is on WebGPU: this is a 2.2 MB LSTM invoked once per
 * 32 ms of audio, so GPU dispatch overhead would dominate the arithmetic several times over.
 * onnxruntime-web keeps an execution provider per InferenceSession, so the two coexist in one
 * worker. fp32 rather than the 0.6 MB int8: quantizing an LSTM's recurrent path for 1.6 MB of
 * download is a bad trade against a 500 MB model.
 */
function loadVad(): Promise<VadSession> {
  vadSession ??= AutoModel.from_pretrained(VAD_HF_ID, {
    config: { model_type: 'custom' } as never,
    dtype: 'fp32',
    device: 'wasm',
  }) as unknown as Promise<VadSession>
  return vadSession
}

/**
 * Speech regions in seconds, or `null` if the VAD could not run (never cached and now offline, or
 * an ORT error) — callers then fall back to the peak gate. The 512-sample windows must run
 * sequentially because the LSTM state carries between them.
 *
 * ponytail ceiling: that is ~31 session runs per second of audio (~112k for a one-hour file, ~780
 * for a full live tail). Still a rounding error next to a Whisper decode, but it is why this runs
 * once per request over the whole buffer rather than per chunk.
 */
/**
 * Peak-normalize in place. Quiet sources (a drama rip peaking at -24 dBFS) sit under the VAD's
 * speech threshold and starve Whisper's log-mel, so whole minutes read as silence. Gain is
 * capped so a near-silent file is not blown up into noise.
 */
function normalizeGain(pcm: Int16Array): void {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i]
    if (v > peak) peak = v
  }
  if (peak === 0) return
  const gain = Math.min(30, (0.9 * 32767) / peak)
  if (gain <= 1.05) return
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(pcm[i] * gain)
}

async function speechRegions(pcm: Int16Array): Promise<Region[] | null> {
  if (vadFailed) return null
  let vad: VadSession
  try {
    vad = await loadVad()
  } catch (e) {
    vadFailed = true
    vadSession = null
    console.warn('[vad] unavailable, falling back to the peak gate:', e)
    return null
  }

  const windowCount = Math.floor(pcm.length / VAD_WINDOW_SAMPLES)
  const probs = new Float32Array(windowCount)
  const sr = new Tensor('int64', [BigInt(WHISPER_SAMPLE_RATE)], [])
  let state = new Tensor('float32', new Float32Array(2 * 1 * 128), VAD_STATE_DIMS)
  try {
    for (let w = 0; w < windowCount; w++) {
      const offset = w * VAD_WINDOW_SAMPLES
      const frame = new Float32Array(VAD_WINDOW_SAMPLES)
      for (let j = 0; j < VAD_WINDOW_SAMPLES; j++) frame[j] = pcm[offset + j] / 32768
      const out = await vad({
        input: new Tensor('float32', frame, [1, VAD_WINDOW_SAMPLES]),
        sr,
        state,
      })
      state = out.stateN
      probs[w] = Number(out.output.data[0])
    }
  } catch (e) {
    vadFailed = true
    console.warn('[vad] run failed, falling back to the peak gate:', e)
    return null
  }
  return regionsFromProbs(
    probs,
    VAD_WINDOW_SAMPLES / WHISPER_SAMPLE_RATE,
    pcm.length / WHISPER_SAMPLE_RATE,
  )
}

/** Int16 → Float32, made per-chunk right before inference so peak memory stays ~2 bytes/sample. */
function toFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
  return out
}

function offsetResult(out: ASRResult, offsetSeconds: number): ASRResult {
  return {
    text: out.text ?? '',
    chunks: out.chunks?.map((chunk) => ({
      text: chunk.text,
      timestamp: [
        (chunk.timestamp?.[0] ?? 0) + offsetSeconds,
        chunk.timestamp?.[1] == null ? null : chunk.timestamp[1] + offsetSeconds,
      ],
    })),
  }
}

/** Worst granularity wins: one interpolated chunk makes the whole transcript approximate. */
function mergeTiming(results: ASRResult[]): ASRResult['timing'] {
  if (results.some((r) => r.timing === 'interpolated')) return 'interpolated'
  if (results.some((r) => r.timing === 'chunk')) return 'chunk'
  return undefined
}

function mergeResults(results: ASRResult[]): ASRResult {
  const speech = results.flatMap((r) => r.speech ?? [])
  const timing = mergeTiming(results)
  return {
    text: results.map((r) => r.text?.trim()).filter(Boolean).join(' '),
    chunks: results.flatMap((r) => r.chunks ?? []),
    ...(speech.length ? { speech } : {}),
    ...(timing ? { timing } : {}),
  }
}

function normalizePartial(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Heuristic for Whisper's repetition-hallucination: a chunk dominated by a handful of repeated
 * tokens (e.g. "I'm, I'm, so, so, so..."). Over a reasonable span, real speech keeps introducing
 * new words; a degenerate loop has very few unique tokens. This stands in for Whisper's
 * compression-ratio gate, which transformers.js v4.2.0 does not implement.
 */
function looksDegenerate(text: string): boolean {
  const toks = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (toks.length < 16) return false
  return new Set(toks).size / toks.length < 0.35
}

/** Fallback silence gate, used only when the VAD could not load. A raw peak threshold: it passes
 * room tone and HVAC straight into Whisper, which is exactly why the VAD replaced it. */
function hasDetectableSignalFallback(pcm: Int16Array): boolean {
  let peak = 0
  for (let i = 0; i < pcm.length; i += 16) {
    peak = Math.max(peak, Math.abs(pcm[i]))
    if (peak >= SIGNAL_THRESHOLD) return true
  }
  return false
}

/**
* One encoder frame = 10 ms mel hop (`hop_length` 160 @ 16 kHz) × `subsampling_factor` 8 = 80 ms.
 * Both numbers come from the repo's own preprocessor_config.json / config.json.
 */
const CTC_FRAME_SECONDS = 0.08

/**
 * Word timestamps for a CTC model, by hand.
 *
 * v4.2.0's ASR pipeline sends `parakeet_ctc` down the `_call_wav2vec2` branch, which greedy-decodes
 * and returns `{ text }` ONLY — it ignores `return_timestamps` entirely, so `buildAsrLayer` would
 * get one word for a whole 25 s chunk. So we run the processor + model ourselves: argmax per frame,
 * drop the CTC blank (`pad_token_id`) and repeats, then start a new word at each SentencePiece `▁`.
 * `.to('float32')` is a no-op on the WASM (int8) path and the correct decode on WebGPU's q4f16.
 *
 * ponytail: greedy argmax with no CTC emission-lag compensation, so a word's start can read a frame
 * or two (≤160 ms) late. Fine for playback highlighting and SRT; if it ever isn't, the fix is a
 * peak-shift per token, not a beam search.
 */
async function transcribeCtc(asr: ASR, wave: Float32Array, offsetSeconds: number): Promise<ASRResult> {
  const { logits } = await asr.model(await asr.processor(wave))
  const [, frames, vocab] = logits.dims
  const data = logits.to('float32').data
  const blank = asr.model.config.pad_token_id ?? vocab - 1
  const chunks: ASRChunk[] = []
  let prev = -1
  for (let t = 0; t < frames; t++) {
    const row = t * vocab
    let best = 0
    for (let v = 1; v < vocab; v++) if (data[row + v] > data[row + best]) best = v
    const repeated = best === prev
    prev = best
    if (best === blank || best === 0 /* <unk> */ || repeated) continue
    const piece = asr.tokenizer._tokenizer.id_to_token(best) ?? ''
    const start = offsetSeconds + t * CTC_FRAME_SECONDS
    const last = chunks[chunks.length - 1]
    if (last && !piece.startsWith('▁')) {
      last.text += piece
      last.timestamp[1] = start + CTC_FRAME_SECONDS
    } else {
      chunks.push({ text: piece.replace('▁', ''), timestamp: [start, start + CTC_FRAME_SECONDS] })
    }
  }
  const words = chunks.filter((c) => c.text)
  return { text: words.map((c) => c.text).join(' '), chunks: words, timing: 'word' }
}

/**
 * Whisper's language names ("english") are not what `cohere_asr` wants: `CohereAsrProcessor
 * .get_decoder_prompt_ids` builds a 10-token prompt containing `<|${language}|>`, i.e. an ISO
 * code. The model has no auto-detect at all, and 'en' is the library's own default, so anything
 * it doesn't speak (auto / yue / tl) lands there.
 */
const COHERE_LANG: Record<string, string> = { english: 'en', chinese: 'zh', japanese: 'ja', korean: 'ko' }

/**
 * The VAD's speech regions that overlap one chunk, clipped to it — what the interpolator lays the
 * words out over, so no manufactured word time lands inside a pause.
 *
 * `null` regions (VAD unavailable) or a chunk nothing intersects fall back to the whole span,
 * which is the pre-VAD behaviour: still monotonic, just blind to the silences inside.
 */
function regionsInChunk(
  all: Region[] | null,
  startSeconds: number,
  endSeconds: number,
): SpeechRegion[] {
  const whole: SpeechRegion[] = [{ start: startSeconds, end: endSeconds }]
  if (!all) return whole
  const inside = all
    .map((r) => ({ start: Math.max(r.start, startSeconds), end: Math.min(r.end, endSeconds) }))
    .filter((r) => r.end > r.start)
  return inside.length ? inside : whole
}

/**
 * Timestamp-free models (`cohere_asr`): the pipeline hands back one string and nothing else, so
 * word times are interpolated across the chunk's speech spans (ADR-0016). No `WhisperTextStreamer`
 * here, it decodes Whisper timestamp tokens, so live partials are off for these models.
 *
 * `speech` is the VAD sweep `transcribe` already ran; the words are spread over the real speech
 * inside this chunk rather than over its whole span, so pauses stay empty.
 */
async function transcribeUntimed(
  asr: ASR,
  wave: Float32Array,
  opts: WorkerTranscribeOpts,
  offsetSeconds: number,
  speech: Region[] | null,
): Promise<ASRResult> {
  const cjkUntimed = CJK_LANGS.has(String(opts.language ?? ''))
  const seconds = wave.length / WHISPER_SAMPLE_RATE
  const out = (await asr(wave, {
    // Cohere's card suggests a duration-proportional cap as the anti-hallucination device; a flat
    // 160 truncates dense Mandarin on a full chunk. `generate`'s own default is max_length 20.
    max_new_tokens: Math.min(440, Math.ceil(seconds * (cjkUntimed ? 14 : 8)) + 24),
    no_repeat_ngram_size: cjkUntimed ? 5 : 3,
    language: COHERE_LANG[opts.language ?? ''] ?? 'en',
  })) as ASRResult
  const text = out.text?.trim() ?? ''
  const regions = regionsInChunk(speech, offsetSeconds, offsetSeconds + seconds)
  return { text, chunks: interpolateWords(text, regions), timing: 'interpolated' }
}

async function transcribeOne(
  asr: ASR,
  model: CatalogModel,
  wave: Float32Array,
  opts: WorkerTranscribeOpts,
  offsetSeconds: number,
  committedText: string,
  onPartial: (text: string) => void,
  speech: Region[] | null,
): Promise<ASRResult> {
  // CTC path: no generation at all, so none of the decode knobs below apply — no language/task
  // (the pipeline only warns, but they mean nothing), no max_new_tokens/no_repeat_ngram_size/
  // do_sample, and no temperature retry, since a non-autoregressive model has no loop to escape.
  // There is no token stream either, so the live partial lands once per chunk instead of per token.
  if (asr.model.config.model_type === 'parakeet_ctc') {
    const out = await transcribeCtc(asr, wave, offsetSeconds)
    if (opts.partial) onPartial(normalizePartial(`${committedText} ${out.text}`))
    return out
  }
  if (model.timestamps === 'none') return transcribeUntimed(asr, wave, opts, offsetSeconds, speech)
  // Fresh streamer per attempt, so a failed-then-retried run doesn't double the live partial.
  const cjk = CJK_LANGS.has(String(opts.language ?? ''))
  const run = async (extra: Record<string, unknown>): Promise<ASRResult> => {
    let streamer: WhisperTextStreamer | undefined
    if (opts.partial) {
      let acc = ''
      streamer = new WhisperTextStreamer(asr.tokenizer as never, {
        callback_function: (t: string) => {
          acc += t
          onPartial(normalizePartial(`${committedText} ${acc}`))
        },
      })
    }
    // CJK languages spend 1-3 Whisper tokens per character, so a full 25 s chunk of Mandarin
    // overran the old flat budget of 160 and lost its tail; and a 3-gram block forbids ordinary
    // repeated phrases in Chinese/Japanese. Budget scales with audio, the block loosens for CJK.
    const seconds = wave.length / WHISPER_SAMPLE_RATE
    const params: Record<string, unknown> = {
      force_full_sequences: false,
      max_new_tokens: Math.min(440, Math.ceil(seconds * (cjk ? 14 : 8)) + 24),
      // Hard loop-breaker: forbid any 3-gram from repeating, which is what kills Whisper's
      // "I'm I'm so so so" repetition-hallucination. This is the decode safety-net the installed
      // transformers.js (v4.2.0) actually supports, the Python thresholds (compression_ratio /
      // logprob / no_speech) are NOT implemented in this build, so passing them would be ignored.
      // CJK: 5-gram, so legitimate phrase repeats survive while a degenerate loop still trips it.
      no_repeat_ngram_size: cjk ? 5 : 3,
      ...(streamer ? { streamer } : {}),
      ...extra,
    }
    const out = (await asr(wave, params)) as ASRResult
    return offsetResult(out, offsetSeconds)
  }

  // English-only models reject language/task; 'auto' passes language: undefined.
  const multilingual: Record<string, unknown> = opts.englishOnly
    ? {}
    : { language: opts.language, task: opts.task ?? 'transcribe' }

  // An export without cross-attentions can only do chunk timestamps; the catalog says so upfront
  // rather than paying for the failed word-timestamp attempt first.
  let degraded = model.timestamps === 'chunk'
  let extra: Record<string, unknown> = {
    ...multilingual,
    return_timestamps: degraded ? true : 'word',
  }
  let escalated = false
  for (;;) {
    try {
      const out = await run(extra)
      // Manual temperature fallback: transformers.js has no built-in compression-ratio retry, so if
      // greedy decoding still collapsed into a degenerate repetition loop, re-decode this chunk ONCE
      // with light sampling (and a tighter n-gram block) to jolt it out, Whisper's temperature
      // fallback, by hand. The fresh-streamer-per-attempt design means the retry re-streams cleanly.
      if (!escalated && looksDegenerate(out.text)) {
        escalated = true
        extra = { ...extra, do_sample: true, temperature: 0.4, no_repeat_ngram_size: cjk ? 3 : 2 }
        continue
      }
      return degraded ? { ...out, timing: 'chunk' } : out
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      // (1) Model rejects language+task -> drop them and retry (English-only .en builds).
      if (msg.includes('English-only') && ('language' in extra || 'task' in extra)) {
        const next = { ...extra }
        delete next.language
        delete next.task
        extra = next
        continue
      }
      // (2) Defensive: a decoder exported without cross-attentions can't do word timestamps ->
      // degrade to chunk-level timing (buildAsrLayer re-segments either granularity) instead of
      // failing. The catalog turbo uses the *_timestamped export so it never lands here.
      if (/cross attentions|output_attentions/i.test(msg) && extra.return_timestamps === 'word') {
        extra = { ...extra, return_timestamps: true }
        degraded = true
        continue
      }
      throw e
    }
  }
}

interface Sink {
  partial: (text: string) => void
  progress: (s: TranscribeProgress) => void
}

async function transcribe(
  asr: ASR,
  model: CatalogModel,
  pcm: Int16Array,
  opts: WorkerTranscribeOpts,
  sink: Sink,
): Promise<ASRResult> {
  const totalSeconds = pcm.length / WHISPER_SAMPLE_RATE
  // One VAD sweep over the whole buffer: it both gates silence and decides where the chunks cut.
  // `null` means the VAD is unavailable, and everything below reverts to the pre-VAD behaviour.
  normalizeGain(pcm)
  const regions = await speechRegions(pcm)
  const done = (result: ASRResult): ASRResult => (regions ? { ...result, speech: regions } : result)

  // No speech anywhere: nothing to decode. A live tail of pure silence lands here and returns
  // cleanly rather than handing Whisper a buffer it would hallucinate over.
  if (regions?.length === 0) {
    sink.progress({ ratio: 1, chunkIndex: 1, chunkCount: 1, completedSeconds: totalSeconds, totalSeconds })
    return done({ text: '', chunks: [] })
  }

  if (totalSeconds <= MAX_DIRECT_TRANSCRIBE_SECONDS) {
    const only = await transcribeOne(asr, model, toFloat32(pcm), opts, 0, '', sink.partial, regions)
    sink.progress({
      ratio: 1,
      chunkIndex: 1,
      chunkCount: 1,
      completedSeconds: totalSeconds,
      totalSeconds,
    })
    return done(only)
  }

  const results: ASRResult[] = []
  const chunks = regions ? packChunks(regions, MAX_CHUNK_SECONDS) : gridChunks(totalSeconds, MAX_CHUNK_SECONDS)
  for (const [index, chunk] of chunks.entries()) {
    const startSample = Math.max(0, Math.floor(chunk.startSeconds * WHISPER_SAMPLE_RATE))
    const endSample = Math.min(pcm.length, Math.ceil(chunk.endSeconds * WHISPER_SAMPLE_RATE))
    const slice = pcm.subarray(startSample, endSample)
    // A VAD-packed chunk is speech by construction; only the fallback grid needs a silence gate.
    if (regions || hasDetectableSignalFallback(slice)) {
      const out = await transcribeOne(
        asr,
        model,
        toFloat32(slice),
        opts,
        startSample / WHISPER_SAMPLE_RATE, // keep timestamps absolute
        results.map((r) => r.text?.trim()).filter(Boolean).join(' '),
        sink.partial,
        regions,
      )
      results.push(out)
    }
    sink.progress({
      ratio: totalSeconds > 0 ? Math.min(chunk.endSeconds / totalSeconds, 1) : 1,
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      completedSeconds: Math.min(chunk.endSeconds, totalSeconds),
      totalSeconds,
    })
  }
  return done(mergeResults(results))
}

function isWebGpuRuntimeError(e: unknown): boolean {
  const message = String((e as Error)?.message ?? e)
  return /WebGPU|GPUBuffer|OrtRun|MapAsyncStatus|external Instance|Failed to download data from buffer/i.test(
    message,
  )
}

/* ── Message loop ─────────────────────────────────────────────────────────── */

function post(ev: WorkerEvent): void {
  self.postMessage(ev)
}

async function handle(req: Exclude<WorkerRequest, { type: 'dispose' }>): Promise<void> {
  const { id } = req
  if (req.type === 'load') {
    const loaded = await loadEngine(req.model, req.device, (status) =>
      post({ id, type: 'loadProgress', status }),
    )
    post({ id, type: 'done', device: loaded.device })
    return
  }

  if (req.type === 'translate') {
    const engine = await loadMt(req.pair, (status) => post({ id, type: 'loadProgress', status }))
    const translations = await translateTexts(engine, req.texts, req.srcLang, (status) =>
      post({ id, type: 'progress', status }),
    )
    post({ id, type: 'done', translations })
    return
  }

  if (req.type === 'benchmark') {
    const { engine } = await loadEngine(req.model, req.device)
    const secs = 4,
      sr = 16000
    const wave = new Float32Array(secs * sr)
    for (let i = 0; i < wave.length; i++) wave[i] = 0.04 * Math.sin(i * 0.06)
    const t0 = performance.now()
    // `cohere_asr` wants an ISO code, not a Whisper language name (see COHERE_LANG): an unknown
    // `<|lang|>` token would poison the decoder prompt it builds from it.
    const language = req.model.family === 'cohere-transcribe' ? 'en' : 'english'
    await engine(wave, { language, chunk_length_s: 30 })
    const el = (performance.now() - t0) / 1000
    post({ id, type: 'done', rtf: el > 0 ? secs / el : 0 })
    return
  }

  // transcribe
  const onLoad = (status: LoadStatus) => post({ id, type: 'loadProgress', status })
  const sink: Sink = {
    partial: (text) => post({ id, type: 'partial', text }),
    progress: (status) => post({ id, type: 'progress', status }),
  }
  const loaded = await loadEngine(req.model, req.device, onLoad)
  post({ id, type: 'device', device: loaded.device })
  try {
    post({
      id,
      type: 'done',
      result: await transcribe(loaded.engine, req.model, req.pcm, req.opts, sink),
    })
  } catch (e) {
    if (req.device !== 'webgpu' || req.model.requiresWebGPU || !isWebGpuRuntimeError(e)) throw e
    // A GPU driver hiccup mid-run: drop the session, re-load on WASM and start over. The two
    // `device` events (fallback, then ready) are what drive the store's phase display.
    await disposeCurrent()
    post({ id, type: 'device', device: 'wasm' })
    const fallback = await loadEngine(req.model, 'wasm', onLoad)
    post({ id, type: 'device', device: 'wasm' })
    post({
      id,
      type: 'done',
      result: await transcribe(fallback.engine, req.model, req.pcm, req.opts, sink),
    })
  }
}

// One job at a time: `current` is a single engine slot, so requests are chained rather than raced.
let queue: Promise<unknown> = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  if (req.type === 'dispose') {
    queue = queue.then(async () => {
      await disposeCurrent()
      await disposeMt()
    })
    return
  }
  queue = queue.then(() =>
    handle(req).catch((err: unknown) => {
      post({ id: req.id, type: 'error', message: String((err as Error)?.message ?? err) })
    }),
  )
}

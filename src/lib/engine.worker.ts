/**
 * The ASR Engine, off the main thread.
 *
 * Everything that touches the Transformers.js pipeline (feature extraction + onnxruntime-web)
 * lives here: on WASM devices a long file would otherwise freeze the UI for the whole run, and an
 * ORT out-of-memory would take the tab down with it. The page owns no pipeline object; it talks to
 * this worker over the tiny request/event protocol below. Cancel is a `terminate()` from the page,
 * so nothing in here needs an AbortSignal.
 */
import { pipeline, env, WhisperTextStreamer } from '@huggingface/transformers'
import type { CatalogModel, EngineDevice } from './types'

// Remote HF models only; Transformers.js caches weights in Cache Storage.
env.allowLocalModels = false

const WHISPER_SAMPLE_RATE = 16000
const MAX_DIRECT_TRANSCRIBE_SECONDS = 30
const MANUAL_CHUNK_SECONDS = 25
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
  | { type: 'dispose' }

export type WorkerEvent =
  | { id: number; type: 'loadProgress'; status: LoadStatus }
  | { id: number; type: 'progress'; status: TranscribeProgress }
  | { id: number; type: 'partial'; text: string }
  | { id: number; type: 'device'; device: EngineDevice }
  | { id: number; type: 'done'; device?: EngineDevice; result?: ASRResult; rtf?: number }
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
  tokenizer: { model: { vocab: string[] } }
  /** Reached directly only on the CTC path (see `transcribeCtc`). */
  model: ((inputs: unknown) => Promise<{ logits: LogitsTensor }>) & {
    config: { model_type?: string; pad_token_id?: number }
  }
  processor: (audio: Float32Array) => Promise<unknown>
  dispose?: () => Promise<void>
}

function dtypeFor(model: CatalogModel, device: EngineDevice): unknown {
  // Parakeet CTC ships ONE `onnx/model_<dtype>.onnx` (+ external `.onnx_data`), no encoder/decoder
  // split, so the dtype is a single string. int8 is safe here: the "never an int8 encoder" rule
  // below is WHISPER-specific (an autoregressive decoder amplifies encoder noise into a repetition
  // loop). A CTC model emits one label per frame and cannot loop, so it takes the small download.
  if (model.family === 'parakeet-ctc') return device === 'webgpu' ? 'q4f16' : 'int8'
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

/* ── Transcription ────────────────────────────────────────────────────────── */

interface PlannedChunk {
  index: number
  startSample: number
  endSample: number
  startSeconds: number
  endSeconds: number
}

function plannedChunks(sampleCount: number): PlannedChunk[] {
  const samplesPerChunk = MANUAL_CHUNK_SECONDS * WHISPER_SAMPLE_RATE
  const chunks: PlannedChunk[] = []
  for (let startSample = 0; startSample < sampleCount; startSample += samplesPerChunk) {
    const endSample = Math.min(startSample + samplesPerChunk, sampleCount)
    chunks.push({
      index: chunks.length,
      startSample,
      endSample,
      startSeconds: startSample / WHISPER_SAMPLE_RATE,
      endSeconds: endSample / WHISPER_SAMPLE_RATE,
    })
  }
  return chunks
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

function mergeResults(results: ASRResult[]): ASRResult {
  return {
    text: results.map((r) => r.text?.trim()).filter(Boolean).join(' '),
    chunks: results.flatMap((r) => r.chunks ?? []),
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

function hasDetectableSignal(pcm: Int16Array): boolean {
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
  const pieces = asr.tokenizer.model.vocab
  const chunks: ASRChunk[] = []
  let prev = -1
  for (let t = 0; t < frames; t++) {
    const row = t * vocab
    let best = 0
    for (let v = 1; v < vocab; v++) if (data[row + v] > data[row + best]) best = v
    const repeated = best === prev
    prev = best
    if (best === blank || best === 0 /* <unk> */ || repeated) continue
    const piece = pieces[best] ?? ''
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
  return { text: words.map((c) => c.text).join(' '), chunks: words }
}

async function transcribeOne(
  asr: ASR,
  wave: Float32Array,
  opts: WorkerTranscribeOpts,
  offsetSeconds: number,
  committedText: string,
  onPartial: (text: string) => void,
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

  // Fresh streamer per attempt, so a failed-then-retried run doesn't double the live partial.
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
    const params: Record<string, unknown> = {
      force_full_sequences: false,
      max_new_tokens: 160,
      // Hard loop-breaker: forbid any 3-gram from repeating, which is what kills Whisper's
      // "I'm I'm so so so" repetition-hallucination. This is the decode safety-net the installed
      // transformers.js (v4.2.0) actually supports, the Python thresholds (compression_ratio /
      // logprob / no_speech) are NOT implemented in this build, so passing them would be ignored.
      no_repeat_ngram_size: 3,
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

  let extra: Record<string, unknown> = { ...multilingual, return_timestamps: 'word' }
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
        extra = { ...extra, do_sample: true, temperature: 0.4, no_repeat_ngram_size: 2 }
        continue
      }
      return out
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
  pcm: Int16Array,
  opts: WorkerTranscribeOpts,
  sink: Sink,
): Promise<ASRResult> {
  const totalSeconds = pcm.length / WHISPER_SAMPLE_RATE
  if (totalSeconds <= MAX_DIRECT_TRANSCRIBE_SECONDS) {
    const only = await transcribeOne(asr, toFloat32(pcm), opts, 0, '', sink.partial)
    sink.progress({
      ratio: 1,
      chunkIndex: 1,
      chunkCount: 1,
      completedSeconds: totalSeconds,
      totalSeconds,
    })
    return only
  }

  const results: ASRResult[] = []
  const chunks = plannedChunks(pcm.length)
  for (const chunk of chunks) {
    const slice = pcm.subarray(chunk.startSample, chunk.endSample)
    if (hasDetectableSignal(slice)) {
      const out = await transcribeOne(
        asr,
        toFloat32(slice),
        opts,
        chunk.startSeconds,
        results.map((r) => r.text?.trim()).filter(Boolean).join(' '),
        sink.partial,
      )
      results.push(out)
    }
    sink.progress({
      ratio: totalSeconds > 0 ? Math.min(chunk.endSeconds / totalSeconds, 1) : 1,
      chunkIndex: chunk.index + 1,
      chunkCount: chunks.length,
      completedSeconds: Math.min(chunk.endSeconds, totalSeconds),
      totalSeconds,
    })
  }
  return mergeResults(results)
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

  if (req.type === 'benchmark') {
    const { engine } = await loadEngine(req.model, req.device)
    const secs = 4,
      sr = 16000
    const wave = new Float32Array(secs * sr)
    for (let i = 0; i < wave.length; i++) wave[i] = 0.04 * Math.sin(i * 0.06)
    const t0 = performance.now()
    await engine(wave, { language: 'english', chunk_length_s: 30 })
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
    post({ id, type: 'done', result: await transcribe(loaded.engine, req.pcm, req.opts, sink) })
  } catch (e) {
    if (req.device !== 'webgpu' || req.model.requiresWebGPU || !isWebGpuRuntimeError(e)) throw e
    // A GPU driver hiccup mid-run: drop the session, re-load on WASM and start over. The two
    // `device` events (fallback, then ready) are what drive the store's phase display.
    await disposeCurrent()
    post({ id, type: 'device', device: 'wasm' })
    const fallback = await loadEngine(req.model, 'wasm', onLoad)
    post({ id, type: 'device', device: 'wasm' })
    post({ id, type: 'done', result: await transcribe(fallback.engine, req.pcm, req.opts, sink) })
  }
}

// One job at a time: `current` is a single engine slot, so requests are chained rather than raced.
let queue: Promise<unknown> = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  if (req.type === 'dispose') {
    queue = queue.then(() => disposeCurrent())
    return
  }
  queue = queue.then(() =>
    handle(req).catch((err: unknown) => {
      post({ id: req.id, type: 'error', message: String((err as Error)?.message ?? err) })
    }),
  )
}

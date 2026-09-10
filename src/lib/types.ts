import { z } from 'zod'

/* Transcript model. */

const AsrWord = z.object({
  id: z.string(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().min(0).max(1),
})
export type AsrWord = z.infer<typeof AsrWord>

const AsrSegment = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  words: z.array(AsrWord),
})
export type AsrSegment = z.infer<typeof AsrSegment>

const AsrLayer = z.object({
  segments: z.array(AsrSegment),
  language: z.string(),
  task: z.enum(['transcribe', 'translate']),
})
export type AsrLayer = z.infer<typeof AsrLayer>

const EditWord = z.object({
  id: z.string(),
  text: z.string(),
  /** ASR word id(s) this maps to; null = user-inserted. */
  origin: z.array(z.string()).nullable(),
  start: z.number(),
  end: z.number(),
  timing: z.enum(['exact', 'interpolated']),
})
export type EditWord = z.infer<typeof EditWord>

const EditSegment = z.object({
  id: z.string(),
  words: z.array(EditWord),
  /** Reserved for future diarization / manual speaker tagging. */
  speakerId: z.string().optional(),
})
export type EditSegment = z.infer<typeof EditSegment>

const EditLayer = z.object({
  segments: z.array(EditSegment),
})
export type EditLayer = z.infer<typeof EditLayer>

const TranscriptSource = z.object({
  filename: z.string(),
  sizeBytes: z.number(),
  durationSec: z.number(),
  hash: z.string(),
  mediaId: z.string().optional(),
  mimeType: z.string().optional(),
})
export type TranscriptSource = z.infer<typeof TranscriptSource>

const TranscriptRecord = z.object({
  id: z.string(),
  source: TranscriptSource,
  model: z.string(),
  primaryLanguage: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  asr: AsrLayer,
  edit: EditLayer,
})
export type TranscriptRecord = z.infer<typeof TranscriptRecord>

/* Model catalog. */

/** Per-language quality: 0 = unsupported, 1 = limited, 2 = ok, 3 = strong. */
export type LangQuality = 0 | 1 | 2 | 3

export type ModelTask = 'transcription'

export interface CatalogModel {
  /** Stable catalog id, e.g. "small.en". */
  id: string
  label: string
  task: ModelTask
  family: 'small' | 'large-v3-turbo'
  /** HuggingFace repo id loaded by Transformers.js (ONNX weights). */
  hfId: string
  /** Whether this is the English-only (.en) build. */
  englishOnly: boolean
  multilingual: boolean
  /** Approximate download size in MB. */
  sizeMb: number
  /** Estimated peak runtime memory in MB (for the Fit-check). */
  ramCeilingMb: number
  /** Gate to WebGPU devices. On WASM these are impractically slow. */
  requiresWebGPU: boolean
  /** Curated per-language quality used for model recommendation. */
  languages: Record<string, LangQuality>
  /**
   * Whisper language token to send regardless of the picked Primary Language. For a fine-tune
   * whose tokenizer lacks the token its own language would map to (see `small-yue`).
   */
  forceLanguage?: string
  available: boolean
}

/* Browser capability. */

export type CapabilityTier = 'low' | 'medium' | 'high'

export type EngineDevice = 'webgpu' | 'wasm'

export interface CapabilityReport {
  tier: CapabilityTier
  cores: number
  deviceMemoryGb: number | null
  mobile: boolean
  crossOriginIsolated: boolean
  /** WebGPU is available *and* usable (needs shader-f16), so it will be used for inference. */
  webgpu: boolean
  /** The adapter reports the `shader-f16` feature our fp16 weights require. */
  webgpuF16: boolean
  /** Chosen inference backend. */
  device: EngineDevice
  threads: boolean
  simd: boolean
  storageQuotaMb: number | null
  storageUsageMb: number | null
  /** Measured ×realtime from the benchmark; null until run. */
  benchmarkRtf: number | null
}

/** Languages we surface in the Primary-Language picker. */
export const PRIMARY_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Mandarin' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'auto', label: 'Other / Mixed' },
] as const
export type PrimaryLanguage = (typeof PRIMARY_LANGUAGES)[number]['code']

export type ExportFormat = 'txt' | 'srt' | 'vtt' | 'json' | 'md'
export type ExportLayer = 'raw' | 'corrected'

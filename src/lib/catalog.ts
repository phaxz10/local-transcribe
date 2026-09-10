import type { CapabilityReport, CatalogModel, PrimaryLanguage } from './types'

// Better last. Cohere Transcribe outranks small but sits BELOW turbo on purpose: it wins on WER
// but has no word timings, and click-to-seek is what people expect from the recommended default.
// It is a deliberate manual pick, not a recommendation.
const FAMILY_ORDER: CatalogModel['family'][] = ['small', 'cohere-transcribe', 'large-v3-turbo']

type Entry = Omit<CatalogModel, 'available'>

// ONNX Whisper models loaded by Transformers.js (ADR-0007). Sizes are approximate.
// Deliberately scoped to Small (the smallest tier that doesn't hallucinate/loop on hard audio)
// and Large v3 Turbo, the tiny/base tiers were dropped because they loop on real meetings.
const ENTRIES: Entry[] = [
  { id: 'small.en', label: 'Small (English)', task: 'transcription', family: 'small', hfId: 'Xenova/whisper-small.en', englishOnly: true, multilingual: false, sizeMb: 520, ramCeilingMb: 1200, requiresWebGPU: false, languages: { en: 3 } },
  { id: 'small', label: 'Small', task: 'transcription', family: 'small', hfId: 'Xenova/whisper-small', englishOnly: false, multilingual: true, sizeMb: 520, ramCeilingMb: 1200, requiresWebGPU: false, languages: { en: 2, zh: 2, ja: 2, yue: 1, tl: 2 } },
  // We request word-level timestamps (return_timestamps: 'word'), which needs a decoder exported
  // WITH cross-attentions. The canonical `whisper-large-v3-turbo` export lacks them and throws
  // "Model outputs must contain cross attentions"; the `_timestamped` sibling is re-exported with
  // output_attentions=True (same q4/fp16 ONNX variants). Don't revert this id, it reintroduces the crash.
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', task: 'transcription', family: 'large-v3-turbo', hfId: 'onnx-community/whisper-large-v3-turbo_timestamped', englishOnly: false, multilingual: true, sizeMb: 1600, ramCeilingMb: 2400, requiresWebGPU: true, languages: { en: 3, zh: 3, ja: 3, yue: 2, tl: 2 } },
  // #1 on the Open ASR Leaderboard (4.67 avg WER vs turbo's 6.36), Apache-2.0, and the same
  // download size as turbo. It emits NO timestamps of any kind and has no language auto-detect,
  // so word times are interpolated (ADR-0016) and `yue`/`tl` are 0 (the model doesn't speak them).
  // Measured q4f16: encoder 1436 MB + decoder 98 MB + configs ≈ 1536 MB.
  { id: 'cohere-transcribe', label: 'Cohere Transcribe', task: 'transcription', family: 'cohere-transcribe', hfId: 'onnx-community/cohere-transcribe-03-2026-ONNX', englishOnly: false, multilingual: true, sizeMb: 1540, ramCeilingMb: 3000, requiresWebGPU: true, timestamps: 'none', languages: { en: 3, zh: 3, ja: 3, yue: 0, tl: 0 } },
]

export function buildCatalog(): CatalogModel[] {
  return ENTRIES.map((e) => ({ ...e, available: true }))
}

function familyRank(m: CatalogModel): number {
  return FAMILY_ORDER.indexOf(m.family)
}

const TIER_MAX_RAM: Record<CapabilityReport['tier'], number> = {
  low: 700,
  medium: 1300,
  high: 4096,
}

/** Device- + language-adaptive Recommended Model (ADR-0003 / ADR-0007). */
export function recommendModel(
  catalog: CatalogModel[],
  cap: CapabilityReport,
  primary: PrimaryLanguage = 'en',
): CatalogModel | null {
  const english = primary === 'en'
  const maxRam = TIER_MAX_RAM[cap.tier]

  const usable = catalog.filter(
    (m) =>
      m.available &&
      m.task === 'transcription' &&
      m.ramCeilingMb <= maxRam &&
      (!m.requiresWebGPU || cap.webgpu) &&
      (primary === 'auto' ? m.multilingual : english ? m.englishOnly || m.multilingual : m.multilingual) &&
      (primary === 'auto' || english || (m.languages[primary] ?? 0) >= 1),
  )

  const ranked = usable.sort((a, b) => {
    const fr = familyRank(b) - familyRank(a)
    if (fr !== 0) return fr
    return english
      ? Number(b.englishOnly) - Number(a.englishOnly)
      : Number(b.multilingual) - Number(a.multilingual)
  })

  return ranked[0] ?? catalog.find((m) => m.available && m.task === 'transcription') ?? null
}

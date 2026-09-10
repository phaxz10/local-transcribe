import type { CapabilityReport, CatalogModel, PrimaryLanguage } from './types'

const FAMILY_ORDER: CatalogModel['family'][] = ['small', 'parakeet-ctc', 'large-v3-turbo']

type Entry = Omit<CatalogModel, 'available'>

/**
 * Catalog ids that used to exist, mapped to the hfId whose weights must be evicted when an old
 * install still has them cached. `store.init()` reads this; see the `small.en` note below.
 */
export const RETIRED: Record<string, string> = { 'small.en': 'Xenova/whisper-small.en' }

// ONNX models loaded by Transformers.js (ADR-0007). Sizes are approximate.
// Deliberately scoped to Small (the smallest tier that doesn't hallucinate/loop on hard audio)
// and Large v3 Turbo, the tiny/base tiers were dropped because they loop on real meetings.
// 2026-09: `small.en` was dropped too, it produced no usable transcript on real audio; English is
// now Parakeet CTC, which is non-autoregressive and so structurally cannot loop at all.
const ENTRIES: Entry[] = [
  // Non-autoregressive CTC: no decoder, no sampling, no repetition-hallucination by construction.
  // v4.2.0's ASR pipeline routes `parakeet_ctc` down the wav2vec2 branch, which returns text only,
  // so the worker aligns word timestamps from the CTC frames itself (see `transcribeCtc`).
  { id: 'parakeet-en', label: 'Parakeet (English)', task: 'transcription', family: 'parakeet-ctc', hfId: 'onnx-community/parakeet-ctc-0.6b-ONNX', englishOnly: true, multilingual: false, sizeMb: 612, ramCeilingMb: 1250, requiresWebGPU: false, languages: { en: 3 } },
  { id: 'small', label: 'Small', task: 'transcription', family: 'small', hfId: 'Xenova/whisper-small', englishOnly: false, multilingual: true, sizeMb: 520, ramCeilingMb: 1200, requiresWebGPU: false, languages: { en: 2, zh: 2, ja: 2, yue: 1, tl: 2 } },
  // We request word-level timestamps (return_timestamps: 'word'), which needs a decoder exported
  // WITH cross-attentions. The canonical `whisper-large-v3-turbo` export lacks them and throws
  // "Model outputs must contain cross attentions"; the `_timestamped` sibling is re-exported with
  // output_attentions=True (same q4/fp16 ONNX variants). Don't revert this id, it reintroduces the crash.
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', task: 'transcription', family: 'large-v3-turbo', hfId: 'onnx-community/whisper-large-v3-turbo_timestamped', englishOnly: false, multilingual: true, sizeMb: 1600, ramCeilingMb: 2400, requiresWebGPU: true, languages: { en: 3, zh: 3, ja: 3, yue: 2, tl: 2 } },
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

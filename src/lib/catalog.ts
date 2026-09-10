import type { CapabilityReport, CatalogModel, PrimaryLanguage } from './types'

// Better last. Parakeet CTC outranks small so English on a WASM/medium box lands on the model that
// cannot loop. Cohere Transcribe outranks both but sits BELOW turbo on purpose: it wins on WER but
// has no word timings, and click-to-seek is what people expect from the recommended default.
// It is a deliberate manual pick, not a recommendation.
const FAMILY_ORDER: CatalogModel['family'][] = [
  'small',
  'parakeet-ctc',
  'cohere-transcribe',
  'large-v3-turbo',
]

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
  { id: 'parakeet-en', label: 'Parakeet (English)', task: 'transcription', family: 'parakeet-ctc', hfId: 'onnx-community/parakeet-ctc-0.6b-ONNX', englishOnly: true, multilingual: false, sizeMb: 643, sizeMbWasm: 612, ramCeilingMb: 1250, requiresWebGPU: false, timestamps: 'word', languages: { en: 3 } },
  { id: 'small', label: 'Small', task: 'transcription', family: 'small', hfId: 'Xenova/whisper-small', englishOnly: false, multilingual: true, sizeMb: 520, ramCeilingMb: 1200, requiresWebGPU: false, languages: { en: 2, zh: 2, ja: 2, yue: 1, tl: 2 } },
  // We request word-level timestamps (return_timestamps: 'word'), which needs a decoder exported
  // WITH cross-attentions. The canonical `whisper-large-v3-turbo` export lacks them and throws
  // "Model outputs must contain cross attentions"; the `_timestamped` sibling is re-exported with
  // output_attentions=True (same q4/fp16 ONNX variants). Don't revert this id, it reintroduces the crash.
  // yue: 0, not 2. Turbo scores 43.3% CER on FLEURS Cantonese, a 4x regression against large-v3;
  // `small-yue` below is 7.93% CER at a quarter of the download (docs/research-asr-2026-09.md §1).
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', task: 'transcription', family: 'large-v3-turbo', hfId: 'onnx-community/whisper-large-v3-turbo_timestamped', englishOnly: false, multilingual: true, sizeMb: 1600, ramCeilingMb: 2400, requiresWebGPU: true, languages: { en: 3, zh: 3, ja: 3, yue: 0, tl: 2 } },
  // Cantonese specialist (alvanlii/whisper-small-cantonese). Two verified quirks:
  //  1. Its tokenizer is Whisper-v2's 99-language one (vocab 51865) and has NO `<|yue|>` token, so
  //     `language: 'cantonese'` would not resolve -> forceLanguage 'chinese'. `forced_decoder_ids`
  //     is null and there is no `lang_to_id`, so the argument is honoured, not ignored.
  //  2. The decoder ONNX exports no `cross_attentions` outputs (checked against the graph), so
  //     `return_timestamps: 'word'` throws and `transcribeOne`'s retry degrades it to chunk-level
  //     timings. Cantonese transcripts therefore have coarser word seeking than the others.
  // sizeMb is the WASM path (fp32 enc 353 + q8 dec 315 MB); WebGPU is 409 MB (fp16 + q4).
  { id: 'small-yue', label: 'Small (Cantonese)', task: 'transcription', family: 'small', hfId: 'onnx-community/whisper-small-cantonese-ONNX', englishOnly: false, multilingual: false, forceLanguage: 'chinese', sizeMb: 670, ramCeilingMb: 1200, requiresWebGPU: false, timestamps: 'chunk', languages: { yue: 3, zh: 1, en: 0, ja: 0, tl: 0 } },
  // #1 on the Open ASR Leaderboard (4.67 avg WER vs turbo's 6.36), Apache-2.0, and the same
  // download size as turbo. It emits NO timestamps of any kind and has no language auto-detect,
  // so word times are interpolated (ADR-0016) and `yue`/`tl` are 0 (the model doesn't speak them).
  // Measured q4f16: encoder 1436 MB + decoder 98 MB + configs ≈ 1536 MB.
  { id: 'cohere-transcribe', label: 'Cohere Transcribe', task: 'transcription', family: 'cohere-transcribe', hfId: 'onnx-community/cohere-transcribe-03-2026-ONNX', englishOnly: false, multilingual: true, sizeMb: 1540, ramCeilingMb: 3000, requiresWebGPU: true, timestamps: 'none', languages: { en: 3, zh: 3, ja: 3, yue: 0, tl: 0 } },
]

export function buildCatalog(): CatalogModel[] {
  return ENTRIES.map((e) => ({ ...e, available: true }))
}

/**
 * Whether `task: 'translate'` (foreign speech → English text) is available. It is a Whisper decoder
 * feature: Parakeet CTC has no decoder at all and Cohere Transcribe has no translate mode, and a
 * single-language fine-tune (`small-yue`, multilingual: false) was never trained for it.
 */
export function canTranslate(m: CatalogModel): boolean {
  return m.multilingual && !m.englishOnly && (m.family === 'small' || m.family === 'large-v3-turbo')
}

/** The ASR task to run: `translate` only when the user asked AND the model can. */
export function asrTask(m: CatalogModel, translate: boolean): 'transcribe' | 'translate' {
  return translate && canTranslate(m) ? 'translate' : 'transcribe'
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

  const gated = catalog.filter(
    (m) =>
      m.available &&
      m.task === 'transcription' &&
      m.ramCeilingMb <= maxRam &&
      (!m.requiresWebGPU || cap.webgpu) &&
      // For a specific non-English language, `!englishOnly` rather than `multilingual`: a
      // single-language fine-tune (small-yue) is neither, and the quality floor below is what
      // actually decides whether it fits.
      (primary === 'auto' ? m.multilingual : english ? m.englishOnly || m.multilingual : !m.englishOnly),
  )

  // If a model purpose-built for this language is in reach (rating 3), demand at least "ok" (2)
  // from everything else, so a generic model rated "limited" can't outrank it on family order
  // alone — which is how Cantonese users used to be steered at large-v3-turbo. No such model?
  // Fall back to the old floor of 1.
  const floor =
    primary === 'auto' || english ? 0 : gated.some((m) => (m.languages[primary] ?? 0) >= 3) ? 2 : 1
  const usable = gated.filter((m) => (m.languages[primary] ?? 0) >= floor)

  const ranked = usable.sort((a, b) => {
    const fr = familyRank(b) - familyRank(a)
    if (fr !== 0) return fr
    return english
      ? Number(b.englishOnly) - Number(a.englishOnly)
      : Number(b.multilingual) - Number(a.multilingual)
  })

  return ranked[0] ?? catalog.find((m) => m.available && m.task === 'transcription') ?? null
}

if (import.meta.env.DEV) {
  // Self-check for the recommendations this file exists to get right. Cheap, dev-only.
  const high = { tier: 'high', webgpu: true } as CapabilityReport
  const mediumWasm = { tier: 'medium', webgpu: false } as CapabilityReport
  const pick = (lang: PrimaryLanguage, cap: CapabilityReport = high) =>
    recommendModel(buildCatalog(), cap, lang)?.id
  console.assert(pick('yue') === 'small-yue', 'recommendModel(yue) should be small-yue, got', pick('yue'))
  console.assert(pick('en') === 'large-v3-turbo', 'recommendModel(en) should be large-v3-turbo, got', pick('en'))
  // English without WebGPU: Parakeet CTC, not Small. It is the reason small.en was retired.
  console.assert(
    pick('en', mediumWasm) === 'parakeet-en',
    'recommendModel(en, medium/wasm) should be parakeet-en, got',
    pick('en', mediumWasm),
  )

  // Cohere Transcribe is a manual pick, never a recommendation: it has no word timings at all, so
  // recommending it would silently take click-to-seek away from someone who never asked. Family
  // order is what holds this today; the sweep is here so a future re-order can't quietly break it.
  for (const tier of ['low', 'medium', 'high'] as const) {
    for (const webgpu of [false, true]) {
      const cap = { tier, webgpu } as CapabilityReport
      for (const lang of ['auto', 'en', 'zh', 'ja', 'yue', 'tl'] as PrimaryLanguage[]) {
        console.assert(
          pick(lang, cap) !== 'cohere-transcribe',
          `recommendModel(${lang}, ${tier}${webgpu ? '+webgpu' : ''}) must never be cohere-transcribe`,
        )
      }
    }
  }
}

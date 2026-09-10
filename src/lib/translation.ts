/**
 * Two-stage translation (ADR-0018): transcribe in the source language, then machine-translate each
 * Segment into English. Whisper's own `translate` task is not used — the Mandarin fine-tune loops
 * on it and large-v3-turbo just transcribes.
 *
 * Deliberately dependency-free so both the worker and the page can import it.
 */

/**
 * A source→English direction we ship. The three `*-en` values are Marian (Helsinki Opus-MT) pairs;
 * `'nllb'` is the 200-language fallback, which needs a FLORES source code alongside it.
 */
export type TranslationPair = 'zh-en' | 'ja-en' | 'ko-en' | 'nllb'

/** Opus-MT is 113 MB at q8, NLLB-200-distilled-600M ~900 MB. */
export function translationModelId(pair: TranslationPair): string {
  return pair === 'nllb' ? 'Xenova/nllb-200-distilled-600M' : `Xenova/opus-mt-${pair}`
}

/**
 * Every source language we can translate from, with the FLORES-200 code NLLB wants.
 *
 * `code` is the Primary Language / ISO code the Transcribe screen holds; `name` is the lowercase
 * Whisper language name a saved Transcript holds. Both are accepted as lookup keys.
 *
 * English is deliberately absent: it is the target, so there is nothing to translate.
 * // ponytail: the long tail past Tagalog is the set Whisper's auto-detect realistically returns
 * // for our users; NLLB knows 200 languages, so extending this list is one row each.
 */
export const TRANSLATION_SOURCES: { code: string; name: string; label: string; flores: string }[] = [
  { code: 'zh', name: 'chinese', label: 'Mandarin', flores: 'zho_Hans' },
  { code: 'yue', name: 'cantonese', label: 'Cantonese', flores: 'yue_Hant' },
  { code: 'ja', name: 'japanese', label: 'Japanese', flores: 'jpn_Jpan' },
  { code: 'ko', name: 'korean', label: 'Korean', flores: 'kor_Hang' },
  { code: 'tl', name: 'tagalog', label: 'Tagalog', flores: 'tgl_Latn' },
  { code: 'es', name: 'spanish', label: 'Spanish', flores: 'spa_Latn' },
  { code: 'fr', name: 'french', label: 'French', flores: 'fra_Latn' },
  { code: 'de', name: 'german', label: 'German', flores: 'deu_Latn' },
  { code: 'pt', name: 'portuguese', label: 'Portuguese', flores: 'por_Latn' },
  { code: 'it', name: 'italian', label: 'Italian', flores: 'ita_Latn' },
  { code: 'ru', name: 'russian', label: 'Russian', flores: 'rus_Cyrl' },
  { code: 'ar', name: 'arabic', label: 'Arabic', flores: 'arb_Arab' },
  { code: 'hi', name: 'hindi', label: 'Hindi', flores: 'hin_Deva' },
  { code: 'vi', name: 'vietnamese', label: 'Vietnamese', flores: 'vie_Latn' },
  { code: 'th', name: 'thai', label: 'Thai', flores: 'tha_Thai' },
  { code: 'id', name: 'indonesian', label: 'Indonesian', flores: 'ind_Latn' },
  { code: 'ms', name: 'malay', label: 'Malay', flores: 'zsm_Latn' },
  { code: 'tr', name: 'turkish', label: 'Turkish', flores: 'tur_Latn' },
  { code: 'pl', name: 'polish', label: 'Polish', flores: 'pol_Latn' },
  { code: 'nl', name: 'dutch', label: 'Dutch', flores: 'nld_Latn' },
  { code: 'el', name: 'greek', label: 'Greek', flores: 'ell_Grek' },
  { code: 'uk', name: 'ukrainian', label: 'Ukrainian', flores: 'ukr_Cyrl' },
  { code: 'cs', name: 'czech', label: 'Czech', flores: 'ces_Latn' },
  { code: 'sv', name: 'swedish', label: 'Swedish', flores: 'swe_Latn' },
  { code: 'da', name: 'danish', label: 'Danish', flores: 'dan_Latn' },
  { code: 'fi', name: 'finnish', label: 'Finnish', flores: 'fin_Latn' },
  { code: 'no', name: 'norwegian', label: 'Norwegian', flores: 'nob_Latn' },
  { code: 'he', name: 'hebrew', label: 'Hebrew', flores: 'heb_Hebr' },
  { code: 'fa', name: 'persian', label: 'Persian', flores: 'pes_Arab' },
  { code: 'ta', name: 'tamil', label: 'Tamil', flores: 'tam_Taml' },
  { code: 'bn', name: 'bengali', label: 'Bengali', flores: 'ben_Beng' },
  { code: 'ur', name: 'urdu', label: 'Urdu', flores: 'urd_Arab' },
]

const BY_KEY = new Map(TRANSLATION_SOURCES.flatMap((s) => [
  [s.code, s] as const,
  [s.name, s] as const,
]))

/** Opus-MT stays the default where it exists: 113 MB and 0.2 s beats 900 MB and slow. */
const OPUS: Record<string, TranslationPair> = { zh: 'zh-en', ja: 'ja-en', ko: 'ko-en' }

function sourceFor(language: string): (typeof TRANSLATION_SOURCES)[number] | undefined {
  return BY_KEY.get(language.toLowerCase())
}

/**
 * The direction to use for a language, or null when there is nothing to do (English, `auto`, or a
 * language NLLB has no FLORES code for here). Cantonese goes to NLLB, not `zh-en`: `yue_Hant`
 * actually knows written Cantonese, where Marian only ever saw Mandarin.
 */
export function translationPairFor(language: string): TranslationPair | null {
  const src = sourceFor(language)
  return src ? (OPUS[src.code] ?? 'nllb') : null
}

/** The FLORES-200 source code NLLB needs; null for the Opus-MT pairs, which don't take one. */
export function floresFor(language: string): string | null {
  return sourceFor(language)?.flores ?? null
}

/** Display name for a source language, for the "Translated to English from …" note. */
export function sourceLanguageLabel(language: string): string {
  return sourceFor(language)?.label ?? language
}

/** English needs no translation, under either the code or the Whisper name. */
export function isEnglish(language: string): boolean {
  const l = language.toLowerCase()
  return l === 'en' || l === 'english'
}

/** CJK ideographs + kana: scripts that don't separate words with spaces. */
const NO_SPACE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/

/**
 * Join a Segment's Words back into one sentence for the translator. Whisper emits Mandarin as
 * separate character runs, and gluing them with spaces fragments Marian's SentencePiece pieces,
 * so a space is only inserted where neither side is a no-space script.
 */
export function joinSegmentText(words: string[]): string {
  let out = ''
  for (const w of words) {
    if (!w) continue
    const glue = !out || NO_SPACE.test(w[0]) || NO_SPACE.test(out[out.length - 1])
    out += glue ? w : ` ${w}`
  }
  return out.trim()
}

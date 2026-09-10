/**
 * Two-stage translation (ADR-0018): transcribe in the source language, then machine-translate each
 * Segment into English. Whisper's own `translate` task is not used — the Mandarin fine-tune loops
 * on it and large-v3-turbo just transcribes.
 *
 * Deliberately dependency-free so both the worker and the page can import it.
 */
import type { PrimaryLanguage } from './types'

/** A Marian (Helsinki Opus-MT) direction we ship. English is always the target. */
export type TranslationPair = 'zh-en' | 'ja-en' | 'ko-en'

/** The HF repo for a pair. `Xenova/opus-mt-zh-en` is 113 MB at q8, `ja-en` ~108 MB. */
export function translationModelId(pair: TranslationPair): string {
  return `Xenova/opus-mt-${pair}`
}

/**
 * Keyed by BOTH the Primary Language code and the Whisper language name, because the Transcribe
 * screen holds a code (`zh`) and a saved Transcript holds a name (`chinese`).
 *
 * Cantonese maps to `zh-en` as a best effort: there is no `yue-en` Marian model, and Whisper
 * writes Cantonese speech out as written Chinese anyway, which is what `opus-mt-zh-en` reads.
 * Tagalog has no Opus-MT pair in the Xenova ONNX set at all, hence no entry (see ADR-0018).
 */
const PAIRS: Record<string, TranslationPair> = {
  zh: 'zh-en',
  chinese: 'zh-en',
  yue: 'zh-en',
  cantonese: 'zh-en',
  ja: 'ja-en',
  ko: 'ko-en',
  japanese: 'ja-en',
}

export function translationPairFor(language: PrimaryLanguage | string): TranslationPair | null {
  return PAIRS[language] ?? null
}

const LABELS: Record<string, string> = {
  zh: 'Mandarin',
  chinese: 'Mandarin',
  yue: 'Cantonese',
  cantonese: 'Cantonese',
  ja: 'Japanese',
  ko: 'Korean',
  korean: 'Korean',
  japanese: 'Japanese',
}

/** Display name for a source language, for the "Translated to English from …" note. */
export function sourceLanguageLabel(language: string): string {
  return LABELS[language] ?? language
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

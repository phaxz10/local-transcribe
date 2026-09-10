import type { ASRResult } from './engine'
import type { AsrLayer, AsrSegment, AsrWord, EditLayer, EditSegment, EditWord } from './types'
import { interpolateWords } from './interpolate-times'
import { uid } from './utils'

const SENTENCE_END = /[.!?。！？…]["'”’)\]]?$/

/** Build the immutable ASR layer from a Transformers.js word-timestamp result (ADR-0005). */
export function buildAsrLayer(
  out: ASRResult,
  language = 'auto',
  offsetSeconds = 0,
  task: AsrLayer['task'] = 'transcribe',
): AsrLayer {
  const words: AsrWord[] = []
  let prevEnd = 0
  for (const c of out.chunks ?? []) {
    const text = (c.text ?? '').trim()
    if (!text) continue
    const start = c.timestamp?.[0] ?? prevEnd
    const end = c.timestamp?.[1] ?? start + 0.2
    prevEnd = end
    // Transformers.js doesn't expose per-token probability → confidence unknown (=1).
    // Live ticks transcribe only the uncommitted tail, shift its times back onto the recording.
    words.push({ id: uid('w_'), text, start: start + offsetSeconds, end: end + offsetSeconds, confidence: 1 })
  }
  if (words.length === 0 && out.text?.trim()) {
    words.push({ id: uid('w_'), text: out.text.trim(), start: offsetSeconds, end: offsetSeconds + 0.5, confidence: 1 })
  }

  // Group words into segments on sentence punctuation, a long pause, or max length.
  const segments: AsrSegment[] = []
  let cur: AsrWord[] = []
  const flush = () => {
    if (!cur.length) return
    segments.push({
      id: uid('seg_'),
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      words: cur,
    })
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const next = words[i + 1]
    cur.push(w)
    const gap = next ? next.start - w.end : 0
    const tooLong = w.end - cur[0].start > 14
    if (SENTENCE_END.test(w.text) || gap > 0.8 || tooLong) flush()
  }
  flush()

  // Carry the VAD regions through so turn detection can measure real pauses, not word-time jitter.
  const speech = out.speech?.map((r) => ({
    start: r.start + offsetSeconds,
    end: r.end + offsetSeconds,
  }))
  return {
    segments,
    language,
    task,
    ...(speech?.length ? { speech } : {}),
    ...(out.timing ? { timing: out.timing } : {}),
  }
}

function deriveSegment(s: AsrSegment, timing: EditWord['timing']): EditSegment {
  return {
    id: uid('es_'),
    words: s.words.map((w) => ({
      id: uid('ew_'),
      text: w.text,
      origin: [w.id],
      start: w.start,
      end: w.end,
      timing,
    })),
  }
}

/** Derive the editable layer 1:1 from the ASR layer (timing = exact, unless it was manufactured). */
export function deriveEditLayer(asr: AsrLayer): EditLayer {
  const timing = asr.timing === 'interpolated' ? ('interpolated' as const) : ('exact' as const)
  return { segments: asr.segments.map((s) => deriveSegment(s, timing)) }
}

/**
 * Derive the Edit layer from a machine translation, one English string per ASR Segment (ADR-0018).
 *
 * The English words have no counterpart in the source, so `origin` is null and the times are spread
 * across the Segment's own span — `timing: 'interpolated'`, because they are manufactured. Seeking
 * lands on the right Segment, not the right word, and the UI already says timings are approximate.
 */
export function deriveTranslatedEditLayer(asr: AsrLayer, translations: string[]): EditLayer {
  return {
    segments: asr.segments.map((s, i) => {
      const words = interpolateWords(
        (translations[i] ?? '').trim(),
        [{ start: s.start, end: s.end }],
      )
      // Nothing came back (empty translation, or a zero-length Segment): keep the SOURCE words, so
      // a gap in the translation never silently deletes a line of the transcript.
      if (words.length === 0) return deriveSegment(s, 'interpolated')
      return {
        id: uid('es_'),
        words: words.map((w) => ({
          id: uid('ew_'),
          text: w.text,
          origin: null,
          start: w.timestamp[0],
          end: w.timestamp[1],
          timing: 'interpolated' as const,
        })),
      }
    }),
  }
}

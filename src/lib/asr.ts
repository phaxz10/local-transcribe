import type { ASRResult } from './engine'
import type { AsrLayer, AsrSegment, AsrWord, EditLayer } from './types'
import { uid } from './utils'

const SENTENCE_END = /[.!?。！？…]["'”’)\]]?$/

/** Build the immutable ASR layer from a Transformers.js word-timestamp result (ADR-0005). */
export function buildAsrLayer(out: ASRResult, language = 'auto', offsetSeconds = 0): AsrLayer {
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
  return { segments, language, task: 'transcribe', ...(speech?.length ? { speech } : {}) }
}

/** Derive the editable layer 1:1 from the ASR layer (timing = exact). */
export function deriveEditLayer(asr: AsrLayer): EditLayer {
  return {
    segments: asr.segments.map((s) => ({
      id: uid('es_'),
      words: s.words.map((w) => ({
        id: uid('ew_'),
        text: w.text,
        origin: [w.id],
        start: w.start,
        end: w.end,
        timing: 'exact' as const,
      })),
    })),
  }
}

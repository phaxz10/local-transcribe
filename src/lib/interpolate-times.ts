/**
 * Word-time interpolation for models that emit no timestamps at all (ADR-0016).
 *
 * Cohere Transcribe returns one string per chunk and nothing else. The two-layer transcript
 * (ADR-0005) is built on word times, so we manufacture them: spread the words across the chunk's
 * *speech* spans proportionally to character count. The times are approximate by construction and
 * the UI says so; what they must never do is put a word inside a silence gap.
 *
 * Deliberately dependency-free (no Transformers.js import) so `scripts/check-interpolate.mjs` can
 * run it under plain node.
 */

/** An absolute-seconds span of the recording that actually contains speech. */
export interface SpeechRegion {
  start: number
  end: number
}

export interface TimedWord {
  text: string
  timestamp: [number, number]
}

/** CJK ideographs + kana + halfwidth kana: scripts that don't separate words with spaces. */
const NO_SPACE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/
/** Characters per pseudo-word in a no-space script, so segments still form at a sane length. */
const RUN = 4

/** Whitespace split, except no-space scripts, which are cut into runs of at most `RUN` chars. */
export function splitWords(text: string): string[] {
  const out: string[] = []
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    if (!NO_SPACE.test(token)) {
      out.push(token)
      continue
    }
    const chars = [...token]
    for (let i = 0; i < chars.length; i += RUN) out.push(chars.slice(i, i + RUN).join(''))
  }
  return out
}

/**
 * Lay `text` out over `regions` (absolute seconds, in order), weighting each word by its length.
 *
 * Every word is assigned to exactly one region and timed inside it, so no word ever spans — or
 * lands in — the silence between regions. The first word starts at the first region's start and
 * the last word ends at the last region's end.
 */
export function interpolateWords(text: string, regions: SpeechRegion[]): TimedWord[] {
  const words = splitWords(text)
  const spans = regions.filter((r) => r.end > r.start)
  if (words.length === 0 || spans.length === 0) return []

  const weights = words.map((w) => Math.max([...w].length, 1))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const totalSeconds = spans.reduce((n, r) => n + (r.end - r.start), 0)

  // Cumulative fraction of speech time at each region's end, so a word's position along the
  // (silence-free) speech timeline picks its region.
  const bounds: number[] = []
  let elapsed = 0
  for (const r of spans) {
    elapsed += r.end - r.start
    bounds.push(elapsed / totalSeconds)
  }

  const owner: number[] = []
  let before = 0
  let lowest = 0
  for (let i = 0; i < words.length; i++) {
    const mid = (before + weights[i] / 2) / totalWeight
    before += weights[i]
    const found = bounds.findIndex((b) => mid < b)
    // Monotonic by construction: reading order must survive the assignment.
    lowest = Math.max(lowest, found < 0 ? spans.length - 1 : found)
    owner.push(lowest)
  }
  // Pin the ends so the transcript starts and stops where the speech does. Order matters: with a
  // single word the first-region pin wins, which is the honest answer (one word can't span a gap).
  owner[words.length - 1] = spans.length - 1
  owner[0] = 0

  const out: TimedWord[] = []
  for (let i = 0; i < words.length; ) {
    let j = i
    while (j < words.length && owner[j] === owner[i]) j++
    const r = spans[owner[i]]
    const span = r.end - r.start
    let groupWeight = 0
    for (let k = i; k < j; k++) groupWeight += weights[k]
    let at = 0
    for (let k = i; k < j; k++) {
      const start = r.start + (at / groupWeight) * span
      at += weights[k]
      // Snap the group's last word to the region end rather than trusting float accumulation.
      const end = k === j - 1 ? r.end : r.start + (at / groupWeight) * span
      out.push({ text: words[k], timestamp: [start, end] })
    }
    i = j
  }
  return out
}

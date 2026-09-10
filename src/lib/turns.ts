/**
 * Speaker turns, phase A (ADR-0017): pause-based turn detection plus the pure Edit-layer
 * operations the editor uses to assign speakers. No speaker model, no identity claim.
 *
 * Deliberately free of any zod / React import (types only), so plain Node can load it
 * (`scripts/check-turns.mjs`) the same way `vad-chunks.ts` does.
 */
import type { EditLayer, EditSegment } from './types'
import type { Region } from './vad-chunks'

/** A pause at least this long between Segments reads as a new turn. */
export const TURN_GAP_SECONDS = 1.0

/**
 * The silence between two instants. With VAD regions we measure the real pause: it runs from the
 * end of the region `a` falls inside to the start of the region `b` falls inside, so two Segments
 * inside one continuous region are never a turn however jittery their word times are. Word times
 * always sit *inside* a padded region, so regions can only tighten this estimate, never widen it.
 */
function pause(a: number, b: number, speech?: Region[]): number {
  if (!speech?.length) return b - a
  let from = a
  let to = b
  for (const r of speech) {
    if (r.start <= a && a <= r.end) from = r.end
    if (r.start <= b && b <= r.end) {
      to = r.start
      break
    }
  }
  return Math.max(0, to - from)
}

/**
 * Segment ids that begin a turn: the first Segment, plus every one preceded by a pause of at least
 * `TURN_GAP_SECONDS`. `buildAsrLayer` already cuts Segments at gaps over 0.8 s, so a turn is always
 * a run of whole consecutive Segments.
 */
export function turnStarts(segments: EditSegment[], speech?: Region[]): Set<string> {
  const starts = new Set<string>()
  let prevEnd: number | null = null
  for (const s of segments) {
    const start = s.words[0]?.start
    if (start == null) continue
    if (prevEnd == null || pause(prevEnd, start, speech) >= TURN_GAP_SECONDS) starts.add(s.id)
    prevEnd = s.words[s.words.length - 1]?.end ?? start
  }
  return starts
}

/**
 * Set `speakerId` on `segId` and every following Segment until one that already carries a
 * *different* speaker than `segId` had. That is how people label a dialog fast: fix the line where
 * the guess went wrong and the rest of that run follows.
 */
export function assignSpeakerForward(
  edit: EditLayer,
  segId: string,
  speakerId: string,
): EditLayer {
  const i = edit.segments.findIndex((s) => s.id === segId)
  if (i < 0) return edit
  const prior = edit.segments[i].speakerId
  const segments = [...edit.segments]
  for (let j = i; j < segments.length; j++) {
    if (j > i && segments[j].speakerId !== prior) break
    segments[j] = { ...segments[j], speakerId }
  }
  return { segments }
}

/** Dialog mode: alternate the two ids turn by turn, as an explicit starting guess. */
export function alternateByTurn(
  edit: EditLayer,
  ids: [string, string],
  starts: Set<string>,
): EditLayer {
  let turn = 0
  return {
    segments: edit.segments.map((s, i) => {
      if (i > 0 && starts.has(s.id)) turn++
      return { ...s, speakerId: ids[turn % 2] }
    }),
  }
}

/** Drop every speaker assignment (dialog mode off). */
export function clearSpeakers(edit: EditLayer): EditLayer {
  return {
    segments: edit.segments.map((s) => (s.speakerId == null ? s : { ...s, speakerId: undefined })),
  }
}

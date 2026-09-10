/**
 * Pure VAD post-processing: probability windows → speech regions → decode chunks.
 *
 * Deliberately free of any `@huggingface/transformers` import, so plain Node can load it
 * (`scripts/check-vad-chunking.mjs`) and the worker's only job is producing the probabilities.
 */

/** Seconds, absolute within the buffer the probabilities were measured over. */
export interface Region {
  start: number
  end: number
}

export interface PlannedChunk {
  startSeconds: number
  endSeconds: number
}

/** Whisper's receptive field is 30 s; 25 s leaves headroom for the padding the model adds. */
export const MAX_CHUNK_SECONDS = 25

/** Silero v5/v6 accepts exactly 512-sample windows at 16 kHz (32 ms). */
export const VAD_WINDOW_SAMPLES = 512

export const VAD_TUNING = {
  /** Hysteresis: open a region at 0.5, close it only once probability drops under 0.35. */
  onThreshold: 0.5,
  offThreshold: 0.35,
  minSpeechSeconds: 0.25,
  minSilenceSeconds: 0.4,
  padSeconds: 0.15,
  mergeGapSeconds: 0.4,
} as const

/** Fuse regions separated by less than `gapSeconds` of silence. Input must be sorted. */
export function mergeRegions(regions: Region[], gapSeconds = VAD_TUNING.mergeGapSeconds): Region[] {
  const out: Region[] = []
  for (const r of regions) {
    const last = out[out.length - 1]
    if (last && r.start - last.end < gapSeconds) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/**
 * Run the hysteresis state machine over per-window speech probabilities, then pad and merge.
 * `windowSeconds` is `VAD_WINDOW_SAMPLES / sampleRate`.
 */
export function regionsFromProbs(
  probs: ArrayLike<number>,
  windowSeconds: number,
  totalSeconds: number,
): Region[] {
  const t = VAD_TUNING
  const raw: Region[] = []
  let start = -1
  let silenceFrom = -1
  for (let i = 0; i < probs.length; i++) {
    const now = i * windowSeconds
    const p = probs[i]
    if (start < 0) {
      if (p >= t.onThreshold) {
        start = now
        silenceFrom = -1
      }
      continue
    }
    if (p >= t.offThreshold) {
      silenceFrom = -1 // still speech (hysteresis band keeps the region open)
      continue
    }
    if (silenceFrom < 0) silenceFrom = now
    if (now - silenceFrom < t.minSilenceSeconds) continue
    if (silenceFrom - start >= t.minSpeechSeconds) raw.push({ start, end: silenceFrom })
    start = -1
    silenceFrom = -1
  }
  if (start >= 0 && totalSeconds - start >= t.minSpeechSeconds) raw.push({ start, end: totalSeconds })

  const padded = raw.map((r) => ({
    start: Math.max(0, r.start - t.padSeconds),
    end: Math.min(totalSeconds, r.end + t.padSeconds),
  }))
  return mergeRegions(padded)
}

/**
 * Pack consecutive speech regions into decode chunks of at most `maxSeconds` of audio, cutting at
 * the longest silence rather than on a blind grid, so no chunk boundary lands mid-word.
 */
export function packChunks(regions: Region[], maxSeconds = MAX_CHUNK_SECONDS): PlannedChunk[] {
  const chunks: PlannedChunk[] = []
  for (let i = 0; i < regions.length; ) {
    const { start, end } = regions[i]

    if (end - start > maxSeconds) {
      // One unbroken region longer than a Whisper window: there is no silence inside it to cut on,
      // so split evenly. ponytail: the research doc suggests cutting on the lowest-probability
      // window instead; an even grid is the ceiling it explicitly allows and needs no extra state.
      const pieces = Math.ceil((end - start) / maxSeconds)
      const step = (end - start) / pieces
      for (let k = 0; k < pieces; k++) {
        chunks.push({
          startSeconds: start + k * step,
          endSeconds: k === pieces - 1 ? end : start + (k + 1) * step,
        })
      }
      i++
      continue
    }

    // Greedily take every following region that still fits in one chunk.
    let last = i
    while (last + 1 < regions.length && regions[last + 1].end - start <= maxSeconds) last++

    // Only when regions remain do we get to choose a boundary: take the longest silence among the
    // admissible cut points, but ignore ones that would leave a less-than-half-full chunk, so a
    // single early long pause can't shred the file into stubs.
    let cut = last
    if (last + 1 < regions.length) {
      let widest = -1
      for (let k = i; k <= last; k++) {
        if (k < last && regions[k].end - start < maxSeconds / 2) continue
        const gap = regions[k + 1].start - regions[k].end
        if (gap >= widest) {
          widest = gap
          cut = k
        }
      }
    }
    chunks.push({ startSeconds: start, endSeconds: regions[cut].end })
    i = cut + 1
  }
  return chunks
}

/** The old blind grid, kept as the fallback when the VAD is unavailable. */
export function gridChunks(totalSeconds: number, maxSeconds = MAX_CHUNK_SECONDS): PlannedChunk[] {
  const chunks: PlannedChunk[] = []
  for (let s = 0; s < totalSeconds; s += maxSeconds) {
    chunks.push({ startSeconds: s, endSeconds: Math.min(s + maxSeconds, totalSeconds) })
  }
  return chunks
}

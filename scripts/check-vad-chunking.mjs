/**
 * Runnable check for the pure VAD chunk packing (`src/lib/vad-chunks.ts`).
 *
 *   node scripts/check-vad-chunking.mjs            # Node >= 23.6 strips the types itself
 *   node --experimental-strip-types scripts/check-vad-chunking.mjs   # Node 22.6 - 23.5
 */
import assert from 'node:assert/strict'
import {
  MAX_CHUNK_SECONDS,
  mergeRegions,
  packChunks,
  regionsFromProbs,
} from '../src/lib/vad-chunks.ts'

const r = (start, end) => ({ start, end })
let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

check('regions that fit under 25 s pack into a single chunk', () => {
  const chunks = packChunks([r(0, 5), r(6, 11), r(13, 20)])
  assert.deepEqual(chunks, [{ startSeconds: 0, endSeconds: 20 }])
})

check('a 60 s region splits into pieces of at most 25 s', () => {
  const chunks = packChunks([r(0, 60)])
  assert.equal(chunks.length, 3)
  for (const c of chunks) assert.ok(c.endSeconds - c.startSeconds <= MAX_CHUNK_SECONDS)
  assert.equal(chunks[0].startSeconds, 0)
  assert.equal(chunks.at(-1).endSeconds, 60)
})

check('regions 300 ms apart merge; 500 ms apart do not', () => {
  assert.deepEqual(mergeRegions([r(0, 4), r(4.3, 8)]), [r(0, 8)])
  assert.deepEqual(mergeRegions([r(0, 4), r(4.5, 8)]), [r(0, 4), r(4.5, 8)])
})

check('an over-long run cuts at the longest silence, not at the fullest chunk', () => {
  // All four are 30 s of span, over the limit. Both 0-14 and 0-24 are legal chunks; the 6 s
  // silence after 14 s is the better boundary than the 0.5 s one after 24 s.
  const chunks = packChunks([r(0, 14), r(20, 24), r(24.5, 30)])
  assert.deepEqual(chunks, [
    { startSeconds: 0, endSeconds: 14 },
    { startSeconds: 20, endSeconds: 30 },
  ])
})

check('a cut that would leave a stub chunk is passed over', () => {
  // Cutting after the 10 s region would waste more than half a chunk, so 0-22 wins instead.
  const chunks = packChunks([r(0, 10), r(12, 22), r(22.5, 30)])
  assert.deepEqual(chunks, [
    { startSeconds: 0, endSeconds: 22 },
    { startSeconds: 22.5, endSeconds: 30 },
  ])
})

check('probabilities become padded, hysteresis-gated regions', () => {
  // 32 ms windows: 1 s silence, 2 s speech (dipping into the 0.35-0.5 band), 2 s silence.
  const w = 512 / 16000
  const probs = []
  for (let t = 0; t < 5; t += w) probs.push(t >= 1 && t < 3 ? (t > 2 && t < 2.2 ? 0.4 : 0.9) : 0.02)
  const regions = regionsFromProbs(probs, w, 5)
  assert.equal(regions.length, 1, 'the 0.4 dip must not split the region')
  assert.ok(Math.abs(regions[0].start - 0.85) < 0.05, `start ${regions[0].start} ~= 1 - 0.15 pad`)
  assert.ok(Math.abs(regions[0].end - 3.15) < 0.05, `end ${regions[0].end} ~= 3 + 0.15 pad`)
})

check('silence only yields no regions and therefore no chunks', () => {
  const w = 512 / 16000
  const probs = new Array(Math.floor(5 / w)).fill(0.01)
  assert.deepEqual(regionsFromProbs(probs, w, 5), [])
  assert.deepEqual(packChunks([]), [])
})

console.log(`\n${passed} checks passed`)

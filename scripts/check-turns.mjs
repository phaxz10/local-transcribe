/**
 * Runnable check for the pure speaker-turn logic (`src/lib/turns.ts`).
 *
 *   node scripts/check-turns.mjs            # Node >= 23.6 strips the types itself
 *   node --experimental-strip-types scripts/check-turns.mjs   # Node 22.6 - 23.5
 */
import assert from 'node:assert/strict'
import {
  TURN_GAP_SECONDS,
  alternateByTurn,
  assignSpeakerForward,
  clearSpeakers,
  turnStarts,
} from '../src/lib/turns.ts'

/** Segments back to back with the given gaps between them, each 1 s of speech. */
const build = (gaps) => {
  const segs = []
  let t = 0
  for (let i = 0; i <= gaps.length; i++) {
    if (i > 0) t += gaps[i - 1]
    segs.push({ id: `s${i}`, words: [{ id: `w${i}`, text: 'x', origin: null, start: t, end: t + 1, timing: 'exact' }] })
    t += 1
  }
  return segs
}
const ids = (set) => [...set].sort()

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

check('the first segment always starts a turn', () => {
  assert.deepEqual(ids(turnStarts(build([0.1, 0.1]))), ['s0'])
  assert.deepEqual(ids(turnStarts([])), [])
})

check(`a gap of exactly ${TURN_GAP_SECONDS} s starts a turn, just under does not`, () => {
  assert.deepEqual(ids(turnStarts(build([1.0]))), ['s0', 's1'])
  assert.deepEqual(ids(turnStarts(build([0.999]))), ['s0'])
})

check('the brief given seed: gaps 0.3 / 1.5 / 0.2 / 2.0 / 0.4 give three turns', () => {
  assert.deepEqual(ids(turnStarts(build([0.3, 1.5, 0.2, 2.0, 0.4]))), ['s0', 's2', 's4'])
})

check('speech regions override word times: one region spanning a 1.5 s word gap is one turn', () => {
  const segs = build([1.5])
  // Both segments sit inside a single continuous region -> no pause at all.
  assert.deepEqual(ids(turnStarts(segs, [{ start: 0, end: 3.5 }])), ['s0'])
  // Two regions with a real 1.4 s silence between them -> a turn, same word times.
  assert.deepEqual(
    ids(turnStarts(segs, [{ start: 0, end: 1.05 }, { start: 2.45, end: 3.5 }])),
    ['s0', 's1'],
  )
})

check('regions tighten a gap below the threshold', () => {
  // Word gap is 1.2 s but the VAD says speech ran to 2.0 and resumed at 2.2: only 0.2 s of silence.
  const segs = build([1.2])
  assert.deepEqual(ids(turnStarts(segs, [{ start: 0, end: 2.0 }, { start: 2.2, end: 3.2 }])), ['s0'])
})

check('assign forward stops at the next segment with a different speaker', () => {
  const edit = { segments: [
    { id: 'a', words: [], speakerId: 'spk_1' },
    { id: 'b', words: [], speakerId: 'spk_1' },
    { id: 'c', words: [], speakerId: 'spk_2' },
    { id: 'd', words: [], speakerId: 'spk_1' },
  ] }
  const out = assignSpeakerForward(edit, 'a', 'spk_9')
  assert.deepEqual(out.segments.map((s) => s.speakerId), ['spk_9', 'spk_9', 'spk_2', 'spk_1'])
  // Unassigned runs count as one run too.
  const blank = { segments: [{ id: 'a', words: [] }, { id: 'b', words: [] }, { id: 'c', words: [], speakerId: 'x' }] }
  assert.deepEqual(
    assignSpeakerForward(blank, 'a', 'spk_1').segments.map((s) => s.speakerId),
    ['spk_1', 'spk_1', 'x'],
  )
})

check('assign forward leaves earlier segments and unknown ids alone', () => {
  const edit = { segments: [{ id: 'a', words: [] }, { id: 'b', words: [] }] }
  assert.deepEqual(
    assignSpeakerForward(edit, 'b', 'spk_1').segments.map((s) => s.speakerId),
    [undefined, 'spk_1'],
  )
  assert.equal(assignSpeakerForward(edit, 'nope', 'spk_1'), edit)
})

check('dialog mode alternates per turn, and clearing drops every assignment', () => {
  const segs = build([0.3, 1.5, 0.2, 2.0, 0.4])
  const edit = { segments: segs }
  const dialog = alternateByTurn(edit, ['spk_1', 'spk_2'], turnStarts(segs))
  assert.deepEqual(dialog.segments.map((s) => s.speakerId), [
    'spk_1', 'spk_1', 'spk_2', 'spk_2', 'spk_1', 'spk_1',
  ])
  assert.deepEqual(clearSpeakers(dialog).segments.map((s) => s.speakerId), new Array(6).fill(undefined))
})

console.log(`\n${passed} checks passed`)

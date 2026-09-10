/**
 * Invariant check for `src/lib/interpolate-times.ts` (ADR-0016).
 *
 * There is no test runner in this repo, so this is a plain node script:
 * `node scripts/check-interpolate.mjs`. It imports the TypeScript module directly — node strips
 * types itself (>= 22.18) and `interpolate-times.ts` is deliberately dependency-free so nothing
 * has to be built or mocked.
 */
import { splitWords, interpolateWords } from '../src/lib/interpolate-times.ts'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const EPS = 1e-9
const inSomeRegion = (w, regions) =>
  regions.some((r) => w.timestamp[0] >= r.start - EPS && w.timestamp[1] <= r.end + EPS)

/* ── 1. English across VAD speech regions with a big silence gap ───────────── */
{
  const regions = [
    { start: 10, end: 14 },
    { start: 20, end: 23 },
  ]
  const text = 'the quick brown fox jumps over the lazy dog and keeps running past the fence'
  const out = interpolateWords(text, regions)

  check('every word count preserved', out.length === text.split(' ').length, `got ${out.length}`)
  check('order preserved', out.map((w) => w.text).join(' ') === text)
  check(
    'no word falls in the silence gap',
    out.every((w) => inSomeRegion(w, regions)),
    JSON.stringify(out.filter((w) => !inSomeRegion(w, regions))),
  )
  check(
    'times are monotonic and non-inverted',
    out.every((w, i) => w.timestamp[1] >= w.timestamp[0] && (i === 0 || w.timestamp[0] >= out[i - 1].timestamp[1] - EPS)),
  )
  check('first word starts at the first region start', Math.abs(out[0].timestamp[0] - 10) < EPS)
  check(
    'last word ends at the last region end',
    Math.abs(out[out.length - 1].timestamp[1] - 23) < EPS,
    `got ${out[out.length - 1].timestamp[1]}`,
  )
  check('both regions are actually used', new Set(out.map((w) => (w.timestamp[0] < 20 ? 'a' : 'b'))).size === 2)
}

/* ── 2. CJK: no spaces, so runs of at most 4 characters ────────────────────── */
{
  const text = '今天天氣很好我們一起去公園散步吧'
  const words = splitWords(text)
  check('CJK is split into runs', words.length === Math.ceil([...text].length / 4), `got ${words.length}`)
  check('CJK runs are at most 4 chars', words.every((w) => [...w].length <= 4))
  check('CJK split is lossless', words.join('') === text)

  const regions = [
    { start: 0, end: 2 },
    { start: 5, end: 9 },
  ]
  const out = interpolateWords(text, regions)
  check('CJK words all land in speech', out.every((w) => inSomeRegion(w, regions)))
  check('CJK first word starts at speech start', Math.abs(out[0].timestamp[0] - 0) < EPS)
  check('CJK last word ends at speech end', Math.abs(out[out.length - 1].timestamp[1] - 9) < EPS)
}

/* ── 3. Mixed Latin + CJK in one string ────────────────────────────────────── */
{
  const words = splitWords('hello 你好世界你好世界 world')
  check('mixed split keeps latin tokens whole', words[0] === 'hello' && words[words.length - 1] === 'world')
  // 'hello' + two 4-char runs from the 8-char CJK token + 'world'.
  check('mixed split cuts the CJK run', words.length === 4, JSON.stringify(words))
}

/* ── 4. Degenerate inputs must not throw or invent words ───────────────────── */
{
  check('empty text yields nothing', interpolateWords('   ', [{ start: 0, end: 1 }]).length === 0)
  check('no regions yields nothing', interpolateWords('hello there', []).length === 0)
  check('zero-length regions are dropped', interpolateWords('hello', [{ start: 1, end: 1 }]).length === 0)
  const one = interpolateWords('hello', [{ start: 2, end: 4 }])
  check('a single word fills its single region', one.length === 1 && one[0].timestamp[0] === 2 && one[0].timestamp[1] === 4)
}

/* ── 5. More regions than words: still silence-free and ordered ────────────── */
{
  const regions = [
    { start: 0, end: 1 },
    { start: 10, end: 11 },
    { start: 20, end: 21 },
  ]
  const out = interpolateWords('alpha beta', regions)
  check('sparse case stays in speech', out.every((w) => inSomeRegion(w, regions)))
  check('sparse case keeps order', out.map((w) => w.text).join(' ') === 'alpha beta')
}

console.log(failures === 0 ? '\nall interpolation invariants hold' : `\n${failures} failing check(s)`)
process.exit(failures === 0 ? 0 : 1)

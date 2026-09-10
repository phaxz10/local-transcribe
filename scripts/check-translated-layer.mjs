/**
 * Invariant check for `deriveTranslatedEditLayer` in `src/lib/asr.ts` (ADR-0018).
 *
 * There is no test runner in this repo, so this is a plain node script:
 * `node scripts/check-translated-layer.mjs`. `asr.ts` deliberately imports no Transformers.js, so
 * node's own type stripping is enough; the one thing it can't do is the bundler's extensionless
 * specifiers (`./utils`), hence the tiny resolve hook below.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    const bare = specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)
    return next(bare ? `${specifier}.ts` : specifier, context)
  },
})

const { deriveTranslatedEditLayer } = await import('../src/lib/asr.ts')

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
const word = (id, text, start, end) => ({ id, text, start, end, confidence: 1 })

/** Two Mandarin segments plus one the translator returned nothing for. */
const asr = {
  language: 'chinese',
  task: 'transcribe',
  segments: [
    {
      id: 'seg_1',
      start: 1,
      end: 3,
      words: [word('w1', '今天天气', 1, 2), word('w2', '很好', 2, 3)],
    },
    {
      id: 'seg_2',
      start: 10,
      end: 14.5,
      words: [word('w3', '我们下午', 10, 12), word('w4', '去公园散步吧', 12, 14.5)],
    },
    { id: 'seg_3', start: 20, end: 21, words: [word('w5', '嗯', 20, 21)] },
  ],
}
const translations = [
  'The weather is nice today',
  "Let's go for a walk in the park this afternoon",
  '',
]

const edit = deriveTranslatedEditLayer(asr, translations)

check('one Edit segment per ASR segment', edit.segments.length === asr.segments.length)

/* ── 1. Word counts match the English, not the source ──────────────────────── */
for (let i = 0; i < 2; i++) {
  const expected = translations[i].split(/\s+/).filter(Boolean).length
  check(
    `segment ${i + 1} has one word per English word (${expected})`,
    edit.segments[i].words.length === expected,
    `got ${edit.segments[i].words.length}`,
  )
  check(
    `segment ${i + 1} text round-trips`,
    edit.segments[i].words.map((w) => w.text).join(' ') === translations[i],
    edit.segments[i].words.map((w) => w.text).join(' '),
  )
}

/* ── 2. Times stay inside the segment span, ordered ────────────────────────── */
for (let i = 0; i < asr.segments.length; i++) {
  const seg = asr.segments[i]
  const ws = edit.segments[i].words
  check(
    `segment ${i + 1} words stay inside [${seg.start}, ${seg.end}]`,
    ws.every((w) => w.start >= seg.start - EPS && w.end <= seg.end + EPS),
    JSON.stringify(ws.filter((w) => w.start < seg.start - EPS || w.end > seg.end + EPS)),
  )
  check(
    `segment ${i + 1} times are monotonic and non-inverted`,
    ws.every((w, k) => w.end >= w.start && (k === 0 || w.start >= ws[k - 1].end - EPS)),
  )
  check(
    `segment ${i + 1} spans the whole segment`,
    Math.abs(ws[0].start - seg.start) < EPS && Math.abs(ws[ws.length - 1].end - seg.end) < EPS,
    `${ws[0].start}..${ws[ws.length - 1].end}`,
  )
}

/* ── 3. An empty translation keeps the SOURCE words ────────────────────────── */
{
  const ws = edit.segments[2].words
  check('empty translation keeps the source words', ws.map((w) => w.text).join('') === '嗯')
  check('kept source words still map back to their origin', ws.every((w) => w.origin?.[0] === 'w5'))
}

/* ── 4. Timing + origin are honest everywhere ──────────────────────────────── */
check(
  'every word is flagged interpolated',
  edit.segments.every((s) => s.words.every((w) => w.timing === 'interpolated')),
)
check(
  'translated words have no ASR origin',
  edit.segments.slice(0, 2).every((s) => s.words.every((w) => w.origin === null)),
)
check(
  'every word id is unique',
  new Set(edit.segments.flatMap((s) => s.words.map((w) => w.id))).size ===
    edit.segments.reduce((n, s) => n + s.words.length, 0),
)

/* ── 5. Degenerate inputs must not throw or drop lines ─────────────────────── */
{
  const none = deriveTranslatedEditLayer(asr, [])
  check(
    'a missing translation array keeps every segment (source text)',
    none.segments.length === 3 && none.segments.every((s) => s.words.length > 0),
  )
  const zeroSpan = deriveTranslatedEditLayer(
    { ...asr, segments: [{ id: 's', start: 5, end: 5, words: [word('w', '好', 5, 5)] }] },
    ['good'],
  )
  check(
    'a zero-length segment falls back to its source word',
    zeroSpan.segments[0].words.length === 1 && zeroSpan.segments[0].words[0].text === '好',
  )
  check('no segments in, no segments out', deriveTranslatedEditLayer({ ...asr, segments: [] }, []).segments.length === 0)
}

console.log(failures === 0 ? '\nall translated-layer invariants hold' : `\n${failures} failing check(s)`)
process.exit(failures === 0 ? 0 : 1)

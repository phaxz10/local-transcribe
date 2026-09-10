/**
 * RIFF/WAVE in and out for the Live Session's own PCM: 16-bit mono 16 kHz, nothing else.
 *
 * ponytail: WAV is ~4x the size of Opus (1.9 MB/min); swap to a MediaRecorder sidecar if storage
 * complaints appear.
 */

const SAMPLE_RATE = 16000

export function pcmToWav(chunks: Int16Array[]): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buf = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buf)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + total * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, total * 2, true)

  const out = new Int16Array(buf, 44, total)
  let w = 0
  for (const c of chunks) {
    out.set(c, w)
    w += c.length
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/** Read back a WAV we wrote (16-bit mono 16 kHz assumed); walks chunks to find `data`. */
export function wavToPcm(buf: ArrayBuffer): Int16Array {
  const view = new DataView(buf)
  const tag = (o: number) =>
    String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return new Int16Array(0)
  let o = 12
  while (o + 8 <= buf.byteLength) {
    const id = tag(o)
    const size = view.getUint32(o + 4, true)
    if (id === 'data') {
      const end = Math.min(o + 8 + size, buf.byteLength)
      return new Int16Array(buf.slice(o + 8, end - ((end - o - 8) % 2)))
    }
    o += 8 + size + (size % 2)
  }
  return new Int16Array(0)
}

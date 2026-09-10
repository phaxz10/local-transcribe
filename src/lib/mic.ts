/**
 * Microphone tap: raw 16 kHz mono Int16 PCM frames, straight off an AudioWorklet.
 *
 * No MediaRecorder and no ffmpeg on the live path, the Engine wants Int16 @ 16 kHz and that is
 * exactly what comes out here, so an interim tick is just a slice of an array.
 */

// No ScriptProcessor fallback: AudioWorklet is Safari 14.1+ and every evergreen browser.
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.pos = 0        // fractional read position, in input samples, relative to block start
    this.prev = 0       // last sample of the previous block (index -1 of this one)
    this.out = new Int16Array(4096)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || ch.length === 0) return true
    const N = ch.length
    let pos = this.pos
    while (pos < N - 1) {
      const i = Math.floor(pos)
      const frac = pos - i
      const a = i < 0 ? this.prev : ch[i]
      const b = ch[i + 1]
      let v = (a + (b - a) * frac) * 32767
      if (v > 32767) v = 32767
      else if (v < -32768) v = -32768
      this.out[this.n++] = v
      if (this.n === this.out.length) {
        const frame = this.out
        this.port.postMessage(frame, [frame.buffer])
        this.out = new Int16Array(4096)
        this.n = 0
      }
      pos += this.ratio
    }
    this.prev = ch[N - 1]
    this.pos = pos - N
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

export interface Capture {
  stop(): Promise<void>
}

/** Open the mic and stream 16 kHz Int16 frames to `onFrame`. Call inside a user gesture (iOS). */
export async function startCapture(onFrame: (pcm: Int16Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  })
  // Default rate on purpose: Safari's MediaStreamAudioSourceNode does not resample into a
  // context that was constructed at 16 kHz, we resample in the worklet instead.
  const ctx = new AudioContext()
  await ctx.resume()

  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-tap')
  node.port.onmessage = (e: MessageEvent<Int16Array>) => onFrame(e.data)
  // Muted sink: Chrome stops pulling a graph that reaches no destination.
  const gain = ctx.createGain()
  gain.gain.value = 0
  source.connect(node)
  node.connect(gain)
  gain.connect(ctx.destination)

  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      // ponytail: we drop the < 256 ms still buffered inside the worklet rather than adding a
      // flush round-trip, it is below one word of audio.
      node.port.onmessage = null
      try {
        source.disconnect()
        node.disconnect()
        gain.disconnect()
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((t) => t.stop())
      await ctx.close().catch(() => {})
    },
  }
}

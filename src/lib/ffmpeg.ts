import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { CancelledError, throwIfCancelled } from './cancel'

let instance: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null
let progressCb: ((ratio: number) => void) | null = null

/**
 * ffmpeg.wasm (multi-threaded core, self-hosted from /public/ffmpeg so it loads
 * same-origin and satisfies COEP). Universal container/codec coverage (ADR-0002).
 */
async function getFFmpeg(signal?: AbortSignal): Promise<FFmpeg> {
  if (instance) return instance
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const ff = new FFmpeg()
    ff.on('progress', ({ progress }) => {
      if (progressCb) progressCb(Math.min(1, Math.max(0, progress)))
    })
    // Load the self-hosted core via blob URLs so Vite doesn't try to transform
    // the emscripten glue as an ES module (the `?import` interception bug).
    const base = '/ffmpeg'
    await ff.load(
      {
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
        workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript'),
      },
      { signal },
    )
    instance = ff
    return ff
  })()
  return loadPromise
}

function preloadFFmpeg(): Promise<unknown> {
  return getFFmpeg()
}

function isFFmpegLoaded(): boolean {
  return instance !== null
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(-60) || 'input'
}

function resetFFmpeg(ff: FFmpeg): void {
  ff.terminate()
  if (instance === ff) instance = null
  loadPromise = null
}

async function mountInput(
  ff: FFmpeg,
  file: File,
  signal?: AbortSignal,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const mountPoint = `/input_${Date.now()}`
  try {
    await ff.createDir(mountPoint, { signal })
    await ff.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint)
    return {
      path: `${mountPoint}/${file.name}`,
      cleanup: async () => {
        try {
          await ff.unmount(mountPoint)
          await ff.deleteDir(mountPoint)
        } catch {
          /* ignore */
        }
      },
    }
  } catch {
    try {
      await ff.deleteDir(mountPoint, { signal })
    } catch {
      /* ignore */
    }
  }

  const inName = 'in_' + sanitize(file.name)
  await ff.writeFile(inName, await fetchFile(file), { signal })
  return {
    path: inName,
    cleanup: async () => {
      try {
        await ff.deleteFile(inName)
      } catch {
        /* ignore */
      }
    },
  }
}

/** Decode any audio/video File into 16 kHz mono Int16 PCM (2 bytes/sample, not 4). */
export async function decodeToPcm16(
  file: File,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<{ pcm: Int16Array; durationSec: number }> {
  throwIfCancelled(signal, 'Transcription stopped')
  const ff = await getFFmpeg(signal)
  const outName = 'out.s16le'
  let input: { path: string; cleanup: () => Promise<void> } | null = null

  progressCb = onProgress ?? null
  const onAbort = () => resetFFmpeg(ff)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    throwIfCancelled(signal, 'Transcription stopped')
    input = await mountInput(ff, file, signal)
    // Mono, 16 kHz, signed 16-bit little-endian raw PCM. Half the bytes of f32le; the engine
    // converts each ≤25 s chunk to Float32 right before inference.
    await ff.exec(
      [
        '-i', input.path,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        outName,
      ],
      -1,
      { signal },
    )
    throwIfCancelled(signal, 'Transcription stopped')
    const data = (await ff.readFile(outName, 'binary', { signal })) as Uint8Array
    // `readFile`'s buffer is in the ffmpeg worker's postMessage transfer list, so this page already
    // owns it, view it in place rather than copying. (Only re-copy in the pathological case of a
    // misaligned byteOffset, which an Int16Array view cannot straddle.)
    const usableLen = Math.floor(data.byteLength / 2)
    const pcm =
      data.byteOffset % 2 === 0
        ? new Int16Array(data.buffer, data.byteOffset, usableLen)
        : new Int16Array(data.slice(0, usableLen * 2).buffer)
    return { pcm, durationSec: pcm.length / 16000 }
  } catch (e) {
    if (signal?.aborted) throw new CancelledError('Transcription stopped')
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
    progressCb = null
    await input?.cleanup()
    try {
      await ff.deleteFile(outName)
    } catch {
      /* ignore */
    }
  }
}

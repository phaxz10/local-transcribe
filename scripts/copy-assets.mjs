// Copies self-hosted runtime assets into public/ so they load same-origin
// (avoids COEP/CORP issues with CDN-hosted ffmpeg core).
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const out = join(root, 'public')

function copyInto(srcDir, destDir, files) {
  if (!existsSync(srcDir)) {
    console.warn(`[copy-assets] missing ${srcDir} — skipping`)
    return
  }
  mkdirSync(destDir, { recursive: true })
  const present = new Set(readdirSync(srcDir))
  for (const f of files) {
    if (present.has(f)) copyFileSync(join(srcDir, f), join(destDir, f))
  }
}

try {
  // ffmpeg multi-threaded core → public/ffmpeg
  copyInto(
    join(root, 'node_modules/@ffmpeg/core-mt/dist/esm'),
    join(out, 'ffmpeg'),
    ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'],
  )
  console.log('[copy-assets] done')
} catch (err) {
  console.warn('[copy-assets] non-fatal error:', err?.message ?? err)
}

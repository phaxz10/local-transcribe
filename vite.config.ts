import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Cross-origin isolation headers — required for SharedArrayBuffer (whisper.cpp
// + ffmpeg threads). Applied to both dev and preview servers (ADR-0001).
function crossOriginIsolation(): Plugin {
  const headers = (res: { setHeader(k: string, v: string): void }) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  }
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => (headers(res), next()))
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => (headers(res), next()))
    },
  }
}

// `public/sw.js` ships with `self.__PRECACHE__` / `self.__BUILD_ID__` placeholders because the
// hashed filenames only exist after the bundle is written. Rewrite them in place.
function appShellPrecache(): Plugin {
  return {
    name: 'app-shell-precache',
    apply: 'build',
    closeBundle() {
      const dist = path.resolve(import.meta.dirname, 'dist')
      const sw = path.join(dist, 'sw.js')
      if (!fs.existsSync(sw)) return
      const dirFiles = (dir: string, keep: (f: string) => boolean) => {
        const abs = path.join(dist, dir)
        if (!fs.existsSync(abs)) return []
        return fs.readdirSync(abs).filter(keep).sort().map((f) => `/${dir}/${f}`)
      }
      const files = [
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/favicon.svg',
        ...dirFiles('assets', (f) => /\.(js|css|wasm|woff2)$/.test(f)),
        ...dirFiles('ffmpeg', () => true),
      ].filter((f) => f === '/' || fs.existsSync(path.join(dist, f)))
      const buildId = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12)
      const src = fs
        .readFileSync(sw, 'utf8')
        .replace('self.__PRECACHE__', JSON.stringify(files))
        .replace('self.__BUILD_ID__', JSON.stringify(buildId))
      fs.writeFileSync(sw, src)
      this.info?.(`app-shell-precache: ${files.length} files, build ${buildId}`)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), crossOriginIsolation(), appShellPrecache()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // ffmpeg.wasm ships its own workers; let Vite serve it untouched.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})

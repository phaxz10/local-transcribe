/**
 * Document Picture-in-Picture companion window. Chrome/Edge only; everywhere else `supportsPip()`
 * is false and the UI hides the entry point.
 *
 * The Window object is module-level (non-reactive) exactly like the job abort handle, the store
 * only carries the boolean.
 */

import { BRAND } from './brand'
import { useApp } from './store'

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options?: { width?: number; height?: number }): Promise<Window>
    }
  }
}

let pipWindow: Window | null = null

export function supportsPip(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window
}

export function getPipWindow(): Window | null {
  return pipWindow
}

/** Open the companion window and copy the app's styles into it. Must run in a user gesture. */
export async function openPipWindow(onClose: () => void): Promise<Window> {
  if (pipWindow) return pipWindow
  const api = window.documentPictureInPicture
  if (!api) throw new Error('Document Picture-in-Picture is not supported in this browser.')
  const w = await api.requestWindow({ width: 380, height: 280 })

  // Chrome's documented recipe: inline what we can read, re-link what CORS hides.
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('')
      const style = document.createElement('style')
      style.textContent = css
      w.document.head.appendChild(style)
    } catch {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href ?? ''
      link.media = String(sheet.media ?? '')
      w.document.head.appendChild(link)
    }
  }
  w.document.documentElement.className = document.documentElement.className
  w.document.body.className = 'bg-background text-foreground'
  w.document.title = `${BRAND.name} live transcript`

  w.addEventListener(
    'pagehide',
    () => {
      pipWindow = null
      onClose()
    },
    { once: true },
  )
  pipWindow = w
  return w
}

export function closePipWindow(): void {
  const w = pipWindow
  pipWindow = null
  w?.close()
}

/* ── Automatic picture-in-picture ─────────────────────────────────────────── */

/** True while the window on screen was opened by the tab losing focus, not by the user. */
let autoOpened = false

/** `enterpictureinpicture` is Chrome-only, so it is not in the DOM lib's action union yet. */
function mediaSession():
  | (MediaSession & { setActionHandler(a: string, h: (() => void) | null): void })
  | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null
  return navigator.mediaSession as MediaSession & {
    setActionHandler(a: string, h: (() => void) | null): void
  }
}

/** Open silently and remember whether the window is ours to close again. */
async function autoOpen(): Promise<void> {
  if (pipWindow) return // a window the user opened by hand is theirs to close
  await useApp.getState().openPip(true)
  autoOpened = !!pipWindow
}

/**
 * The Media Session route into Document PiP: while the page is capturing the microphone Chrome
 * fires `enterpictureinpicture` as the tab hides, and the handler may open a window with no user
 * activation. Registering it is the whole opt-in, so it has to happen before the tab is hidden.
 */
export function syncAutoPip(eligible: boolean): void {
  const ms = mediaSession()
  if (!ms) return
  try {
    ms.setActionHandler(
      'enterpictureinpicture',
      eligible && supportsPip() ? () => void autoOpen() : null,
    )
  } catch {
    // Engines without the action throw; there is nothing to fall back to.
  }
}

/** Tell the OS a recording is in progress, which is what makes ours an active media session. */
export function syncMediaSession(recording: boolean): void {
  const ms = mediaSession()
  if (!ms) return
  try {
    ms.metadata = recording ? new MediaMetadata({ title: `${BRAND.name}: recording` }) : null
    ms.playbackState = recording ? 'playing' : 'none'
  } catch {
    // Metadata is a nicety; losing it never breaks the session.
  }
}

/**
 * The blur/focus half: hide the tab and the window follows, come back and it goes away again.
 * Returns a teardown.
 */
export function installAutoPip(eligible: () => boolean): () => void {
  const onBack = () => {
    if (!autoOpened) return
    autoOpened = false
    useApp.getState().closePip()
  }
  const onVisibility = () => {
    if (!document.hidden) return onBack()
    if (!eligible() || pipWindow || !supportsPip()) return
    // ponytail: Chrome grants activation-free open only while capturing the mic; idle Transcribe
    // page auto-open works only where the browser allows it.
    void autoOpen()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onBack)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onBack)
  }
}

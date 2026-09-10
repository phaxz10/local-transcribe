/**
 * Document Picture-in-Picture companion window. Chrome/Edge only; everywhere else `supportsPip()`
 * is false and the UI hides the entry point.
 *
 * The Window object is module-level (non-reactive) exactly like the job abort handle, the store
 * only carries the boolean.
 */

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
  w.document.title = 'Live transcript'

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

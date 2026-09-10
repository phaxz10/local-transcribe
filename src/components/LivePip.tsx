import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp, liveText } from '@/lib/store'
import { getPipWindow } from '@/lib/pip'
import { formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * The Document PiP companion. Mounted once, outside <main>, so it survives every view change , 
 * and because the store owns the Live Session, its buttons work while the main tab is hidden.
 */
export function LivePip() {
  const pipOpen = useApp((s) => s.pipOpen)

  // pip.ts copies the root class once, at open time; mirror later theme changes into that window.
  useEffect(() => {
    const w = getPipWindow()
    if (!pipOpen || !w) return
    const root = document.documentElement
    const obs = new MutationObserver(() => {
      w.document.documentElement.className = root.className
    })
    obs.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [pipOpen])

  const w = getPipWindow()
  if (!pipOpen || !w) return null
  return createPortal(<PipPanel />, w.document.body)
}

function PipPanel() {
  const live = useApp((s) => s.live)
  const startLive = useApp((s) => s.startLive)
  const stopLive = useApp((s) => s.stopLive)
  const continueLive = useApp((s) => s.continueLive)
  const newLive = useApp((s) => s.newLive)
  const [copied, setCopied] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const text = liveText(live)
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  const recording = live?.status === 'recording'
  const transcribing = live?.status === 'transcribing'
  const paused = live?.status === 'paused'

  async function copy() {
    const w = getPipWindow()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard API is often blocked in a PiP window: fall back inside that document.
      const doc = w?.document ?? document
      const ta = doc.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      doc.body.appendChild(ta)
      ta.select()
      try {
        doc.execCommand('copy')
      } catch {
        /* nothing else to try */
      }
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex h-screen flex-col gap-2.5 bg-background p-3">
      <div className="lt-eyebrow flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          {recording && (
            <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
          )}
          {recording
            ? 'Recording'
            : transcribing
              ? 'Finishing'
              : paused
                ? 'Paused'
                : 'Ready'}
        </span>
        <span className="lt-num text-[13px] text-foreground">
          {formatTime(live?.seconds ?? 0)}
        </span>
      </div>

      <div
        ref={boxRef}
        style={{ userSelect: 'text' }}
        className="flex-1 overflow-y-auto rounded-md border bg-card px-3 py-2 text-[13px] leading-[1.7]"
      >
        {live?.committedText && <span>{live.committedText} </span>}
        {live?.interimText && (
          <span className="text-muted-foreground">{live.interimText}</span>
        )}
        {!text && <span className="text-muted-foreground">Nothing captured yet.</span>}
      </div>

      {live?.error && <p className="text-[11px] text-muted-foreground">{live.error}</p>}

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={transcribing}
          onClick={() => void (recording ? stopLive() : startLive())}
        >
          {recording ? 'Stop' : 'Record'}
        </Button>
        {paused && (
          <Button size="sm" variant="outline" onClick={() => void continueLive()}>
            Continue
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={!text} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={transcribing}
          onClick={() => void newLive()}
        >
          New
        </Button>
      </div>
    </div>
  )
}

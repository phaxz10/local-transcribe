import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { useApp, liveText } from '@/lib/store'
import { getPipWindow, installAutoPip, syncAutoPip, syncMediaSession } from '@/lib/pip'
import { formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** Auto PiP applies while the Transcribe page is showing, or while a session is running anywhere. */
function autoPipEligible(): boolean {
  const { view, live } = useApp.getState()
  return view === 'workspace' || live?.status === 'recording' || live?.status === 'transcribing'
}

/**
 * The Document PiP companion. Mounted once, outside <main>, so it survives every view change ,
 * and because the store owns the Live Session, its buttons work while the main tab is hidden.
 */
export function LivePip() {
  const pipOpen = useApp((s) => s.pipOpen)

  // Auto PiP. The action handler has to be registered before the tab hides, so re-sync it on every
  // change of the two things eligibility is made of: the view, and the session's status.
  useEffect(() => {
    let last = ''
    const apply = () => {
      const s = useApp.getState()
      const key = `${s.view}:${s.live?.status ?? 'idle'}`
      if (key === last) return // the store also ticks once a second while recording
      last = key
      syncAutoPip(autoPipEligible())
      syncMediaSession(s.live?.status === 'recording')
    }
    apply()
    const unsubscribe = useApp.subscribe(apply)
    const uninstall = installAutoPip(autoPipEligible)
    return () => {
      unsubscribe()
      uninstall()
      syncAutoPip(false)
      syncMediaSession(false)
    }
  }, [])

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

  // Stopping disables the primary for a moment, which blurs it; hand focus back when it returns.
  const primaryRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (transcribing || !refocus.current) return
    refocus.current = false
    primaryRef.current?.focus()
  }, [transcribing])

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
        className="lt-paper lt-paper-tight flex-1 overflow-y-auto text-[13px]"
      >
        {live?.committedText && <span>{live.committedText} </span>}
        {live?.interimText && (
          <span className="text-muted-foreground">{live.interimText}</span>
        )}
        {!text && <span className="text-muted-foreground">Nothing captured yet.</span>}
      </div>

      {live?.error && <p className="text-[11px] text-muted-foreground">{live.error}</p>}

      <div className="flex flex-wrap gap-1.5">
        {/* One primary, four states. Same element throughout, so it keeps focus. */}
        <Button
          ref={primaryRef}
          size="sm"
          disabled={transcribing}
          onClick={() => {
            refocus.current = true
            void (recording ? stopLive() : paused ? continueLive() : startLive())
          }}
        >
          {transcribing && <Loader2 className="size-3.5 animate-spin" />}
          {paused ? 'Continue' : recording || transcribing ? 'Stop' : 'Record'}
        </Button>
        <Button size="sm" variant="outline" disabled={!text} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {paused && (
          <Button size="sm" variant="ghost" onClick={() => void newLive()}>
            New recording
          </Button>
        )}
      </div>
    </div>
  )
}

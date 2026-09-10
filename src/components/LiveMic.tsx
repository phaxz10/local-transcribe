import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Copy, Check, PictureInPicture2, Loader2 } from 'lucide-react'
import { useApp, liveText } from '@/lib/store'
import { supportsPip } from '@/lib/pip'
import { cn, formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * The Live Session's on-screen face. Deliberately stateless: the session lives in the store, so
 * switching Workspace tabs (or navigating away entirely) no longer kills the microphone.
 */
export function LiveMic() {
  const live = useApp((s) => s.live)
  const job = useApp((s) => s.job)
  const startLive = useApp((s) => s.startLive)
  const stopLive = useApp((s) => s.stopLive)
  const continueLive = useApp((s) => s.continueLive)
  const newLive = useApp((s) => s.newLive)
  const openTranscript = useApp((s) => s.openTranscript)
  const pipOpen = useApp((s) => s.pipOpen)
  const openPip = useApp((s) => s.openPip)
  const closePip = useApp((s) => s.closePip)

  const [copied, setCopied] = useState(false)
  const text = liveText(live)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  const status = live?.status ?? 'idle'
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'
  const paused = status === 'paused'
  const blocked = !!job && status === 'idle'

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const statusLabel = recording
    ? 'Recording'
    : transcribing
      ? 'Finishing transcript'
      : paused
        ? 'Paused'
        : 'Ready'

  // One primary control, four states. Continue is the primary on a paused session, so there is
  // never a Record and a Continue asking for the same press.
  const primaryLabel = recording
    ? 'Stop'
    : transcribing
      ? 'Stop'
      : paused
        ? 'Continue'
        : 'Record'
  const primaryDisabled = transcribing || blocked
  const primaryRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (primaryDisabled || !refocus.current) return
    refocus.current = false
    primaryRef.current?.focus()
  }, [primaryDisabled])

  return (
    <div className="flex flex-col items-center gap-8">
      {/* Record, the one accent on the screen. */}
      <div className="flex flex-col items-center gap-4">
        <button
          ref={primaryRef}
          onClick={() => {
            refocus.current = true
            void (recording ? stopLive() : paused ? continueLive() : startLive())
          }}
          disabled={primaryDisabled}
          title={blocked ? 'A transcription is already running' : primaryLabel}
          aria-label={primaryLabel}
          className={cn(
            'grid size-24 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-colors',
            'hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background',
            'disabled:pointer-events-none disabled:opacity-45',
            recording && 'lt-recording',
          )}
        >
          {transcribing ? (
            <Loader2 className="size-8 animate-spin" />
          ) : recording ? (
            <Square className="size-7 fill-current" />
          ) : (
            <Mic className="size-8" />
          )}
        </button>

        <div className="flex flex-col items-center gap-1.5">
          <span className="text-sm font-medium">{primaryLabel}</span>
          <span className="lt-num text-3xl font-light tracking-tight">
            {formatTime(live?.seconds ?? 0)}
          </span>
          <span className="lt-eyebrow flex items-center gap-1.5">
            {recording && (
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            {statusLabel}
          </span>
        </div>
      </div>

      {/* The paper: ruled, with the accent margin rule. No card, the rules carry it. */}
      <div
        ref={boxRef}
        className="lt-paper lt-measure max-h-80 w-full overflow-y-auto whitespace-pre-wrap text-[16px]"
        style={{ minHeight: '11rem' }}
        aria-live="polite"
      >
        {live?.committedText && <span>{live.committedText} </span>}
        {live?.interimText && (
          <span className="text-muted-foreground">{live.interimText}</span>
        )}
        {!text && (
          <span className="text-muted-foreground">
            {recording
              ? 'Listening. Start talking.'
              : 'Press record and start talking. Words land here as you speak.'}
          </span>
        )}
      </div>

      {/* Actions. */}
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        <Button variant="outline" disabled={!text} onClick={() => void copy()}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {live?.recordId && (
          <Button variant="outline" onClick={() => void openTranscript(live.recordId!)}>
            Open transcript
          </Button>
        )}
        {paused && (
          <Button variant="ghost" onClick={() => void newLive()}>
            New recording
          </Button>
        )}
        {supportsPip() && (
          <Button
            variant="ghost"
            onClick={() => void (pipOpen ? closePip() : openPip())}
            title={pipOpen ? 'Close the floating window' : 'Open a floating window'}
          >
            <PictureInPicture2 className="size-4" />
            {pipOpen ? 'Close floating window' : 'Floating window'}
          </Button>
        )}
      </div>

      {/* Quiet notes: one muted line each, never a red box. */}
      {supportsPip() && (
        <p className="-mt-6 text-xs text-muted-foreground">
          Opens by itself when you switch tabs while recording. Closes when you come back.
        </p>
      )}
      {!supportsPip() && (
        <p className="text-xs text-muted-foreground">
          The floating window needs Chrome or Edge.
        </p>
      )}
      {blocked && (
        <p className="text-xs text-muted-foreground">
          A transcription is running. Recording is available once it finishes.
        </p>
      )}
      {live?.error && (
        <p className="text-sm text-muted-foreground">{live.error}</p>
      )}
    </div>
  )
}

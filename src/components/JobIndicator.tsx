import { createPortal } from 'react-dom'
import { Loader2, Square, X } from 'lucide-react'
import { useApp } from '@/lib/store'
import type { JobPhase } from '@/lib/store'
import { Button } from '@/components/ui/button'

const PHASE_TEXT: Record<JobPhase, string> = {
  decoding: 'Decoding',
  loading: 'Loading model',
  transcribing: 'Transcribing',
  cancelling: 'Stopping',
}

/**
 * Global, always-mounted job surface (lives in the TopBar). Because the job is owned by the store,
 * this keeps showing progress + a Stop control after the user navigates away from the screen that
 * started it, and a completion/failure banner replaces the old forced jump to the transcript view.
 */
export function JobIndicator() {
  const job = useApp((s) => s.job)
  const notice = useApp((s) => s.jobNotice)
  const stopActiveJob = useApp((s) => s.stopActiveJob)
  const dismissJobNotice = useApp((s) => s.dismissJobNotice)
  const retryJob = useApp((s) => s.retryJob)
  const openTranscript = useApp((s) => s.openTranscript)

  return (
    <>
      {job && (
        <div
          className="mr-1 flex h-8 items-center gap-2 rounded-full border pl-2.5 pr-1 text-xs"
          title={`${job.label}: ${PHASE_TEXT[job.phase]}`}
        >
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          <span className="hidden text-muted-foreground md:inline">
            {PHASE_TEXT[job.phase]}
          </span>
          {job.phase !== 'cancelling' && (
            <span className="lt-num text-[11px]">{job.pct}%</span>
          )}
          <button
            onClick={stopActiveJob}
            disabled={job.phase === 'cancelling'}
            title="Stop transcription"
            aria-label="Stop transcription"
            className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-destructive-soft focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
          >
            <Square className="size-2.5 fill-current" />
          </button>
        </div>
      )}

      {notice &&
        // Portal to <body>: the TopBar's backdrop-filter would otherwise act as the containing
        // block for this fixed element and pin it to the header instead of the viewport.
        createPortal(
          <div className="fixed inset-x-4 bottom-4 z-50 rounded-lg border bg-popover p-4 shadow-lg sm:left-auto sm:right-6 sm:w-80">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="lt-eyebrow">
                  {notice.kind === 'done' ? 'Transcript ready' : 'Transcription failed'}
                </p>
                <p
                  className="mt-2 truncate text-sm"
                  title={notice.kind === 'error' ? notice.message : notice.label}
                >
                  {notice.kind === 'done' ? notice.label : notice.message}
                </p>
              </div>
              <button
                onClick={dismissJobNotice}
                title="Dismiss"
                aria-label="Dismiss"
                className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              {notice.kind === 'done' && notice.recordId && (
                <Button size="sm" onClick={() => void openTranscript(notice.recordId!)}>
                  Open transcript
                </Button>
              )}
              {notice.kind === 'error' && notice.retry && (
                <Button size="sm" variant="outline" onClick={retryJob}>
                  Try again
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={dismissJobNotice}>
                Dismiss
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

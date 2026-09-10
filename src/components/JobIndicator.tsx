import { createPortal } from 'react-dom'
import { Loader2, Square, X } from 'lucide-react'
import { useApp } from '@/lib/store'
import type { JobPhase, ModelJobPhase } from '@/lib/store'
import { Button } from '@/components/ui/button'

const PHASE_TEXT: Record<JobPhase, string> = {
  decoding: 'Decoding',
  loading: 'Loading model',
  transcribing: 'Transcribing',
  translating: 'Translating…',
  cancelling: 'Stopping',
}

const MODEL_PHASE_TEXT: Record<ModelJobPhase, string> = {
  downloading: 'Downloading',
  loading: 'Loading model…',
  benchmarking: 'Benchmarking…',
  cancelling: 'Stopping…',
}

/**
 * Global, always-mounted job surface (lives in the TopBar). Because the job is owned by the store,
 * this keeps showing progress + a Stop control after the user navigates away from the screen that
 * started it, and a completion/failure banner replaces the old forced jump to the transcript view.
 */
export function JobIndicator() {
  const job = useApp((s) => s.job)
  const modelJob = useApp((s) => s.modelJob)
  const notice = useApp((s) => s.jobNotice)
  const stopActiveJob = useApp((s) => s.stopActiveJob)
  const cancelModelDownload = useApp((s) => s.cancelModelDownload)
  const dismissJobNotice = useApp((s) => s.dismissJobNotice)
  const retryJob = useApp((s) => s.retryJob)
  const openTranscript = useApp((s) => s.openTranscript)
  const setView = useApp((s) => s.setView)
  // A model Download's banner has no transcript to open; it navigates instead.
  const isModel = !!notice && (notice.view != null || notice.retry === 'model')

  return (
    <>
      {modelJob && (
        <div
          className="mr-1 flex h-8 items-center gap-2 rounded-full border pl-1 pr-1 text-xs"
          title={`${modelJob.label}: ${MODEL_PHASE_TEXT[modelJob.phase]}`}
        >
          <button
            onClick={() => setView('onboarding')}
            title="Open Models"
            className="flex h-6 items-center gap-2 rounded-full px-1.5 outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            <span className="hidden text-muted-foreground md:inline">
              {modelJob.phase === 'downloading'
                ? `Downloading ${modelJob.label}`
                : MODEL_PHASE_TEXT[modelJob.phase]}
            </span>
            {modelJob.phase === 'downloading' && (
              <span className="lt-num text-[11px]">{modelJob.pct}%</span>
            )}
          </button>
          <button
            onClick={cancelModelDownload}
            disabled={modelJob.phase === 'cancelling'}
            title="Cancel download"
            aria-label="Cancel download"
            className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-destructive-soft focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
          >
            <Square className="size-2.5 fill-current" />
          </button>
        </div>
      )}

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
                  {notice.kind === 'done'
                    ? isModel
                      ? 'Model ready'
                      : 'Transcript ready'
                    : isModel
                      ? 'Download failed'
                      : 'Transcription failed'}
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
              {notice.kind === 'done' && !notice.recordId && notice.view && (
                <Button
                  size="sm"
                  onClick={() => {
                    setView(notice.view!)
                    dismissJobNotice()
                  }}
                >
                  Start transcribing
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

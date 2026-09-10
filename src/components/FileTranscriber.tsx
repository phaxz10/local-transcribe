import { useEffect, useRef, useState } from 'react'
import { FileAudio, Square } from 'lucide-react'
import { useApp } from '@/lib/store'
import { cn, formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

export function FileTranscriber() {
  const activeModel = useApp((s) => s.activeModel)
  const job = useApp((s) => s.job)
  const liveBusy = useApp((s) => s.live?.status === 'recording' || s.live?.status === 'transcribing')
  const runFileJob = useApp((s) => s.runFileJob)
  const stopActiveJob = useApp((s) => s.stopActiveJob)

  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const liveBoxRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // The job lives in the store, so it survives navigating away (the global TopBar indicator
  // covers it then). This component just renders the rich, on-screen progress for a file job.
  const fileJob = job && job.kind === 'file' ? job : null
  const partial = fileJob?.partial ?? ''

  // Tail the streaming preview: keep it pinned to the newest text, but stand down while the
  // user has scrolled up to re-read (re-arms when they return to the bottom).
  useEffect(() => {
    const el = liveBoxRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [partial])

  function handleFile(file: File) {
    if (!activeModel) return
    stickToBottom.current = true
    void runFileJob(file)
  }

  if (fileJob) {
    const statusText =
      fileJob.phase === 'decoding'
        ? 'Decoding audio'
        : fileJob.phase === 'loading'
          ? 'Loading model'
          : fileJob.phase === 'cancelling'
            ? 'Stopping'
            : 'Transcribing'
    return (
      <div className="space-y-8">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="lt-eyebrow">{statusText}</span>
            {fileJob.phase !== 'cancelling' && (
              <span className="lt-num text-sm">{fileJob.pct}%</span>
            )}
          </div>
          {fileJob.phase === 'cancelling' ? (
            <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          ) : (
            <Progress value={fileJob.pct} />
          )}
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p className="truncate" title={fileJob.label}>
              {fileJob.label}
            </p>
            {fileJob.phase === 'transcribing' && fileJob.etaSec != null && (
              <p className="lt-num">~{formatTime(fileJob.etaSec)} left</p>
            )}
            {(fileJob.phase === 'loading' || fileJob.phase === 'transcribing') && (
              <p>
                {fileJob.device === 'webgpu' ? 'WebGPU' : 'WASM'}.
                {fileJob.phase === 'loading'
                  ? ' The first run downloads the model, then it is cached.'
                  : ' Runs in bounded chunks. You can leave this page and it keeps going.'}
              </p>
            )}
          </div>
        </div>

        <Button
          variant="outline"
          onClick={stopActiveJob}
          disabled={fileJob.phase === 'cancelling'}
          className="w-fit"
        >
          <Square className="size-3.5 fill-current" /> Stop
        </Button>

        {partial && (
          <div
            ref={liveBoxRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
            className="lt-paper lt-measure max-h-72 overflow-y-auto text-[15px] text-muted-foreground"
          >
            {partial}
            <span
              className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-middle"
              aria-hidden="true"
            />
          </div>
        )}
      </div>
    )
  }

  // One shared Engine: a file job would starve the Live Session's interim ticks.
  if (liveBusy) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        A live recording is in progress. Stop it to transcribe a file.
      </p>
    )
  }

  // A different job (a rerun) is running in the background, don't offer a dead dropzone.
  if (job) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        A transcription is already running. It finishes in the background. Watch its
        progress up top, or wait here.
      </p>
    )
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) void handleFile(f)
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-5 rounded-lg border border-dashed px-6 py-16 text-center transition-colors sm:py-20',
        dragging ? 'border-primary bg-primary/5' : 'border-border',
      )}
    >
      <div className="space-y-2">
        <p className="text-base font-medium">Drop an audio or video file</p>
        <p className="text-sm text-muted-foreground">
          MP3, WAV, M4A, MP4, MOV, or MKV. It stays in this browser.
        </p>
      </div>
      <Button onClick={() => inputRef.current?.click()}>
        <FileAudio className="size-4" /> Choose file
      </Button>
      <p className="text-xs text-muted-foreground">
        Edit the transcript afterwards. Corrections autosave locally.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

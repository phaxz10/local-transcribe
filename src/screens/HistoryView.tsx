import { Mic, Trash2, FileText } from 'lucide-react'
import { useApp } from '@/lib/store'
import { deleteTranscript, wipeEverything } from '@/lib/db'
import { formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScreenHeader } from '@/components/ScreenHeader'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog'

function wordCount(rec: { edit: { segments: { words: unknown[] }[] } }): number {
  return rec.edit.segments.reduce((n, s) => n + s.words.length, 0)
}

export function HistoryView() {
  const history = useApp((s) => s.history)
  const activeModel = useApp((s) => s.activeModel)
  const setView = useApp((s) => s.setView)
  const refreshHistory = useApp((s) => s.refreshHistory)
  const openTranscript = useApp((s) => s.openTranscript)

  async function open(id: string) {
    await openTranscript(id)
  }

  async function remove(id: string) {
    await deleteTranscript(id)
    await refreshHistory()
  }

  async function wipe() {
    await wipeEverything()
    window.location.reload()
  }

  return (
    <div className="space-y-10">
      <ScreenHeader
        title="History"
        subtitle="Transcripts and their audio are stored in this browser. Nothing is uploaded."
      />

      {history.length === 0 ? (
        <div className="space-y-5 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No transcripts yet. They will appear here once you record or transcribe a file.
          </p>
          <Button onClick={() => setView(activeModel ? 'workspace' : 'onboarding')}>
            Start transcribing
          </Button>
        </div>
      ) : (
        <ul className="border-t">
          {history.map((rec) => (
            <li key={rec.id} className="group flex items-center gap-2 border-b">
              <button
                onClick={() => void open(rec.id)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-3.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {rec.source.hash.startsWith('live:') ? (
                  <Mic className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] group-hover:underline">
                    {rec.source.filename}
                  </span>
                  <span className="lt-eyebrow mt-1.5 block truncate">
                    {new Date(rec.createdAt).toLocaleDateString()} ·{' '}
                    {formatTime(rec.source.durationSec)} · {wordCount(rec)} words ·{' '}
                    {rec.model}
                  </span>
                </span>
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={`Delete ${rec.source.filename}`}
                aria-label={`Delete ${rec.source.filename}`}
                className="shrink-0 text-muted-foreground hover:text-destructive-soft"
                onClick={() => void remove(rec.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Always available: downloaded models live in the cache even when there are
          zero transcripts, so this is the only way to reclaim that storage here. */}
      <footer className="flex flex-wrap items-center justify-between gap-3 pt-4">
        <p className="text-xs text-muted-foreground">
          Everything here lives in this browser only.
        </p>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              Erase all local data
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Erase all local data?</DialogTitle>
              <DialogDescription>
                This deletes every transcript, your settings, and the downloaded models
                from this browser. It cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button variant="destructive" onClick={wipe}>
                Erase everything
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </footer>
    </div>
  )
}

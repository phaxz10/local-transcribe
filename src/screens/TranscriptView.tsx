import { ScreenHeader } from '@/components/ScreenHeader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { getMediaAsset, saveMediaAsset, saveTranscript } from '@/lib/db'
import {
  deleteWord,
  editWordText,
  findReplaceAll,
  insertWordAfter,
  mergeSegmentWithNext,
  splitSegment,
} from '@/lib/edit-ops'
import { downloadText, exportTranscript } from '@/lib/exporters'
import {
  buildFlatWords,
  findActiveWord,
  useActiveWord,
  usePlayhead,
  type FlatWord,
} from '@/lib/playback'
import { useApp } from '@/lib/store'
import {
  alternateByTurn,
  assignSpeakerForward,
  clearSpeakers,
  turnStarts,
} from '@/lib/turns'
import type { AsrSegment, EditSegment, ExportFormat, ExportLayer, Speakers } from '@/lib/types'
import { cn, formatTime, uid } from '@/lib/utils'
import {
  Combine,
  Download,
  Mic,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  Search,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const FORMATS: ExportFormat[] = ['txt', 'srt', 'vtt', 'json', 'md']

interface Controller {
  seek: (t: number) => void
  toggle: () => void
}

function WordInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (v: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(initial)
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(v)
        else if (e.key === 'Escape') onCancel()
      }}
      style={{ width: `${Math.max(2, v.length)}ch` }}
      className="rounded bg-primary/10 px-0.5 text-foreground outline-none ring-1 ring-primary"
    />
  )
}

/* ── Player: the ONLY subscriber to the 60fps playhead, so the word list never re-renders on a tick ── */
const Player = memo(function Player({
  controller,
  fallbackDuration,
}: {
  controller: Controller
  fallbackDuration: number
}) {
  const currentTime = usePlayhead((s) => s.currentTime)
  const duration = usePlayhead((s) => s.duration)
  const playing = usePlayhead((s) => s.playing)
  const total = duration || fallbackDuration

  return (
    <>
      <Button
        size="icon"
        onClick={controller.toggle}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        className="rounded-full"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <span className="lt-num text-xs text-muted-foreground">{formatTime(currentTime)}</span>
      <input
        type="range"
        min={0}
        max={total || 0}
        step={0.1}
        value={currentTime}
        aria-label="Seek"
        onChange={(e) => controller.seek(Number(e.target.value))}
        className="h-1 min-w-24 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <span className="lt-num text-xs text-muted-foreground">{formatTime(total)}</span>
    </>
  )
})

/* ── SpeakerPicker: the gutter label + its inline picker. Sentinel values keep it one control ── */
const NEW_SPEAKER = '__new'
const RENAME_SPEAKER = '__rename'

function SpeakerPicker({
  segId,
  speakerId,
  speakers,
  onPick,
}: {
  segId: string
  speakerId: string | undefined
  speakers: Speakers | undefined
  onPick: (segId: string, value: string) => void
}) {
  const name = speakerId ? speakers?.[speakerId]?.name : undefined
  return (
    <Select value={speakerId} onValueChange={(v) => onPick(segId, v)}>
      <SelectTrigger
        aria-label={name ? `Speaker: ${name}` : 'Assign a speaker'}
        title={name ? `Speaker: ${name}` : 'Assign a speaker'}
        className={cn(
          'lt-eyebrow h-auto justify-end gap-0 rounded border-0 px-0 py-0 text-[10px] normal-case tracking-normal transition-opacity hover:bg-transparent [&>svg]:hidden',
          name
            ? 'text-primary'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
        )}
      >
        <span className="truncate">{name ?? '+ speaker'}</span>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(speakers ?? {}).map(([id, sp]) => (
          <SelectItem key={id} value={id}>
            {sp.name}
          </SelectItem>
        ))}
        <SelectItem value={NEW_SPEAKER}>New speaker</SelectItem>
        {speakerId && <SelectItem value={RENAME_SPEAKER}>Rename…</SelectItem>}
      </SelectContent>
    </Select>
  )
}

/* ── SegmentRow: subscribes only to the active-word store; memoized with a segment-scoped comparator ── */
interface SegmentRowProps {
  seg: EditSegment
  /** Show the Speaker label on this row: it starts a turn, or its Speaker differs from the row above. */
  showSpeaker: boolean
  speakers: Speakers | undefined
  onPickSpeaker: (segId: string, value: string) => void
  selectedWordId: string | null
  editingId: string | null
  confidence: Map<string, number>
  controller: Controller
  onSelectWord: (segId: string, wordId: string) => void
  onStartEdit: (wordId: string) => void
  onCommitEdit: (segId: string, wordId: string, text: string) => void
  onCancelEdit: () => void
}

function segHasWord(seg: EditSegment, id: string | null): boolean {
  return id != null && seg.words.some((w) => w.id === id)
}

function rowPropsEqual(prev: SegmentRowProps, next: SegmentRowProps): boolean {
  if (
    prev.seg !== next.seg ||
    prev.showSpeaker !== next.showSpeaker ||
    prev.speakers !== next.speakers ||
    prev.onPickSpeaker !== next.onPickSpeaker ||
    prev.controller !== next.controller ||
    prev.confidence !== next.confidence ||
    prev.onSelectWord !== next.onSelectWord ||
    prev.onStartEdit !== next.onStartEdit ||
    prev.onCommitEdit !== next.onCommitEdit ||
    prev.onCancelEdit !== next.onCancelEdit
  ) {
    return false
  }
  // Re-render for selection/editing only when the change touches THIS segment.
  const selTouches =
    prev.selectedWordId !== next.selectedWordId &&
    (segHasWord(next.seg, prev.selectedWordId) || segHasWord(next.seg, next.selectedWordId))
  const editTouches =
    prev.editingId !== next.editingId &&
    (segHasWord(next.seg, prev.editingId) || segHasWord(next.seg, next.editingId))
  return !selTouches && !editTouches
}

const SegmentRow = memo(function SegmentRow({
  seg,
  showSpeaker,
  speakers,
  onPickSpeaker,
  selectedWordId,
  editingId,
  confidence,
  controller,
  onSelectWord,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
}: SegmentRowProps) {
  const activeWordId = useActiveWord((s) => (s.segId === seg.id ? s.wordId : null))
  const segStart = seg.words[0]?.start ?? 0
  return (
    <div className="lt-segment group flex gap-3 sm:gap-5">
      <div className="mt-[0.45rem] flex w-14 shrink-0 flex-col items-end gap-1">
        <button
          onClick={() => controller.seek(segStart)}
          title="Jump to this point"
          className="lt-num h-fit rounded text-right text-[11px] text-muted-foreground opacity-50 outline-none transition-opacity hover:text-primary hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          {formatTime(segStart)}
        </button>
        {showSpeaker && (
          <SpeakerPicker
            segId={seg.id}
            speakerId={seg.speakerId}
            speakers={speakers}
            onPick={onPickSpeaker}
          />
        )}
      </div>
      <p className="flex-1">
        {seg.words.map((w) => {
          const conf = w.origin?.[0] ? confidence.get(w.origin[0]) : undefined
          const low = w.timing === 'exact' && conf != null && conf < 0.6
          if (editingId === w.id) {
            return (
              <WordInput
                key={w.id}
                initial={w.text}
                onCommit={(v) => onCommitEdit(seg.id, w.id, v)}
                onCancel={onCancelEdit}
              />
            )
          }
          return (
            <span
              key={w.id}
              onClick={() => {
                onSelectWord(seg.id, w.id)
                controller.seek(w.start)
              }}
              onDoubleClick={() => onStartEdit(w.id)}
              className={cn(
                'cursor-pointer rounded px-0.5 transition-colors hover:bg-secondary',
                activeWordId === w.id && 'word-active',
                selectedWordId === w.id && 'ring-1 ring-primary',
                low && 'word-low-confidence',
                w.origin === null && 'italic text-primary',
              )}
            >
              {w.text}{' '}
            </span>
          )
        })}
      </p>
    </div>
  )
}, rowPropsEqual)

/* ── RawBody: read-only original ASR transcript (the "Original" view) ── */
const RawBody = memo(function RawBody({
  segments,
  controller,
}: {
  segments: AsrSegment[]
  controller: Controller
}) {
  return (
    <div className="lt-measure lt-read space-y-4">
      {segments.map((seg) => (
        <div key={seg.id} className="lt-segment group flex gap-3 sm:gap-5">
          <button
            onClick={() => controller.seek(seg.start)}
            title="Jump to this point"
            className="lt-num mt-[0.45rem] h-fit w-14 shrink-0 rounded text-right text-[11px] text-muted-foreground opacity-50 outline-none transition-opacity hover:text-primary hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          >
            {formatTime(seg.start)}
          </button>
          <p className="flex-1">
            {seg.words.map((w) => (
              <span
                key={w.id}
                onClick={() => controller.seek(w.start)}
                className="cursor-pointer rounded px-0.5 transition-colors hover:bg-secondary"
              >
                {w.text}{' '}
              </span>
            ))}
          </p>
        </div>
      ))}
    </div>
  )
})

export function TranscriptView() {
  const record = useApp((s) => s.record)
  const mediaUrl = useApp((s) => s.mediaUrl)
  const setMediaUrl = useApp((s) => s.setMediaUrl)
  const setRecord = useApp((s) => s.setRecord)
  const setView = useApp((s) => s.setView)
  const activeModel = useApp((s) => s.activeModel)
  const job = useApp((s) => s.job)
  const runRerunJob = useApp((s) => s.runRerunJob)
  const continueFromRecord = useApp((s) => s.continueFromRecord)
  const stopActiveJob = useApp((s) => s.stopActiveJob)
  const commitEdit = useApp((s) => s.commitEdit)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const refreshHistory = useApp((s) => s.refreshHistory)
  const canUndo = useApp((s) => s.past.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)

  const audioRef = useRef<HTMLAudioElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<{ segId: string; wordId: string } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showFind, setShowFind] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [replaceCount, setReplaceCount] = useState<number | null>(null)
  const [layer, setLayer] = useState<ExportLayer>('corrected')

  // Latest record without re-binding callbacks (keeps SegmentRow memo stable while typing).
  const recordRef = useRef(record)
  recordRef.current = record

  const confidence = useMemo(() => {
    const m = new Map<string, number>()
    record?.asr.segments.forEach((s) => s.words.forEach((w) => m.set(w.id, w.confidence)))
    return m
  }, [record])

  const flat = useMemo<FlatWord[]>(
    () => (record ? buildFlatWords(record.edit.segments) : []),
    [record],
  )

  // Turn boundaries (ADR-0017): a pause of >= 1 s, measured on the VAD regions when we have them.
  const turns = useMemo(
    () => turnStarts(record?.edit.segments ?? [], record?.asr.speech),
    [record?.edit.segments, record?.asr.speech],
  )

  const controller = useMemo<Controller>(
    () => ({
      seek(t) {
        const a = audioRef.current
        if (!a) return
        a.currentTime = t
        usePlayhead.getState().set({ currentTime: t })
        const w = findActiveWord(flat, t)
        useActiveWord.getState().set(w?.segId ?? null, w?.wordId ?? null)
      },
      toggle() {
        const a = audioRef.current
        if (!a) return
        if (a.paused) void a.play()
        else a.pause()
      },
    }),
    [flat],
  )

  // Single rAF-throttled audio listener feeds both stores; the word list isn't a subscriber to time.
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    let raf = 0
    const onTime = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const t = a.currentTime
        usePlayhead.getState().set({ currentTime: t })
        const w = findActiveWord(flat, t)
        useActiveWord.getState().set(w?.segId ?? null, w?.wordId ?? null)
      })
    }
    const onMeta = () => usePlayhead.getState().set({ duration: a.duration || 0 })
    const onPlay = () => usePlayhead.getState().set({ playing: true })
    const onPause = () => usePlayhead.getState().set({ playing: false })
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    return () => {
      cancelAnimationFrame(raf)
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
    }
  }, [flat, mediaUrl])

  // Reset playback stores when the open transcript changes (and on unmount).
  useEffect(() => {
    usePlayhead.getState().reset()
    useActiveWord.getState().set(null, null)
    return () => {
      usePlayhead.getState().reset()
      useActiveWord.getState().set(null, null)
    }
  }, [record?.id])

  // All edit ops route through the store's time machine (push undo, clear redo, autosave).
  const apply = commitEdit

  const doUndo = useCallback(() => {
    setSelected(null)
    setEditingId(null)
    undo()
  }, [undo])
  const doRedo = useCallback(() => {
    setSelected(null)
    setEditingId(null)
    redo()
  }, [redo])

  // Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redo, only on the editable corrected layer,
  // and never while typing in a field so native text-undo keeps working there.
  useEffect(() => {
    if (layer !== 'corrected') return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        doUndo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer, doUndo, doRedo])

  // Switching to the read-only Original view clears edit-only UI state.
  useEffect(() => {
    if (layer === 'raw') {
      setSelected(null)
      setEditingId(null)
      setShowFind(false)
    }
  }, [layer])

  useEffect(() => {
    if (!record?.source.mediaId || mediaUrl) return
    let cancelled = false
    void getMediaAsset(record.source.mediaId)
      .then((asset) => {
        if (!cancelled && asset) setMediaUrl(URL.createObjectURL(asset.blob))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mediaUrl, record?.source.mediaId, setMediaUrl])

  const onSelectWord = useCallback(
    (segId: string, wordId: string) => setSelected({ segId, wordId }),
    [],
  )
  const onStartEdit = useCallback((wordId: string) => setEditingId(wordId), [])
  const onCancelEdit = useCallback(() => setEditingId(null), [])
  const onCommitEdit = useCallback(
    (segId: string, wordId: string, text: string) => {
      const r = recordRef.current
      const seg = r?.edit.segments.find((s) => s.id === segId)
      const w = seg?.words.find((x) => x.id === wordId)
      if (r && w && text.trim() && text.trim() !== w.text) {
        apply(editWordText(r.edit, segId, wordId, text.trim()))
      }
      setEditingId(null)
    },
    [apply],
  )

  /**
   * One control, three outcomes: pick an existing Speaker, mint a new one, or rename this row's.
   * Assignment runs forward until the next Segment that already has a different Speaker, which is
   * how a dialog gets fixed in one click instead of one per line.
   */
  const onPickSpeaker = useCallback(
    (segId: string, value: string) => {
      const r = recordRef.current
      if (!r) return
      if (value === RENAME_SPEAKER) {
        const cur = r.edit.segments.find((sg) => sg.id === segId)?.speakerId
        if (!cur) return
        const name = window.prompt('Speaker name', r.speakers?.[cur]?.name ?? '')?.trim()
        if (!name) return
        commitEdit(r.edit, { ...r.speakers, [cur]: { name } })
        return
      }
      if (value === NEW_SPEAKER) {
        let n = 1
        while (r.speakers?.[`spk_${n}`]) n++
        const name = window.prompt('Speaker name', `Speaker ${n}`)?.trim()
        if (!name) return
        const id = `spk_${n}`
        commitEdit(assignSpeakerForward(r.edit, segId, id), { ...r.speakers, [id]: { name } })
        return
      }
      commitEdit(assignSpeakerForward(r.edit, segId, value))
    },
    [commitEdit],
  )

  async function attachMediaFile(file: File) {
    if (!record) return
    const mediaId = record.source.mediaId ?? uid('media_')
    const updated = {
      ...record,
      source: {
        ...record.source,
        mediaId,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      },
      updatedAt: Date.now(),
    }
    await saveMediaAsset({
      id: mediaId,
      blob: file,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      createdAt: Date.now(),
    })
    await saveTranscript(updated)
    setRecord(updated)
    await refreshHistory()
    setMediaUrl(URL.createObjectURL(file))
  }

  if (!record) {
    return (
      <div className="space-y-5 py-20 text-center">
        <p className="text-sm text-muted-foreground">No transcript open.</p>
        <Button onClick={() => setView('workspace')}>Back to workspace</Button>
      </div>
    )
  }

  function runReplace() {
    const { edit, count } = findReplaceAll(record!.edit, findText, replaceText)
    setReplaceCount(count)
    if (count > 0) apply(edit)
  }

  /**
   * Dialog mode: an explicit starting guess, not a claim. On, it mints two Speakers and alternates
   * them turn by turn; off, it drops every assignment. Both go through the undo stack.
   */
  function toggleDialog(on: boolean) {
    if (!on) {
      commitEdit(clearSpeakers(record!.edit), {})
      return
    }
    commitEdit(alternateByTurn(record!.edit, ['spk_1', 'spk_2'], turns), {
      spk_1: { name: 'Speaker 1' },
      spk_2: { name: 'Speaker 2' },
    })
  }

  function doExport(fmt: ExportFormat) {
    const { text, mime, ext } = exportTranscript(record!, fmt, layer)
    const base = record!.source.filename.replace(/\.[^.]+$/, '') || 'transcript'
    downloadText(`${base}.${ext}`, text, mime)
  }

  // The rerun job (if any) lives in the store now, so it survives leaving this view.
  const rerunJob = job && job.kind === 'rerun' ? job : null
  const rerunLabel =
    rerunJob?.phase === 'decoding'
      ? 'Decoding source media'
      : rerunJob?.phase === 'loading'
        ? 'Loading model'
        : rerunJob?.phase === 'cancelling'
          ? 'Stopping rerun'
          : 'Rerunning transcript'

  const editable = layer === 'corrected'
  const hasSpeakers = Object.keys(record.speakers ?? {}).length > 0

  return (
    <div className="space-y-8">
      <ScreenHeader
        title={record.source.filename}
        back={{ label: 'History', onClick: () => setView('history') }}
        subtitle={
          <span className="lt-eyebrow">
            {record.model} · {record.asr.language} ·{' '}
            {formatTime(record.source.durationSec)}
          </span>
        }
      />

      {/* Manufactured or chunk-level times (ADR-0016): seek still works, it is just not word-exact. */}
      {(record.asr.timing === 'interpolated' || record.asr.timing === 'chunk') && (
        <p className="-mt-6 text-xs text-muted-foreground">
          Word timings are approximate for this model.
        </p>
      )}

      {/* One bar: playback, edit tools, layer, rerun, export. */}
      <div className="sticky top-14 z-20 -mx-4 space-y-3 border-b bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {mediaUrl ? (
            <>
              <audio ref={audioRef} src={mediaUrl} preload="metadata" className="hidden" />
              <Player controller={controller} fallbackDuration={record.source.durationSec} />
            </>
          ) : (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:w-auto sm:flex-1">
              <span className="text-sm text-muted-foreground">
                Attach the original file to play it back and click to seek.
              </span>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Paperclip className="size-3.5" /> Attach audio
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void attachMediaFile(f)
                  e.target.value = ''
                }}
              />
            </div>
          )}

          {editable && (
            <div className="ml-auto flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canUndo}
                onClick={doUndo}
                title="Undo (Cmd/Ctrl+Z)"
                aria-label="Undo"
              >
                <Undo2 className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canRedo}
                onClick={doRedo}
                title="Redo (Shift+Cmd/Ctrl+Z)"
                aria-label="Redo"
              >
                <Redo2 className="size-4" />
              </Button>
              <Button
                variant={showFind ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setShowFind((v) => !v)}
                title="Find and replace"
                aria-label="Find and replace"
              >
                <Search className="size-4" />
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id="layer"
              checked={editable}
              onCheckedChange={(c) => setLayer(c ? 'corrected' : 'raw')}
            />
            <Label htmlFor="layer" className="lt-eyebrow">
              {editable ? 'Corrected · editable' : 'Original · read only'}
            </Label>
          </div>

          {editable && (
            <div className="flex items-center gap-2">
              <Switch id="dialog" checked={hasSpeakers} onCheckedChange={toggleDialog} />
              <Label htmlFor="dialog" className="lt-eyebrow">
                Two-person dialog
              </Label>
              <span className="hidden text-xs text-muted-foreground lg:inline">
                Alternates speakers at each pause; fix any wrong ones by clicking the label
              </span>
            </div>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={!!job || !activeModel}
              onClick={() => void runRerunJob()}
              title={
                job
                  ? 'A transcription is already running'
                  : activeModel
                    ? `Create a new transcript with ${activeModel.label}`
                    : 'Choose a model before rerunning'
              }
            >
              <RotateCcw className="size-3.5" /> Rerun
            </Button>
            {record.source.hash.startsWith('live:') && record.source.mediaId && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!!job || !activeModel}
                onClick={() => void continueFromRecord(record)}
                title="Reopen the microphone and append to this recording"
              >
                <Mic className="size-3.5" /> Continue recording
              </Button>
            )}
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
            <Download className="size-3.5 shrink-0 text-muted-foreground" />
            {FORMATS.map((f) => (
              <Button
                key={f}
                variant="ghost"
                size="sm"
                className="lt-num px-2 text-muted-foreground hover:text-foreground"
                onClick={() => doExport(f)}
                title={`Export as ${f.toUpperCase()}`}
              >
                {f.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {rerunJob && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="lt-eyebrow">{rerunLabel}</span>
            {rerunJob.phase !== 'cancelling' && (
              <span className="lt-num text-sm">{rerunJob.pct}%</span>
            )}
          </div>
          {rerunJob.phase === 'cancelling' ? (
            <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          ) : (
            <Progress value={rerunJob.pct} />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={stopActiveJob}
            disabled={rerunJob.phase === 'cancelling'}
            className="w-fit"
          >
            <Square className="size-3 fill-current" /> Stop
          </Button>
        </div>
      )}

      {showFind && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={findText}
            onChange={(e) => {
              setFindText(e.target.value)
              setReplaceCount(null)
            }}
            placeholder="Find"
            aria-label="Find"
            className="h-10 min-w-32 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="Replace with"
            aria-label="Replace with"
            className="h-10 min-w-32 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <Button onClick={runReplace} disabled={!findText}>
            Replace all
          </Button>
          {replaceCount != null && (
            <span className="lt-eyebrow">{replaceCount} replaced</span>
          )}
        </div>
      )}

      {/* Selected-word toolbar */}
      {selected && (
        <div className="sticky top-40 z-10 flex flex-wrap items-center gap-1 rounded-lg border bg-popover p-1.5 shadow-lg">
          <span className="lt-eyebrow px-2">Word</span>
          <Button size="sm" variant="ghost" onClick={() => setEditingId(selected.wordId)}>
            <Pencil className="size-3.5" /> Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const t = window.prompt('Insert word after:')
              if (t && t.trim())
                apply(insertWordAfter(record.edit, selected.segId, selected.wordId, t.trim()))
            }}
          >
            <Plus className="size-3.5" /> Insert after
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => apply(splitSegment(record.edit, selected.segId, selected.wordId))}
          >
            <Scissors className="size-3.5" /> Split here
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => apply(mergeSegmentWithNext(record.edit, selected.segId))}
          >
            <Combine className="size-3.5" /> Merge next
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-soft hover:text-destructive-soft"
            onClick={() => {
              apply(deleteWord(record.edit, selected.segId, selected.wordId))
              setSelected(null)
            }}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setSelected(null)}
            title="Close"
            aria-label="Close word tools"
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* Transcript body */}
      {editable ? (
        <div className="lt-measure lt-read space-y-4">
          {record.edit.segments.map((seg, i) => (
            <SegmentRow
              key={seg.id}
              seg={seg}
              showSpeaker={
                turns.has(seg.id) || seg.speakerId !== record.edit.segments[i - 1]?.speakerId
              }
              speakers={record.speakers}
              onPickSpeaker={onPickSpeaker}
              selectedWordId={selected?.wordId ?? null}
              editingId={editingId}
              confidence={confidence}
              controller={controller}
              onSelectWord={onSelectWord}
              onStartEdit={onStartEdit}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          ))}
        </div>
      ) : (
        <RawBody segments={record.asr.segments} controller={controller} />
      )}

      <p className="lt-measure border-t pt-4 text-xs text-muted-foreground">
        {editable
          ? 'Click a word to seek · double-click to edit · ⌘Z / ⇧⌘Z to undo · autosaved locally'
          : 'The original machine transcript · click a word to seek'}
      </p>
    </div>
  )
}

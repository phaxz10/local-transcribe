import { create } from 'zustand'
import type {
  AsrLayer,
  AsrSegment,
  CapabilityReport,
  CatalogModel,
  EditLayer,
  EngineDevice,
  PrimaryLanguage,
  TranscriptRecord,
} from './types'
import { detectCapability, estimateEta } from './capability'
import { buildCatalog, recommendModel } from './catalog'
import {
  deleteRecordingChunks,
  getMediaAsset,
  getRecordingChunks,
  getSetting,
  getTranscript,
  listRecordingSessionIds,
  listTranscripts,
  putRecordingChunk,
  saveMediaAsset,
  saveTranscript,
  setSetting,
} from './db'
import { startCapture, type Capture } from './mic'
import { pcmToWav, wavToPcm } from './wav'
import { closePipWindow, openPipWindow } from './pip'
import {
  disposeEngine,
  isCancelled,
  languageName,
  transcribeWithEngine,
} from './engine'
import { buildAsrLayer, deriveEditLayer } from './asr'
import { decodeToPcm16 } from './ffmpeg'
import { uid } from './utils'
import { evictModel, markProvisioned as persistProvisioned, reconcileProvisioned } from './models'

/** Max undo steps kept per open transcript (Edit-layer time machine). */
const HISTORY_LIMIT = 100

export type View = 'landing' | 'onboarding' | 'workspace' | 'transcript' | 'history'

const VIEW_HASH: Record<View, string> = {
  landing: '#/',
  onboarding: '#/models',
  workspace: '#/transcribe',
  transcript: '#/transcript',
  history: '#/history',
}

export function viewFromHash(hash = typeof window !== 'undefined' ? window.location.hash : ''): View | null {
  const normalized = hash || '#/'
  return (Object.entries(VIEW_HASH).find(([, h]) => h === normalized)?.[0] as View | undefined) ?? null
}

function writeViewHash(view: View): void {
  if (typeof window === 'undefined') return
  const next = VIEW_HASH[view]
  if (window.location.hash !== next) window.location.hash = next
}

export type JobKind = 'file' | 'rerun'
export type JobPhase = 'decoding' | 'loading' | 'transcribing' | 'cancelling'

/** A single in-flight transcription, owned by the store so it survives view changes. */
export interface ActiveJob {
  kind: JobKind
  phase: JobPhase
  /** 0..100 progress within the current phase. */
  pct: number
  /** Source filename, what the user recognises the job by. */
  label: string
  device: EngineDevice
  /** Live streaming preview text. */
  partial: string
  etaSec: number | null
}

/** Post-job banner: the result is ready (click to open) or the run failed (optionally retry). */
export interface JobNotice {
  kind: 'done' | 'error'
  label: string
  recordId?: string
  message?: string
  retry?: JobKind
}

// The abort handle and last-file live OUTSIDE reactive state on purpose: mutating them must not
// trigger renders, and the running job closure has to outlive the component that started it , 
// that decoupling is exactly what makes a job survive navigating away from its origin screen.
let jobAbort: AbortController | null = null
let lastFile: File | null = null

/* ── Live Session ─────────────────────────────────────────────────────────── */

/** A microphone -> Transcript run, owned by the store so it survives navigation. */
export interface LiveSession {
  /** Recording id; doubles as the media asset id. */
  id: string
  /** `paused` = stopped and saved, and can be continued. */
  status: 'recording' | 'transcribing' | 'paused'
  /** Total captured audio, whole seconds. */
  seconds: number
  /** Text of audio already finalized into ASR segments. */
  committedText: string
  /** Preview of the uncommitted tail. */
  interimText: string
  /** The TranscriptRecord this session writes to (set on the first stop). */
  recordId: string | null
  error: string | null
}

const SR = 16000
const PERSIST_EVERY = 5 * SR
const TICK_EVERY = 6 * SR
const COMMIT_AT = 25 * SR
/** ponytail: 60 min ~= 115 MB Int16 in memory; stream to IDB-only if longer sessions are wanted. */
const MAX_SAMPLES = 60 * 60 * SR
/** Below this peak amplitude a 25 s tail is silence, don't spend an Engine run on it. */
const SILENCE_PEAK = 26

// Same reasoning as jobAbort: the capture graph and the PCM must outlive any component.
let pcmChunks: Int16Array[] = []
let totalSamples = 0
let committedSamples = 0
let liveSegments: AsrSegment[] = []
let capture: Capture | null = null
let tickBusy = false
let tickPromise: Promise<void> = Promise.resolve()
let persistedSamples = 0
let chunkSeq = 0

function resetLiveModule(): void {
  pcmChunks = []
  totalSamples = 0
  committedSamples = 0
  liveSegments = []
  capture = null
  tickBusy = false
  tickPromise = Promise.resolve()
  persistedSamples = 0
  chunkSeq = 0
}

function setLive(patch: Partial<LiveSession> | ((l: LiveSession) => Partial<LiveSession>)): void {
  useApp.setState((s) =>
    s.live ? { live: { ...s.live, ...(typeof patch === 'function' ? patch(s.live) : patch) } } : {},
  )
}

/** Copy the absolute sample range [from, to) out of the chunk list. */
function sliceSamples(from: number, to: number): Int16Array {
  const out = new Int16Array(Math.max(0, to - from))
  let pos = 0
  let w = 0
  for (const c of pcmChunks) {
    const start = pos
    const end = pos + c.length
    pos = end
    if (end <= from) continue
    if (start >= to) break
    const a = Math.max(from, start) - start
    const b = Math.min(to, end) - start
    out.set(c.subarray(a, b), w)
    w += b - a
  }
  return out
}

function peakOf(pcm: Int16Array): number {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i]
    if (v > peak) peak = v
  }
  return peak
}

/**
 * Transcribe the uncommitted tail. `final` (or a tail past COMMIT_AT) promotes the result into
 * committed ASR segments; anything shorter is just an interim preview that gets re-transcribed.
 *
 * Ceiling: a tick never transcribes more than 25 s, so on a slow WASM device the preview lags
 * behind the speaker but the per-tick cost stays bounded.
 */
async function tickBody(final: boolean): Promise<void> {
  const { activeModel, primaryLanguage, capability, live } = useApp.getState()
  if (!live || !activeModel) return
  const from = committedSamples
  const to = totalSamples
  if (to <= from) return
  const tail = sliceSamples(from, to)
  const commit = final || tail.length >= COMMIT_AT
  if (commit && peakOf(tail) < SILENCE_PEAK) {
    committedSamples = to
    setLive({ interimText: '' })
    return
  }
  const language = languageName(primaryLanguage, activeModel.englishOnly)
  const out = await transcribeWithEngine(activeModel, capability?.device ?? 'wasm', tail, {
    language,
    englishOnly: activeModel.englishOnly,
  })
  const text = (out.text ?? '').replace(/\s+/g, ' ').trim()
  if (!commit) {
    setLive({ interimText: text })
    return
  }
  liveSegments.push(...buildAsrLayer(out, language ?? 'auto', from / SR).segments)
  committedSamples = to
  setLive((l) => ({
    committedText: [l.committedText, text].filter(Boolean).join(' '),
    interimText: '',
  }))
}

async function runTick(final: boolean): Promise<void> {
  tickBusy = true
  const p = (async () => {
    try {
      await tickBody(final)
    } finally {
      tickBusy = false
    }
  })()
  tickPromise = p.catch(() => {})
  // Interim ticks are best-effort (a WebGPU hiccup must not kill the recording); the final one
  // is the transcript, so its failure propagates to stopLive.
  if (final) await p
  else await tickPromise
}

/** Every ~4096 samples off the worklet: buffer, persist, and drive the interim ticks. */
function onFrame(pcm: Int16Array): void {
  const live = useApp.getState().live
  if (!live || live.status !== 'recording') return
  pcmChunks.push(pcm)
  totalSamples += pcm.length

  const secs = Math.floor(totalSamples / SR)
  if (secs !== live.seconds) setLive({ seconds: secs })

  if (totalSamples - persistedSamples >= PERSIST_EVERY) {
    const span = sliceSamples(persistedSamples, totalSamples)
    persistedSamples = totalSamples
    void putRecordingChunk({ sessionId: live.id, seq: chunkSeq++, pcm: span }).catch(() => {})
  }

  if (totalSamples >= MAX_SAMPLES) {
    void useApp.getState().stopLive()
    return
  }
  // Ticks are driven by frames, not setInterval: a backgrounded tab throttles timers to once a
  // minute, but audio frames keep arriving.
  if (!tickBusy && totalSamples - committedSamples >= TICK_EVERY) void runTick(false)
}

/** Committed + interim, the way a human reads it. */
export function liveText(live: LiveSession | null = useApp.getState().live): string {
  if (!live) return ''
  return [live.committedText, live.interimText].filter(Boolean).join(' ')
}

/**
 * Boot-time crash recovery: any session with persisted chunks never reached stopLive, so turn its
 * audio into a media asset + an empty transcript the user can Rerun.
 */
async function recoverRecordings(): Promise<void> {
  const ids = await listRecordingSessionIds()
  let recovered: TranscriptRecord | null = null
  for (const id of ids) {
    const chunks = await getRecordingChunks(id)
    const samples = chunks.reduce((n, c) => n + c.length, 0)
    if (samples === 0) {
      await deleteRecordingChunks(id)
      continue
    }
    const now = Date.now()
    const filename = `Recovered recording ${new Date(now).toLocaleString()}`
    const blob = pcmToWav(chunks)
    await saveMediaAsset({ id, blob, filename, mimeType: 'audio/wav', sizeBytes: blob.size, createdAt: now })
    const asr: AsrLayer = { segments: [], language: 'auto', task: 'transcribe' }
    const record: TranscriptRecord = {
      id: uid('tr_'),
      source: {
        filename,
        sizeBytes: blob.size,
        durationSec: samples / SR,
        hash: `live:${id}`,
        mediaId: id,
        mimeType: 'audio/wav',
      },
      model: '',
      primaryLanguage: useApp.getState().primaryLanguage,
      createdAt: now,
      updatedAt: now,
      asr,
      edit: { segments: [] },
    }
    await saveTranscript(record)
    await deleteRecordingChunks(id)
    recovered = record
  }
  if (!recovered) return
  await useApp.getState().refreshHistory()
  useApp.setState({
    jobNotice: { kind: 'done', label: 'Recovered an unfinished recording', recordId: recovered.id },
  })
}

interface AppState {
  ready: boolean
  view: View
  capability: CapabilityReport | null
  catalog: CatalogModel[]
  /** Catalog ids whose weights are present in Cache Storage, reconciled on init. */
  provisioned: string[]
  primaryLanguage: PrimaryLanguage
  /** The provisioned, active Transcription Model (downloaded + selected). */
  activeModel: CatalogModel | null
  record: TranscriptRecord | null
  /** Transient object URL for the current session's media (never persisted). */
  mediaUrl: string | null
  history: TranscriptRecord[]
  /** Undo/redo stacks of Edit layers for the open transcript (a basic time machine). */
  past: EditLayer[]
  future: EditLayer[]
  /** The single in-flight transcription job (null when idle). Lives here so navigation is safe. */
  job: ActiveJob | null
  /** Post-job banner shown when the user isn't already looking at the result. */
  jobNotice: JobNotice | null
  /** The Live Session (null when there has never been one, or it was discarded). */
  live: LiveSession | null
  workspaceTab: 'file' | 'live'
  /** Whether the Document PiP companion window is open. */
  pipOpen: boolean

  init: () => Promise<void>
  setView: (v: View) => void
  setPrimaryLanguage: (l: PrimaryLanguage) => void
  setActiveModel: (m: CatalogModel) => void
  /** Record that a model's weights are now cached (after a successful Download). */
  markProvisioned: (id: string) => void
  /** Evict a model from Cache Storage; clears Active Model + disposes engine if it was active. */
  evict: (m: CatalogModel) => Promise<void>
  setCapability: (c: CapabilityReport) => void
  setRecord: (r: TranscriptRecord | null) => void
  setMediaUrl: (url: string | null) => void
  /** Apply an edit to the open transcript: push the prior Edit layer onto undo, clear redo, autosave. */
  commitEdit: (edit: EditLayer) => void
  undo: () => void
  redo: () => void
  refreshHistory: () => Promise<void>
  recommended: () => CatalogModel | null
  /** Transcribe a dropped/chosen file as a nav-safe background job. */
  runFileJob: (file: File) => Promise<void>
  /** Re-transcribe the open record with the Active Model as a nav-safe background job. */
  runRerunJob: () => Promise<void>
  /** Abort the in-flight job. */
  stopActiveJob: () => void
  /** Re-dispatch the last failed job. */
  retryJob: () => void
  dismissJobNotice: () => void
  /** Open a transcript by id (loads its media). Used by History and the ready-banner. */
  openTranscript: (id: string) => Promise<void>

  setWorkspaceTab: (t: 'file' | 'live') => void
  /** Open the mic and start a fresh Live Session. */
  startLive: () => Promise<void>
  /** Stop capture, finalize the tail, save the media + transcript, and go to `paused`. */
  stopLive: () => Promise<void>
  /** Re-open the mic on a `paused` session, keeping its audio and committed text. */
  continueLive: () => Promise<void>
  /** Resume recording into an existing live-sourced transcript, from anywhere (e.g. History). */
  continueFromRecord: (r: TranscriptRecord) => Promise<void>
  /** Drop the session (the saved transcript, if any, stays). */
  discardLive: () => Promise<void>
  /** Discard and immediately start a new one. */
  newLive: () => Promise<void>
  /** `silent` swallows the failure: an auto-open with no user activation is expected to reject. */
  openPip: (silent?: boolean) => Promise<void>
  closePip: () => void
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  view: 'landing',
  capability: null,
  catalog: [],
  provisioned: [],
  primaryLanguage: 'en',
  activeModel: null,
  record: null,
  mediaUrl: null,
  history: [],
  past: [],
  future: [],
  job: null,
  jobNotice: null,
  live: null,
  workspaceTab: 'file',
  pipOpen: false,

  init: async () => {
    const [capability, history] = await Promise.all([
      detectCapability(),
      listTranscripts().catch(() => [] as TranscriptRecord[]),
    ])
    const catalog = buildCatalog()
    const savedLang = (await getSetting<PrimaryLanguage>('primaryLanguage').catch(() => undefined)) ?? 'en'
    const savedModelId = await getSetting<string>('activeModelId').catch(() => undefined)
    const savedRtf = await getSetting<number>('benchmarkRtf').catch(() => undefined)

    // Reconcile the provisioned-id hint against Cache Storage truth (ADR-0008).
    const idToHf = new Map(catalog.map((m) => [m.id, m.hfId]))
    const resolveHf = (id: string): string | null => idToHf.get(id) ?? null
    const provisioned = await reconcileProvisioned(resolveHf).catch(() => [] as string[])

    // Restore the Active Model only if its weights are still cached.
    let activeModel: CatalogModel | null = savedModelId
      ? catalog.find((m) => m.id === savedModelId) ?? null
      : null
    if (activeModel && !provisioned.includes(activeModel.id)) activeModel = null

    const hashView = viewFromHash()
    const initialView = hashView ?? (activeModel ? 'workspace' : 'landing')
    if (!hashView && typeof window !== 'undefined' && window.location.hash) {
      writeViewHash(initialView)
    }
    set({
      // Restore the measured ×RT so ETAs survive a reload (the benchmark only runs at onboarding).
      capability: { ...capability, benchmarkRtf: savedRtf ?? null },
      catalog,
      history,
      provisioned,
      primaryLanguage: savedLang,
      activeModel,
      ready: true,
      view: initialView,
    })

    // Never block boot on it: a recovered recording is a bonus, not a precondition.
    void recoverRecordings().catch(() => {})
  },

  setView: (view) => {
    writeViewHash(view)
    set({ view })
  },
  setPrimaryLanguage: (l) => {
    void setSetting('primaryLanguage', l)
    set({ primaryLanguage: l })
  },
  setActiveModel: (m) => {
    void setSetting('activeModelId', m.id)
    set({ activeModel: m })
  },
  markProvisioned: (id) => {
    void persistProvisioned(id)
    // First successful Download: ask the browser not to evict this origin (models + transcripts
    // + recordings). Best-effort, a decline is fine, we just never get to ask again for free.
    void navigator.storage?.persist?.()
    set((s) => ({
      provisioned: s.provisioned.includes(id) ? s.provisioned : [...s.provisioned, id],
    }))
  },
  evict: async (m) => {
    await evictModel(m.hfId, m.id)
    const wasActive = get().activeModel?.id === m.id
    if (wasActive) {
      await disposeEngine()
      if (wasActive) void setSetting('activeModelId', '')
    }
    set((s) => ({
      provisioned: s.provisioned.filter((x) => x !== m.id),
      activeModel: wasActive ? null : s.activeModel,
    }))
  },
  setCapability: (capability) => {
    void setSetting('benchmarkRtf', capability.benchmarkRtf)
    set({ capability })
  },
  setRecord: (record) =>
    set((s) => {
      // Opening / closing / replacing a different transcript resets the time machine.
      const changed = (record?.id ?? null) !== (s.record?.id ?? null)
      return changed ? { record, past: [], future: [] } : { record }
    }),
  setMediaUrl: (mediaUrl) => {
    const prev = get().mediaUrl
    if (prev && prev !== mediaUrl) URL.revokeObjectURL(prev)
    set({ mediaUrl })
  },
  commitEdit: (edit) => {
    const { record } = get()
    if (!record) return
    const updated = { ...record, edit, updatedAt: Date.now() }
    set((s) => ({
      record: updated,
      past: [...s.past, record.edit].slice(-HISTORY_LIMIT),
      future: [],
    }))
    void saveTranscript(updated).then(() => get().refreshHistory())
  },
  undo: () => {
    const { record, past, future } = get()
    if (!record || past.length === 0) return
    const prev = past[past.length - 1]
    const updated = { ...record, edit: prev, updatedAt: Date.now() }
    set({
      record: updated,
      past: past.slice(0, -1),
      future: [record.edit, ...future].slice(0, HISTORY_LIMIT),
    })
    void saveTranscript(updated).then(() => get().refreshHistory())
  },
  redo: () => {
    const { record, past, future } = get()
    if (!record || future.length === 0) return
    const next = future[0]
    const updated = { ...record, edit: next, updatedAt: Date.now() }
    set({
      record: updated,
      past: [...past, record.edit].slice(-HISTORY_LIMIT),
      future: future.slice(1),
    })
    void saveTranscript(updated).then(() => get().refreshHistory())
  },
  refreshHistory: async () => set({ history: await listTranscripts() }),
  recommended: () => {
    const s = get()
    return s.capability ? recommendModel(s.catalog, s.capability, s.primaryLanguage) : null
  },

  runFileJob: async (file) => {
    const { activeModel, primaryLanguage, capability, job, live } = get()
    if (!activeModel || activeModel.task !== 'transcription' || job) return // single-job invariant: one shared engine at a time
    if (live?.status === 'recording' || live?.status === 'transcribing') return // a file job would starve the interim ticks
    const patch = (p: Partial<ActiveJob>) =>
      set((s) => (s.job ? { job: { ...s.job, ...p } } : {}))
    lastFile = file
    jobAbort?.abort()
    const ac = new AbortController()
    jobAbort = ac
    const device = capability?.device ?? 'wasm'
    set({ jobNotice: null })
    get().setMediaUrl(URL.createObjectURL(file))
    set({
      job: { kind: 'file', phase: 'decoding', pct: 0, label: file.name, device, partial: '', etaSec: null },
    })
    try {
      const { pcm, durationSec } = await decodeToPcm16(
        file,
        (r) => patch({ pct: Math.round(r * 100) }),
        ac.signal,
      )
      patch({ phase: 'loading', pct: 0, etaSec: estimateEta(durationSec, capability?.benchmarkRtf ?? null) })
      const language = languageName(primaryLanguage, activeModel.englishOnly)
      const out = await transcribeWithEngine(activeModel, device, pcm, {
        signal: ac.signal,
        language,
        englishOnly: activeModel.englishOnly,
        onLoadProgress: (s) => patch({ pct: Math.round(s.ratio * 100) }),
        onDeviceReady: (d) => patch({ device: d, phase: 'transcribing', pct: 0 }),
        onFallback: (d) => patch({ device: d, phase: 'loading', pct: 0, partial: '' }),
        onProgress: (s) => patch({ pct: Math.round(s.ratio * 100) }),
        onPartial: (t) => patch({ partial: t }),
      })
      const asrLayer = buildAsrLayer(out, language ?? 'auto')
      const now = Date.now()
      const mediaId = uid('media_')
      const record: TranscriptRecord = {
        id: uid('tr_'),
        source: {
          filename: file.name,
          sizeBytes: file.size,
          durationSec,
          hash: `${file.name}:${file.size}:${file.lastModified}`,
          mediaId,
          mimeType: file.type || 'application/octet-stream',
        },
        model: activeModel.label,
        primaryLanguage,
        createdAt: now,
        updatedAt: now,
        asr: asrLayer,
        edit: deriveEditLayer(asrLayer),
      }
      await saveMediaAsset({
        id: mediaId,
        blob: file,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        createdAt: now,
      })
      await saveTranscript(record)
      jobAbort = null
      lastFile = null
      set({ job: null })
      await get().refreshHistory()
      // Nav-safe completion: if they're still on the workspace, open the result as before;
      // if they wandered off, don't yank the view, drop a banner they can click.
      if (get().view === 'workspace') {
        get().setRecord(record)
        set({ view: 'transcript' })
      } else {
        set({ jobNotice: { kind: 'done', label: file.name, recordId: record.id } })
      }
    } catch (e) {
      jobAbort = null
      if (isCancelled(e)) {
        set({ job: null })
      } else {
        set({
          job: null,
          jobNotice: {
            kind: 'error',
            label: file.name,
            message: e instanceof Error ? e.message : String(e),
            retry: 'file',
          },
        })
      }
    }
  },

  runRerunJob: async () => {
    const { record, activeModel, primaryLanguage, capability, job, live } = get()
    if (!record || !activeModel || activeModel.task !== 'transcription' || job) return
    if (live?.status === 'recording' || live?.status === 'transcribing') return
    const patch = (p: Partial<ActiveJob>) =>
      set((s) => (s.job ? { job: { ...s.job, ...p } } : {}))
    const originId = record.id
    const mediaId = record.source.mediaId
    if (!mediaId) {
      set({ jobNotice: { kind: 'error', label: record.source.filename, message: 'Attach the source media once before rerunning this transcript.' } })
      return
    }
    const asset = await getMediaAsset(mediaId).catch(() => undefined)
    if (!asset) {
      set({ jobNotice: { kind: 'error', label: record.source.filename, message: 'Stored media is missing. Attach the source media again to rerun.' } })
      return
    }
    jobAbort?.abort()
    const ac = new AbortController()
    jobAbort = ac
    const device = capability?.device ?? 'wasm'
    const file = new File([asset.blob], asset.filename, {
      type: asset.mimeType || record.source.mimeType || 'application/octet-stream',
    })
    set({
      jobNotice: null,
      job: { kind: 'rerun', phase: 'decoding', pct: 0, label: record.source.filename, device, partial: '', etaSec: null },
    })
    try {
      const { pcm, durationSec } = await decodeToPcm16(
        file,
        (r) => patch({ pct: Math.round(r * 100) }),
        ac.signal,
      )
      patch({ phase: 'loading', pct: 0, etaSec: estimateEta(durationSec, capability?.benchmarkRtf ?? null) })
      const language = languageName(primaryLanguage, activeModel.englishOnly)
      const out = await transcribeWithEngine(activeModel, device, pcm, {
        signal: ac.signal,
        language,
        englishOnly: activeModel.englishOnly,
        onLoadProgress: (s) => patch({ pct: Math.round(s.ratio * 100) }),
        onDeviceReady: (d) => patch({ device: d, phase: 'transcribing', pct: 0 }),
        onFallback: (d) => patch({ device: d, phase: 'loading', pct: 0, partial: '' }),
        onProgress: (s) => patch({ pct: Math.round(s.ratio * 100) }),
        onPartial: (t) => patch({ partial: t }),
      })
      const asrLayer = buildAsrLayer(out, language ?? 'auto')
      const now = Date.now()
      const next: TranscriptRecord = {
        id: uid('tr_'),
        source: {
          ...record.source,
          durationSec,
          mediaId,
          mimeType: asset.mimeType || record.source.mimeType,
        },
        model: activeModel.label,
        primaryLanguage,
        createdAt: now,
        updatedAt: now,
        asr: asrLayer,
        edit: deriveEditLayer(asrLayer),
      }
      await saveTranscript(next)
      jobAbort = null
      set({ job: null })
      await get().refreshHistory()
      // If they're still viewing the record they reran, swap it in place; else drop a banner.
      // (Never clobber a *different* transcript the user has since opened.)
      if (get().record?.id === originId) {
        get().setRecord(next)
        get().setMediaUrl(URL.createObjectURL(asset.blob))
      } else {
        set({ jobNotice: { kind: 'done', label: record.source.filename, recordId: next.id } })
      }
    } catch (e) {
      jobAbort = null
      if (isCancelled(e)) {
        set({ job: null })
      } else {
        set({
          job: null,
          jobNotice: {
            kind: 'error',
            label: record.source.filename,
            message: e instanceof Error ? e.message : String(e),
            retry: 'rerun',
          },
        })
      }
    }
  },

  stopActiveJob: () => {
    jobAbort?.abort()
    set((s) => (s.job ? { job: { ...s.job, phase: 'cancelling' } } : {}))
  },
  retryJob: () => {
    const notice = get().jobNotice
    if (!notice || notice.kind !== 'error') return
    set({ jobNotice: null })
    if (notice.retry === 'file' && lastFile) void get().runFileJob(lastFile)
    else if (notice.retry === 'rerun') void get().runRerunJob()
  },
  dismissJobNotice: () => set({ jobNotice: null }),
  openTranscript: async (id) => {
    const s = get()
    const rec = s.history.find((r) => r.id === id) ?? (s.record?.id === id ? s.record : null)
    if (!rec) return
    get().setMediaUrl(null)
    set({ jobNotice: null })
    s.setRecord(rec)
    set({ view: 'transcript' })
    if (rec.source.mediaId) {
      const asset = await getMediaAsset(rec.source.mediaId).catch(() => undefined)
      if (asset) get().setMediaUrl(URL.createObjectURL(asset.blob))
    }
  },

  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),

  startLive: async () => {
    const s = get()
    if (!s.activeModel || s.job) return
    if (s.live && s.live.status !== 'paused') return
    resetLiveModule()
    const id = uid('media_')
    set({
      jobNotice: null,
      workspaceTab: 'live',
      live: {
        id,
        status: 'recording',
        seconds: 0,
        committedText: '',
        interimText: '',
        recordId: null,
        error: null,
      },
    })
    try {
      capture = await startCapture(onFrame)
    } catch (e) {
      // Nothing was recorded, so there is no session to show, surface it as a notice instead.
      capture = null
      set({
        live: null,
        jobNotice: {
          kind: 'error',
          label: 'Microphone',
          message: e instanceof Error ? e.message : String(e),
        },
      })
    }
  },

  stopLive: async () => {
    const live = get().live
    if (!live || live.status !== 'recording') return
    const id = live.id
    // Flip the status before the first await: the 60-min auto-stop fires from onFrame, which
    // keeps running until capture is actually torn down, and this is what makes it re-entrant-safe.
    setLive({ status: 'transcribing' })
    await capture?.stop().catch(() => {})
    capture = null

    if (totalSamples > persistedSamples) {
      const span = sliceSamples(persistedSamples, totalSamples)
      persistedSamples = totalSamples
      await putRecordingChunk({ sessionId: id, seq: chunkSeq++, pcm: span }).catch(() => {})
    }

    const existing = live.recordId
      ? get().history.find((r) => r.id === live.recordId) ??
        (await getTranscript(live.recordId).catch(() => undefined))
      : undefined
    const now = Date.now()
    const filename = existing?.source.filename ?? `Live recording ${new Date(now).toLocaleString()}`

    // Media first: after this the audio is safe even if the final tick blows up.
    const blob = pcmToWav(pcmChunks)
    await saveMediaAsset({
      id,
      blob,
      filename,
      mimeType: 'audio/wav',
      sizeBytes: blob.size,
      createdAt: existing?.createdAt ?? now,
    })

    let error: string | null = null
    try {
      await tickPromise // let any interim tick land before the final one reads committedSamples
      await runTick(true)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }

    const { activeModel, primaryLanguage } = get()
    const asr: AsrLayer = {
      segments: liveSegments.slice(),
      language: existing?.asr.language ?? languageName(primaryLanguage, activeModel?.englishOnly ?? false) ?? 'auto',
      task: 'transcribe',
    }
    const durationSec = totalSamples / SR
    const source = {
      filename,
      sizeBytes: blob.size,
      durationSec,
      hash: `live:${id}`,
      mediaId: id,
      mimeType: 'audio/wav',
    }
    let updated: TranscriptRecord
    if (existing) {
      // Only the ASR segments added by this leg get derived into the Edit layer, everything
      // before them is the user's corrected text and must survive untouched.
      const added = asr.segments.slice(existing.asr.segments.length)
      updated = {
        ...existing,
        source: { ...existing.source, ...source },
        updatedAt: now,
        asr,
        edit: {
          ...existing.edit,
          segments: [
            ...existing.edit.segments,
            ...deriveEditLayer({ ...asr, segments: added }).segments,
          ],
        },
      }
    } else {
      updated = {
        id: uid('tr_'),
        source,
        model: activeModel?.label ?? '',
        primaryLanguage,
        createdAt: now,
        updatedAt: now,
        asr,
        edit: deriveEditLayer(asr),
      }
    }
    await saveTranscript(updated)
    await deleteRecordingChunks(id).catch(() => {})
    await get().refreshHistory()
    setLive({
      status: 'paused',
      recordId: updated.id,
      seconds: Math.floor(durationSec),
      interimText: '',
      error,
    })
    if (get().record?.id === updated.id) {
      get().setRecord(updated)
      get().setMediaUrl(URL.createObjectURL(blob))
    }
  },

  continueLive: async () => {
    const live = get().live
    if (!live || live.status !== 'paused') return
    setLive({ status: 'recording', error: null })
    try {
      capture = await startCapture(onFrame)
    } catch (e) {
      capture = null
      setLive({ status: 'paused', error: e instanceof Error ? e.message : String(e) })
    }
  },

  continueFromRecord: async (record) => {
    const mediaId = record.source.mediaId
    if (!mediaId || !record.source.hash.startsWith('live:')) return
    const asset = await getMediaAsset(mediaId).catch(() => undefined)
    if (!asset) {
      set({
        jobNotice: {
          kind: 'error',
          label: record.source.filename,
          message: 'The stored recording is missing, so it cannot be continued.',
        },
      })
      return
    }
    const pcm = wavToPcm(await asset.blob.arrayBuffer())
    resetLiveModule()
    pcmChunks = [pcm]
    totalSamples = pcm.length
    committedSamples = pcm.length
    // ponytail: the already-saved audio is not re-persisted as chunks, a crash mid-continue only
    // recovers the new tail, and the original WAV + transcript are still on disk untouched.
    persistedSamples = pcm.length
    liveSegments = record.asr.segments.slice()
    const committedText = liveSegments
      .map((seg) => seg.words.map((w) => w.text).join(' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    set({
      workspaceTab: 'live',
      live: {
        id: mediaId,
        recordId: record.id,
        status: 'paused',
        seconds: Math.floor(pcm.length / SR),
        committedText,
        interimText: '',
        error: null,
      },
    })
    get().setView('workspace')
    await get().continueLive()
  },

  discardLive: async () => {
    const live = get().live
    await capture?.stop().catch(() => {})
    capture = null
    if (live) await deleteRecordingChunks(live.id).catch(() => {})
    resetLiveModule()
    set({ live: null })
  },

  newLive: async () => {
    await get().discardLive()
    await get().startLive()
  },

  openPip: async (silent) => {
    try {
      await openPipWindow(() => set({ pipOpen: false }))
      set({ pipOpen: true })
    } catch (e) {
      if (silent) return
      set({
        jobNotice: {
          kind: 'error',
          label: 'Floating window',
          message: e instanceof Error ? e.message : String(e),
        },
      })
    }
  },
  closePip: () => {
    closePipWindow()
    set({ pipOpen: false })
  },
}))

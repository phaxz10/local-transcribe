import { ModelCard } from '@/components/ModelCard'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fitCheck } from '@/lib/capability'
import { recommendModel } from '@/lib/catalog'
import { benchmark, getEngine, isCancelled, type LoadStatus } from '@/lib/engine'
import { useApp } from '@/lib/store'
import { PRIMARY_LANGUAGES, type CatalogModel, type PrimaryLanguage } from '@/lib/types'
import { formatMb } from '@/lib/utils'
import { ArrowRight, Download, Loader2, RotateCcw } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

type Phase = 'idle' | 'downloading' | 'calibrating' | 'error' | 'cancelled'

export function Onboarding() {
  const catalog = useApp((s) => s.catalog)
  const capability = useApp((s) => s.capability)
  const primaryLanguage = useApp((s) => s.primaryLanguage)
  const setPrimaryLanguage = useApp((s) => s.setPrimaryLanguage)
  const setActiveModel = useApp((s) => s.setActiveModel)
  const setCapability = useApp((s) => s.setCapability)
  const setView = useApp((s) => s.setView)
  const provisioned = useApp((s) => s.provisioned)
  const activeModel = useApp((s) => s.activeModel)
  const markProvisioned = useApp((s) => s.markProvisioned)
  const evict = useApp((s) => s.evict)

  const changing = !!activeModel

  const recommended = useMemo(
    () => (capability ? recommendModel(catalog, capability, primaryLanguage) : null),
    [catalog, capability, primaryLanguage],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = catalog.find((m) => m.id === selectedId) ?? activeModel ?? recommended

  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState<LoadStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [evictTarget, setEvictTarget] = useState<CatalogModel | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const busy = phase === 'downloading' || phase === 'calibrating'

  const selectedActive = !!selected && activeModel?.id === selected.id
  const selectedProvisioned = !!selected && provisioned.includes(selected.id)

  const storageFree =
    capability?.storageQuotaMb != null && capability?.storageUsageMb != null
      ? capability.storageQuotaMb - capability.storageUsageMb
      : null

  function switchTo(m: CatalogModel) {
    setActiveModel(m)
    setView('workspace')
  }

  async function provision() {
    if (!selected || !capability) return
    setError(null)
    const fc = fitCheck(selected, capability)
    if (!fc.supported) {
      setError(fc.reason ?? 'This model cannot run on your device.')
      setPhase('error')
      return
    }
    const ac = new AbortController()
    abortRef.current = ac
    setStatus(null)
    setPhase('downloading')
    try {
      const device = await getEngine(selected, capability.device, {
        signal: ac.signal,
        onProgress: setStatus,
      })
      markProvisioned(selected.id)
      setActiveModel(selected)
      setPhase('calibrating')
      try {
        const rtf = await benchmark(selected, device)
        setCapability({ ...capability, benchmarkRtf: rtf })
      } catch {
        /* optional */
      }
      setView('workspace')
    } catch (e) {
      if (isCancelled(e)) {
        setPhase('cancelled')
      } else {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    } finally {
      abortRef.current = null
    }
  }

  function cancelDownload() {
    abortRef.current?.abort()
  }

  async function confirmEvict() {
    const t = evictTarget
    setEvictTarget(null)
    if (t) await evict(t)
  }

  const pct = Math.round((status?.ratio ?? 0) * 100)

  return (
    <div className="space-y-10">
      <ScreenHeader
        title={changing ? 'Transcription models' : 'Choose a transcription model'}
        subtitle={
          changing
            ? 'Switch models, add another one, or clear cached model files. Local data stays on this device.'
            : 'Pick a language, download one model, and start transcribing. You can change this later.'
        }
        back={{
          label: changing ? 'Transcribe' : 'Back',
          onClick: () => setView(changing ? 'workspace' : 'landing'),
        }}
        aside={
          <div className="flex items-center gap-3">
            <Label htmlFor="lang" className="text-muted-foreground">
              Primary language
            </Label>
            <Select
              value={primaryLanguage}
              disabled={busy}
              onValueChange={(v) => {
                setPrimaryLanguage(v as PrimaryLanguage)
                setSelectedId(null)
              }}
            >
              <SelectTrigger id="lang" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIMARY_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {capability && (
        <dl className="grid gap-x-8 gap-y-4 border-y py-4 text-sm sm:grid-cols-4">
          <Fact label="Engine" value={capability.webgpu ? 'WebGPU' : 'CPU fallback'} />
          <Fact label="Threads" value={String(capability.cores)} />
          <Fact
            label="Free storage"
            value={storageFree != null ? formatMb(storageFree) : 'Unknown'}
          />
          <Fact label="Suggestion tier" value={capability.tier} className="capitalize" />
        </dl>
      )}

      {capability && (
        <p className="-mt-6 text-xs text-muted-foreground">
          Browser hints, not a full hardware spec, used only to suggest a model.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {catalog.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            recommended={recommended?.id === m.id}
            selected={selected?.id === m.id}
            provisioned={provisioned.includes(m.id)}
            active={activeModel?.id === m.id}
            busy={busy}
            onSelect={(mm) => setSelectedId(mm.id)}
            onEvict={busy ? undefined : (mm) => setEvictTarget(mm)}
          />
        ))}
      </div>

      <div className="sticky bottom-4 z-10 rounded-lg border bg-popover p-4 shadow-lg">
        {busy ? (
          phase === 'downloading' ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="lt-eyebrow flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin text-primary" />
                  Downloading {selected?.label}
                </span>
                <span className="lt-num text-sm">{pct}%</span>
              </div>
              <Progress value={pct} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="lt-num text-xs text-muted-foreground">
                  {status && status.totalBytes > 0
                    ? `${formatMb(status.loadedBytes / 1e6)} / ${formatMb(
                        status.totalBytes / 1e6,
                      )} · file ${status.fileIndex}/${status.fileCount}`
                    : 'Starting'}
                </span>
                <Button variant="ghost" size="sm" onClick={cancelDownload}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Downloads cannot resume. Cancelling means starting over next time.
              </p>
            </div>
          ) : (
            <p className="lt-eyebrow flex items-center gap-2">
              <Loader2 className="size-3 animate-spin text-primary" /> Calibrating your
              browser
            </p>
          )
        ) : phase === 'error' ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{error}</p>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setError(null)
                  setPhase('idle')
                }}
              >
                Choose another
              </Button>
              <Button onClick={provision}>
                <RotateCcw className="size-4" /> Try again
              </Button>
            </div>
          </div>
        ) : phase === 'cancelled' ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Download cancelled. Starting again downloads from the beginning.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={() => setPhase('idle')}>
                Choose another
              </Button>
              <Button onClick={provision}>
                <RotateCcw className="size-4" /> Download again
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {selected?.label ?? 'Select a model'}
              </div>
              <div className="lt-eyebrow mt-1.5">
                {selected
                  ? selectedActive
                    ? 'Active on this device'
                    : selectedProvisioned
                      ? 'Downloaded · switches instantly'
                      : `${formatMb(selected.sizeMb)} · cached after the first download`
                  : 'Pick a model to continue'}
              </div>
            </div>
            {selected &&
              (selectedActive ? (
                <Button className="w-full sm:w-auto" onClick={() => setView('workspace')}>
                  Open workspace <ArrowRight className="size-4" />
                </Button>
              ) : selectedProvisioned ? (
                <Button className="w-full sm:w-auto" onClick={() => switchTo(selected)}>
                  Use this model
                </Button>
              ) : (
                <Button className="w-full sm:w-auto" onClick={provision}>
                  <Download className="size-4" /> Download and continue
                </Button>
              ))}
          </div>
        )}
      </div>

      <Dialog open={!!evictTarget} onOpenChange={(o) => !o && setEvictTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {evictTarget?.label} from this device?</DialogTitle>
            <DialogDescription>
              This frees its storage
              {evictTarget && activeModel?.id === evictTarget.id
                ? ' and unloads it as your active model'
                : ''}
              . Your transcripts and settings are kept, and you can download it again
              anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEvictTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmEvict}>
              Remove from device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Fact({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="space-y-1.5">
      <dt className="lt-eyebrow">{label}</dt>
      <dd className={className}>{value}</dd>
    </div>
  )
}

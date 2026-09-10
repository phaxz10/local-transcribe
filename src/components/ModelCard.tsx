import { Trash2 } from 'lucide-react'
import type { CatalogModel, EngineDevice } from '@/lib/types'
import { cn, formatMb } from '@/lib/utils'

const LANG_LABELS: Record<string, string> = {
  en: 'EN',
  zh: 'ZH',
  yue: 'YUE',
  ja: 'JA',
  tl: 'TL',
}
const TRANSCRIPTION_LANG_ORDER = ['en', 'zh', 'yue', 'ja', 'tl']

function Dots({ q }: { q: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            'size-1 rounded-full',
            i <= q ? 'bg-foreground/70' : 'bg-foreground/15',
          )}
        />
      ))}
    </span>
  )
}

export function ModelCard({
  model,
  recommended,
  selected,
  provisioned,
  active,
  busy,
  device,
  onSelect,
  onEvict,
}: {
  model: CatalogModel
  recommended: boolean
  selected: boolean
  /** Weights are present in Cache Storage. */
  provisioned: boolean
  /** This is the Active Model. */
  active: boolean
  busy?: boolean
  /** Used to show `sizeMbWasm` instead of `sizeMb` when the download will run on WASM. */
  device?: EngineDevice
  onSelect: (m: CatalogModel) => void
  onEvict?: (m: CatalogModel) => void
}) {
  const disabled = !model.available || busy
  const sizeMb = (device === 'wasm' && model.sizeMbWasm) || model.sizeMb
  const status = active
    ? 'Active'
    : provisioned
      ? 'Downloaded'
      : recommended
        ? 'Recommended'
        : ''
  const modelScope = model.multilingual ? 'Multilingual' : 'English only'
  const engineNote = model.requiresWebGPU ? 'Requires WebGPU' : 'WebGPU or CPU'

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected}
      onClick={() => !disabled && onSelect(model)}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(model)
        }
      }}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-foreground/25',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">{model.label}</div>
          <div className="lt-eyebrow mt-1.5">
            {provisioned
              ? 'Ready offline'
              : sizeMb > 0
                ? `${formatMb(sizeMb)} download`
                : 'Size varies'}
          </div>
        </div>
        {status && (
          <span
            className={cn(
              'lt-eyebrow shrink-0',
              (active || recommended) && 'text-primary',
            )}
          >
            {status}
          </span>
        )}
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        {modelScope}. {engineNote}.
        {model.timestamps === 'none' && ' No word timings: seek is approximate.'}
      </p>

      <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3">
        <div className="flex items-center gap-3">
          {TRANSCRIPTION_LANG_ORDER.map((l) => (
            <div key={l} className="flex flex-col items-center gap-1">
              <span className="lt-eyebrow text-[10px]">{LANG_LABELS[l]}</span>
              <Dots q={model.languages[l] ?? 0} />
            </div>
          ))}
        </div>
        {provisioned && onEvict && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onEvict(model)
            }}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-destructive-soft focus-visible:ring-2 focus-visible:ring-ring"
            title={`Remove ${model.label} from this device`}
            aria-label={`Remove ${model.label} from this device`}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

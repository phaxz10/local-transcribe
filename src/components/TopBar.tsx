import type { ReactNode } from 'react'
import { Mic, History as HistoryIcon, ChevronsUpDown, Coffee } from 'lucide-react'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { JobIndicator } from '@/components/JobIndicator'
import { ThemeToggle } from '@/components/ThemeToggle'
import { BUYMEACOFFEE_URL } from '@/components/Support'
import { cn } from '@/lib/utils'

export function TopBar() {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const activeModel = useApp((s) => s.activeModel)
  const capability = useApp((s) => s.capability)
  const isolated = capability?.crossOriginIsolated

  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-1 px-4 md:px-6">
        <button
          onClick={() => setView(activeModel ? 'workspace' : 'landing')}
          className="-ml-1 flex h-10 items-center gap-2 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Home"
        >
          <Mic className="size-4 text-primary" />
          <span className="text-[15px] font-semibold tracking-tight">
            LocalTranscribeAI
          </span>
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          <JobIndicator />

          <nav className="flex items-center gap-0.5">
            <NavLink
              active={view === 'workspace'}
              onClick={() => setView('workspace')}
              icon={<Mic className="size-4" />}
              label="Transcribe"
            />
            <NavLink
              active={view === 'history'}
              onClick={() => setView('history')}
              icon={<HistoryIcon className="size-4" />}
              label="History"
            />
          </nav>

          {activeModel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView('onboarding')}
              title="Change model or manage downloads"
              className="ml-1 hidden h-10 gap-1.5 text-muted-foreground hover:text-foreground lg:inline-flex"
            >
              <span className="lt-eyebrow text-inherit">{activeModel.label}</span>
              <ChevronsUpDown className="size-3 opacity-60" />
            </Button>
          )}

          <span className="mx-1 hidden h-5 w-px bg-border sm:block" />

          <ThemeToggle />

          <Button
            variant="ghost"
            size="icon"
            asChild
            className="text-muted-foreground hover:text-foreground"
          >
            <a
              href={BUYMEACOFFEE_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Buy me a coffee"
              aria-label="Buy me a coffee"
            >
              <Coffee className="size-4" />
            </a>
          </Button>

          <span
            title={
              isolated
                ? 'Cross-origin isolated. Multi-thread engine active.'
                : 'Not cross-origin isolated. Engine limited.'
            }
            aria-label={
              isolated ? 'Multi-thread engine active' : 'Engine limited to a single thread'
            }
            className={cn(
              'ml-1 hidden size-1.5 shrink-0 rounded-full sm:block',
              isolated ? 'bg-primary' : 'bg-destructive-soft',
            )}
          />
        </div>
      </div>
    </header>
  )
}

function NavLink({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex h-10 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

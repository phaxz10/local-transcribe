import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useApp, viewFromHash } from '@/lib/store'
import { TopBar } from '@/components/TopBar'
import { LivePip } from '@/components/LivePip'
import { Landing } from '@/screens/Landing'
import { Onboarding } from '@/screens/Onboarding'
import { Workspace } from '@/screens/Workspace'
import { TranscriptView } from '@/screens/TranscriptView'
import { HistoryView } from '@/screens/HistoryView'

function Booting() {
  return (
    <div className="flex flex-1 items-center justify-center py-32 text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" /> Preparing workspace
    </div>
  )
}

export default function App() {
  const ready = useApp((s) => s.ready)
  const view = useApp((s) => s.view)
  const init = useApp((s) => s.init)
  const setView = useApp((s) => s.setView)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onHashChange = () => {
      const next = viewFromHash()
      if (next) setView(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [setView])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-full flex-col">
        <TopBar />
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-24 pt-10 md:px-6">
          {!ready ? (
            <Booting />
          ) : view === 'landing' ? (
            <Landing />
          ) : view === 'onboarding' ? (
            <Onboarding />
          ) : view === 'workspace' ? (
            <Workspace />
          ) : view === 'transcript' ? (
            <TranscriptView />
          ) : view === 'history' ? (
            <HistoryView />
          ) : null}
        </main>
        <LivePip />
      </div>
    </TooltipProvider>
  )
}

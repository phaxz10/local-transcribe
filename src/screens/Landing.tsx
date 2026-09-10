import { ArrowRight } from 'lucide-react'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { NoModelState } from '@/components/NoModelState'
import { HowItWorks } from '@/components/HowItWorks'
import { SupportLine } from '@/components/Support'

export function Landing() {
  const activeModel = useApp((s) => s.activeModel)
  const setView = useApp((s) => s.setView)

  if (!activeModel) {
    return <NoModelState onSetup={() => setView('onboarding')} />
  }

  return (
    <div className="space-y-16 py-6">
      <section className="max-w-2xl space-y-6">
        <p className="lt-eyebrow">Runs on this device</p>
        <h1 className="text-[34px] font-semibold leading-[1.1] sm:text-[44px]">
          Transcription that never leaves your browser.
        </h1>
        <p className="max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Speak into the microphone or drop in a file. The model runs here, on your
          machine. Nothing is uploaded, and there is no account to make.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button size="lg" onClick={() => setView('workspace')}>
            Start transcribing
            <ArrowRight className="size-4" />
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setView('history')}>
            History
          </Button>
        </div>
        <p className="lt-eyebrow pt-2">Model in use · {activeModel.label}</p>
      </section>

      <HowItWorks />

      <footer className="border-t pt-6">
        <SupportLine />
      </footer>
    </div>
  )
}

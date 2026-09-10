import { ArrowRight } from 'lucide-react'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { NoModelState } from '@/components/NoModelState'
import { HowItWorks } from '@/components/HowItWorks'
import { FamilyLine, HeroLockup } from '@/components/Support'

export function Landing() {
  const activeModel = useApp((s) => s.activeModel)
  const setView = useApp((s) => s.setView)

  if (!activeModel) {
    return <NoModelState onSetup={() => setView('onboarding')} />
  }

  return (
    <div className="space-y-16 py-6">
      <section className="max-w-2xl space-y-6">
        <HeroLockup />
        <p className="lt-eyebrow">Runs on this device</p>
        <h1 className="lt-display text-[34px] leading-[1.1] sm:text-[44px]">
          Speech becomes notes, on your own machine.
        </h1>
        <p className="max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Speak into the microphone or drop in a file. The model runs here, in this
          browser. Nothing is uploaded, and there is no account to make.
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

      <FamilyLine />
    </div>
  )
}

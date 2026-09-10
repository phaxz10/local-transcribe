import { HowItWorks } from '@/components/HowItWorks'
import { FamilyLine, HeroLockup } from '@/components/Support'
import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'

/** Shown wherever the app needs an Active Model and there isn't one yet. */
export function NoModelState({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="space-y-16 py-6">
      <section className="max-w-2xl space-y-6">
        <HeroLockup />
        <h1 className="lt-display text-[34px] leading-[1.1] sm:text-[44px]">
          Speech becomes notes, on your own machine.
        </h1>
        <p className="max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Speak into the microphone or drop in a file. Pick a transcription model to
          start. It downloads once, then works offline.
        </p>
        <div className="pt-2">
          <Button size="lg" onClick={onSetup}>
            Choose a model
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </section>

      <HowItWorks />

      <FamilyLine />
    </div>
  )
}

import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HowItWorks } from '@/components/HowItWorks'

/** Shown wherever the app needs an Active Model and there isn't one yet. */
export function NoModelState({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="space-y-16 py-6">
      <section className="max-w-2xl space-y-6">
        <p className="lt-eyebrow">Runs on this device</p>
        <h1 className="text-[34px] font-semibold leading-[1.1] sm:text-[44px]">
          Transcription that never leaves your browser.
        </h1>
        <p className="max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Speak into the microphone or drop in a file. Choose a transcription model to
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
    </div>
  )
}

const STEPS = [
  {
    title: 'Download a model, once',
    body: 'Pick a size that suits your device. It is cached in this browser and works offline afterwards.',
  },
  {
    title: 'Record or drop a file',
    body: 'Talk into the microphone and watch the words land, or hand it an audio or video file.',
  },
  {
    title: 'Copy, edit, export',
    body: 'Fix a word by clicking it, then copy the text or export it as TXT, SRT, VTT, JSON, or Markdown.',
  },
]

/** The three steps in order, the numbering is the sequence, not decoration. */
export function HowItWorks() {
  return (
    <section className="space-y-6">
      <h2 className="lt-eyebrow">How it works</h2>
      <ol className="grid gap-6 sm:grid-cols-3 sm:gap-8">
        {STEPS.map((s, i) => (
          <li key={s.title} className="space-y-2">
            <span className="lt-num text-sm text-foreground">{i + 1}</span>
            <h3 className="text-sm font-medium">{s.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

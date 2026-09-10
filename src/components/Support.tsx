export const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/phaxz10'

/**
 * The quiet support line for the Landing screen. The header carries an icon-only
 * link instead (see TopBar), both pointing at {@link BUYMEACOFFEE_URL}.
 */
export function SupportLine() {
  return (
    <p className="text-sm text-muted-foreground">
      Free, and it stays free.{' '}
      <a
        href={BUYMEACOFFEE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-sm text-foreground underline decoration-border underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Buy me a coffee
      </a>{' '}
      if it saved you some time.
    </p>
  )
}

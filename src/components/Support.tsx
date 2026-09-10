import { BRAND } from '@/lib/brand'
import { ScribeMark } from '@/components/TopBar'

/**
 * The brand furniture: the hero lockup, the line placing Scribe in the family, and the
 * footer every screen carries. All three read their strings from {@link BRAND}.
 */

/**
 * The full name, shown only on the Landing hero. The bar says "Scribe" on its own,
 * because inside the app the family is not the context (docs/brand.md).
 */
export function HeroLockup() {
  return (
    <p className="flex items-center gap-2.5 text-[15px] text-muted-foreground">
      <ScribeMark className="size-7" />
      <span>
        <span className="lt-display text-[19px] text-foreground">{BRAND.name}</span>{' '}
        by {BRAND.family}
      </span>
    </p>
  )
}

/** Where Scribe sits. One line, one named link, no badges. */
export function FamilyLine() {
  return (
    <section className="border-t pt-6">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {BRAND.name} is a {BRAND.family} app, alongside Pages, Memories, Queue and
        Heimdal.{' '}
        <a
          href={BRAND.familyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="lt-link"
        >
          See the {BRAND.family} apps
        </a>
        .
      </p>
    </section>
  )
}

/**
 * The one footer, mounted once in App.tsx so every screen carries it. The header
 * carries an icon-only coffee link instead (see TopBar); both point at {@link BRAND.coffee}.
 */
export function Footer() {
  return (
    <footer className="mx-auto w-full max-w-4xl px-4 pb-10 md:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t pt-5 text-sm text-muted-foreground">
        <span>{BRAND.full}</span>
        <span aria-hidden="true">·</span>
        <a href={`mailto:${BRAND.email}`} className="lt-link">
          {BRAND.email}
        </a>
        <span aria-hidden="true">·</span>
        <span>{BRAND.legalName}</span>
        <a
          href={BRAND.coffee}
          target="_blank"
          rel="noopener noreferrer"
          className="lt-link sm:ml-auto"
        >
          Buy me a coffee
        </a>
      </div>
    </footer>
  )
}

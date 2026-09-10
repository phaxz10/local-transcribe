import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

/**
 * The one header shape every screen uses: an optional back link, a title, a single
 * line of context, and an optional control on the right.
 */
export function ScreenHeader({
  title,
  subtitle,
  back,
  aside,
}: {
  title: string
  subtitle?: ReactNode
  back?: { label: string; onClick: () => void }
  aside?: ReactNode
}) {
  return (
    <header className="space-y-3">
      {back && (
        <button
          onClick={back.onClick}
          className="-ml-1 inline-flex h-8 items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-3.5" />
          {back.label}
        </button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="min-w-0 break-words text-2xl font-semibold sm:text-[28px]">{title}</h1>
        {aside}
      </div>
      {subtitle && (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {subtitle}
        </p>
      )}
    </header>
  )
}

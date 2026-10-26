import type { ReactNode } from 'react'
import ScopeToggle from './ScopeToggle.tsx'
import SyncPill from './SyncPill.tsx'

// The header on every screen (docs/design/handoff.md "Global layout"). Each
// screen renders its own, so a subtitle that comes from data ("$X due before
// payday") is that screen's business and never an edit to the route table.
// `controls` is a screen's own header control, drawn just left of the scope
// toggle (the Subscriptions screen's Active / Cancelled switch, issue 390).
export default function ScreenHeader({
  title,
  subtitle,
  controls,
}: {
  title: string
  subtitle?: string
  controls?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="font-display text-display-22 font-medium text-deep shell:hidden">
          Divvy
        </span>
        <h1 className="m-0 font-display text-display-36 font-semibold leading-none tracking-title text-deep">
          {title}
        </h1>
        {subtitle && (
          <span className="text-body-14 text-ink-muted">{subtitle}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {controls}
        <ScopeToggle />
        <SyncPill />
      </div>
    </header>
  )
}

import ScopeToggle from './ScopeToggle.tsx'
import SyncPill from './SyncPill.tsx'

// The header on every screen (docs/design/handoff.md "Global layout"). Each
// screen renders its own, so a subtitle that comes from data ("$X due before
// payday") is that screen's business and never an edit to the route table.
export default function ScreenHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
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
        <ScopeToggle />
        <SyncPill />
      </div>
    </header>
  )
}

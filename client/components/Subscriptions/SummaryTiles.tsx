import { formatCents } from '../../../shared/money.ts'
import type { SubscriptionTotals } from '../../../shared/contracts.ts'
import { plural } from './format.ts'

// The two totals above the list, exactly as the route computed them
// (shared/subscriptions.ts): nothing here adds, multiplies or divides. The
// design's "Barely used" tile is not shown; Divvy has no usage data.
// Active rows with no regular pattern are left out of both figures, and a
// line says how many.
export default function SummaryTiles({ totals }: { totals: SubscriptionTotals }) {
  const uncounted = totals.uncountedCount
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <Tile label="Per month" testId="total-month" cents={totals.perMonthCents} />
        <Tile label="Per year" testId="total-year" cents={totals.perYearCents} />
      </div>
      {uncounted > 0 && (
        <p className="m-0 text-body-12 text-ink-muted">
          {`${plural(uncounted, 'subscription')} left out of these totals: no regular pattern yet`}
        </p>
      )}
    </div>
  )
}

function Tile({
  label,
  testId,
  cents,
}: {
  label: string
  testId: string
  cents: number
}) {
  return (
    <div className="flex flex-col gap-1 rounded-summary bg-surface p-5 shadow-card">
      <span className="text-body-12 text-ink-muted">{label}</span>
      <span
        data-testid={testId}
        className="font-display text-display-34 font-medium leading-none text-ink"
      >
        {formatCents(cents)}
      </span>
    </div>
  )
}

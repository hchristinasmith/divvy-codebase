import type { ReactNode } from 'react'
import { formatCents } from '../../../shared/money.ts'
import type { CategoriseGroupResponse } from '../../../shared/contracts.ts'
import { formatDay } from '../Overview/format.ts'
import { CARD, EYEBROW, MUTED } from '../Overview/styles.ts'

// One merchant's card (prd-02 Ruling 17): its name, how many uncategorised
// transactions it has, the total spent, what came back when anything did,
// and the latest date and amount. Every figure is the server's, formatted by
// `formatCents`. The name is bank text, so it is rendered as text, never as
// markup. The card's actions are its children.

function latestLine(group: CategoriseGroupResponse): string {
  const amount = formatCents(group.latestAmountCents)
  if (group.latestDate === null) return `Latest ${amount}`
  // No `today`, so the year is always shown: uncategorised history can span
  // more than one.
  return `Latest ${formatDay(group.latestDate, '')} · ${amount}`
}

export default function GroupCard({
  group,
  position,
  children,
}: {
  group: CategoriseGroupResponse
  position: string
  children: ReactNode
}) {
  return (
    <section
      aria-label="Merchant"
      className={`${CARD} flex min-w-0 flex-col gap-4 p-6`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className={`${EYEBROW} text-deep`}>Uncategorised</p>
        <p
          data-testid="sort-progress"
          className="m-0 font-mono text-body-13 text-ink-muted"
        >
          {position}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <h2
          data-testid="sort-merchant"
          className="m-0 break-words font-display text-display-28 font-semibold text-ink"
        >
          {group.name}
        </h2>
        <p className={MUTED}>
          {group.count} {group.count === 1 ? 'transaction' : 'transactions'}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <p data-testid="sort-total" className="m-0 font-mono text-body-15 text-ink">
          {formatCents(group.totalCents)} spent
        </p>
        {group.receivedCents > 0 && (
          <p
            data-testid="sort-received"
            className="m-0 font-mono text-body-13 text-ink-muted"
          >
            +{formatCents(group.receivedCents)} received
          </p>
        )}
        <p
          data-testid="sort-latest"
          className="m-0 font-mono text-body-13 text-ink-muted"
        >
          {latestLine(group)}
        </p>
      </div>
      {children}
    </section>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { spendingByCategoryQuery } from '../../apis/overview.ts'
import { formatCents } from '../../../shared/money.ts'
import type {
  Scope,
  SpendingByCategoryResponse,
} from '../../../shared/contracts.ts'
import { SpendingBar, SpendingSwatch, linesOf } from './SpendingBar.tsx'
import {
  CARD,
  CARD_TITLE,
  ERROR,
  EYEBROW,
  LINK,
  MUTED,
  SECONDARY_BUTTON,
} from './styles.ts'

// Spending by category (issue 271): this month's total, a bar split by category
// and the same lines as a list, largest first, then "Other" and
// "Uncategorised". Every figure is the server's (prd-02 Ruling 1, note of
// 2026-10-25): the grouping into the top few and "Other" is the route's, and
// nothing here adds anything up.
//
// The card reads its own query, so a failure here shows on this card and
// never blanks the Overview. The query sits under the overview's key, so
// anything that refreshes the Overview (an inline category edit) refreshes
// this too. A scope switch shows the loading line until that scope's
// figures arrive, never the previous scope's.
//
// The bar and its colours are ./SpendingBar.tsx, shared with the Spending
// screen.
//
// The whole card links to the Spending screen (issue 272): the heading's link is
// stretched over it, and the card shows the focus outline while that link
// has focus (not while Try again does).

const SPENDING_PATH = '/spending'

export default function SpendingCard({ scope }: { scope: Scope }) {
  const spending = useQuery(spendingByCategoryQuery(scope))

  return (
    <section
      aria-labelledby="spending-heading"
      data-testid="spending-card"
      className={`${CARD} relative flex flex-col gap-4 p-6 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-pink`}
    >
      <h2 id="spending-heading" className={CARD_TITLE}>
        <Link
          to={SPENDING_PATH}
          className={`${LINK} focus-visible:outline-none after:absolute after:inset-0`}
        >
          Spending by category
        </Link>
      </h2>
      {spending.isPending ? (
        <p className={MUTED}>Loading spending…</p>
      ) : spending.data === undefined ? (
        // Above the stretched link, so Try again can be pressed.
        <div role="alert" className="relative flex flex-col items-start gap-3">
          <p className={ERROR}>{spending.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void spending.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <SpendingBody data={spending.data} />
      )}
    </section>
  )
}

function SpendingBody({ data }: { data: SpendingByCategoryResponse }) {
  if (data.totalCents === 0) {
    return (
      <div className="flex flex-col gap-1">
        <p className={`${EYEBROW} text-deep`}>This month</p>
        <p className={MUTED}>No spending yet this month.</p>
      </div>
    )
  }
  const lines = linesOf(data)
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className={`${EYEBROW} text-deep`}>This month</p>
        <span
          data-testid="spending-total"
          className="font-display text-display-40 font-medium leading-none tracking-title text-ink"
        >
          {formatCents(data.totalCents)}
        </span>
      </div>
      <SpendingBar lines={lines} />
      <ul
        aria-label="Top spending categories"
        className="m-0 flex list-none flex-col gap-2 p-0"
      >
        {lines.map((line) => (
          <li
            key={line.key}
            data-spending-line={line.kind}
            className="flex items-center gap-2.5"
          >
            <SpendingSwatch line={line} />
            <span className="min-w-0 flex-1 truncate text-body-14 text-ink">
              {line.label}
            </span>
            <span className="shrink-0 font-mono text-body-14 text-ink">
              {formatCents(line.cents)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

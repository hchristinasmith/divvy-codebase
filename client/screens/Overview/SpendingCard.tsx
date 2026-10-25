import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { spendingByCategoryQuery } from '../../apis/overview.ts'
import { formatCents } from '../../../shared/money.ts'
import type {
  Scope,
  SpendingByCategoryResponse,
} from '../../../shared/contracts.ts'
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
// The whole card links to the Spending screen (issue 272): the heading's link is
// stretched over it, and the card shows the focus outline while that link
// has focus (not while Try again does).

const SPENDING_PATH = '/spending'

// By rank, then the tail. Theme colours only, and none of ok, warn or
// danger: a category is not good or bad.
const RANK_COLOURS = [
  'bg-deep',
  'bg-pink',
  'bg-rose',
  'bg-blush-hover',
  'bg-ink-faint',
]
const OTHER_COLOUR = 'bg-ink-muted'
const UNCATEGORISED_COLOUR = 'bg-line'

interface Line {
  key: string
  kind: 'category' | 'other' | 'uncategorised'
  label: string
  cents: number
  colour: string
}

function linesOf(data: SpendingByCategoryResponse): Line[] {
  const lines: Line[] = data.categories.map((line, rank) => ({
    key: `category:${line.category}`,
    kind: 'category',
    label: line.category,
    cents: line.spentCents,
    colour: RANK_COLOURS[rank % RANK_COLOURS.length],
  }))
  if (data.otherCents > 0) {
    lines.push({
      key: 'other',
      kind: 'other',
      label: 'Other',
      cents: data.otherCents,
      colour: OTHER_COLOUR,
    })
  }
  if (data.uncategorisedCents > 0) {
    lines.push({
      key: 'uncategorised',
      kind: 'uncategorised',
      label: 'Uncategorised',
      cents: data.uncategorisedCents,
      colour: UNCATEGORISED_COLOUR,
    })
  }
  return lines
}

export default function SpendingCard({ scope }: { scope: Scope }) {
  const spending = useQuery(spendingByCategoryQuery(scope))

  return (
    <section
      aria-labelledby="spending-heading"
      data-testid="spending-card"
      className={`${CARD} relative flex flex-col gap-4 p-5.5 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-pink`}
    >
      <h2 id="spending-heading" className={CARD_TITLE}>
        <Link
          to={SPENDING_PATH}
          className={`${LINK} after:absolute after:inset-0`}
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
      {/* Each segment's width is its line's share of the bar: `flexGrow`
          takes the cents as they are. That is presentation, not money
          arithmetic; the list below carries the figures. */}
      <div
        aria-hidden="true"
        data-testid="spending-bar"
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-pill bg-canvas"
      >
        {lines.map((line) => (
          <span
            key={line.key}
            data-spending-segment={line.kind}
            className={`min-w-0 basis-0 ${line.colour}`}
            style={{ flexGrow: line.cents }}
          />
        ))}
      </div>
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
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 rounded-pill ${line.colour}`}
            />
            <span className="min-w-0 flex-1 truncate text-body-14 text-ink">
              {line.label}
            </span>
            <span className="font-mono text-body-14 text-ink">
              {formatCents(line.cents)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

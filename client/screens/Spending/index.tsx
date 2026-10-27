import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import {
  monthSpendingQuery,
  spendingTransactionsQuery,
} from '../../apis/overview.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import { formatCents } from '../../../shared/money.ts'
import { nzCalendarDate } from '../../../shared/nz-dates.ts'
import type {
  Scope,
  SpendingByCategoryResponse,
} from '../../../shared/contracts.ts'
import type { TransactionRow } from '../../../models/transactions.ts'
import { formatDay } from '../Overview/format.ts'
import {
  SpendingBar,
  SpendingSwatch,
  linesOf,
} from '../Overview/SpendingBar.tsx'
import {
  CARD,
  CARD_TITLE,
  ERROR,
  EYEBROW,
  FOCUS,
  MUTED,
  SECONDARY_BUTTON,
} from '../Overview/styles.ts'
import { monthLabel, nzMonth, shiftMonth } from './month.ts'

// The Spending screen (prd-02, issue 272), behind the Overview's "Spending
// by category" card: one NZ calendar month's spending in the toggle's
// scope, the card's storage-style bar, and every category with its total,
// then Uncategorised. There is no "Other": the month is read without `top`,
// so the route lists every category. Tapping a category lists the rows its
// figure counts, read from GET /api/v1/transactions with the same scope,
// month and category.
//
// Every figure is the server's (prd-02 Ruling 1, note of 2026-10-25): the
// total and each line come from GET /api/v1/spending/categories, and each
// row's amount is its own, formatted as it is. Nothing here adds anything
// up. Uncategorised is a line but not a button: the transactions route
// filters by a category name, and an uncategorised row has none.
//
// The month starts at today's in NZ. A scope or month switch shows the
// loading line until that month's figures arrive, and closes the open
// category: a list from one month or scope is never shown under another.

interface OpenCategory {
  scope: Scope
  month: string
  category: string
}

export default function Spending() {
  const { scope } = useScope()
  const [month, setMonth] = useState(() => nzMonth(new Date()))
  const [open, setOpen] = useState<OpenCategory | null>(null)
  const spending = useQuery(monthSpendingQuery(scope, month))

  const openCategory =
    open !== null && open.scope === scope && open.month === month
      ? open.category
      : null
  // Forgotten on a switch, so going back to that month or scope does not
  // reopen it.
  if (open !== null && openCategory === null) setOpen(null)

  function toggle(category: string) {
    setOpen(
      openCategory === category ? null : { scope, month, category },
    )
  }

  return (
    <>
      <ScreenHeader title="Spending" />
      <section aria-label="Spending" className="flex flex-col gap-4">
        <MonthPicker month={month} onChange={setMonth} />
        <div className={`${CARD} flex flex-col gap-4 p-6`}>
          {spending.isPending ? (
            <p className={MUTED}>Loading spending…</p>
          ) : spending.data === undefined ? (
            <div role="alert" className="flex flex-col items-start gap-3">
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
            <SpendingBody
              data={spending.data}
              openCategory={openCategory}
              onToggle={toggle}
            />
          )}
        </div>
      </section>
    </>
  )
}

function MonthPicker({
  month,
  onChange,
}: {
  month: string
  onChange: (month: string) => void
}) {
  return (
    <div role="group" aria-label="Month" className="flex items-center gap-3">
      <button
        type="button"
        aria-label="Previous month"
        className={SECONDARY_BUTTON}
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        ‹
      </button>
      <h2
        data-testid="spending-month"
        aria-live="polite"
        className={`${CARD_TITLE} min-w-36 text-center text-deep`}
      >
        {monthLabel(month)}
      </h2>
      <button
        type="button"
        aria-label="Next month"
        className={SECONDARY_BUTTON}
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        ›
      </button>
    </div>
  )
}

function SpendingBody({
  data,
  openCategory,
  onToggle,
}: {
  data: SpendingByCategoryResponse
  openCategory: string | null
  onToggle: (category: string) => void
}) {
  const panelPrefix = useId()
  if (data.totalCents === 0) {
    return (
      <p className={MUTED}>No spending in {monthLabel(data.month)}.</p>
    )
  }
  const lines = linesOf(data)
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className={`${EYEBROW} text-deep`}>Spent</p>
        <span
          data-testid="spending-total"
          className="font-display text-display-40 font-medium leading-none tracking-title text-ink"
        >
          {formatCents(data.totalCents)}
        </span>
      </div>
      <SpendingBar lines={lines} />
      <ul
        aria-label="Spending categories"
        className="m-0 flex list-none flex-col gap-1 p-0"
      >
        {lines.map((line, index) => {
          const amount = (
            <span className="shrink-0 font-mono text-body-14 text-ink">
              {formatCents(line.cents)}
            </span>
          )
          const label = (
            <span className="min-w-0 flex-1 truncate text-body-14 text-ink">
              {line.label}
            </span>
          )
          if (line.kind !== 'category') {
            return (
              <li
                key={line.key}
                data-spending-line={line.kind}
                className="flex items-center gap-2.5 px-2 py-1.5"
              >
                <SpendingSwatch line={line} />
                {label}
                {amount}
              </li>
            )
          }
          const expanded = openCategory === line.label
          const panelId = `${panelPrefix}-${index}`
          return (
            <li
              key={line.key}
              data-spending-line={line.kind}
              className="flex flex-col"
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={expanded ? panelId : undefined}
                onClick={() => onToggle(line.label)}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-pill bg-transparent px-2 py-1.5 text-left hover:bg-canvas ${FOCUS}`}
              >
                <SpendingSwatch line={line} />
                {label}
                {amount}
              </button>
              {expanded && (
                <CategoryTransactions
                  id={panelId}
                  scope={data.scope}
                  month={data.month}
                  category={line.label}
                />
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function CategoryTransactions({
  id,
  scope,
  month,
  category,
}: {
  id: string
  scope: Scope
  month: string
  category: string
}) {
  const txns = useQuery(spendingTransactionsQuery(scope, month, category))
  const today = nzCalendarDate(new Date())
  return (
    <div id={id} className="flex flex-col gap-2 pb-2 pl-7 pr-2">
      {txns.isPending ? (
        <p className={MUTED}>Loading transactions…</p>
      ) : txns.data === undefined ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className={ERROR}>{txns.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void txns.refetch()}
          >
            Try again
          </button>
        </div>
      ) : txns.data.length === 0 ? (
        <p className={MUTED}>No transactions.</p>
      ) : (
        <ul
          aria-label={`${category} transactions`}
          className="m-0 flex list-none flex-col p-0"
        >
          {txns.data.map((row) => (
            <TransactionLine key={row.id} row={row} today={today} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** A stored instant as its NZ calendar day label; blank when it is none. */
function rowDay(date: string | null, today: string): string {
  if (date === null) return ''
  const at = new Date(date)
  if (Number.isNaN(at.getTime())) return ''
  return formatDay(nzCalendarDate(at), today)
}

function TransactionLine({
  row,
  today,
}: {
  row: TransactionRow
  today: string
}) {
  return (
    <li
      data-transaction-id={row.id}
      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-divider py-2"
    >
      <span className="font-mono text-body-12 text-ink-muted">
        {rowDay(row.date, today)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-14 text-ink">
          {row.merchant_name ?? row.description}
        </span>
        {row.status === 'pending' && (
          <span className="text-body-12 text-ink-muted">Pending</span>
        )}
      </span>
      <span className="font-mono text-body-14 text-ink">
        {row.amount_cents === null ? '' : formatCents(row.amount_cents)}
      </span>
    </li>
  )
}

// Spending by category: the one place a month's outflow per category is
// added up (prd-02 Ruling 1, note of 2026-10-25, #271).
// `server/db/spending.ts` loads rows and calls `spendingByCategory`; the
// route sends what it returns, and the Overview's "Spending by category"
// card displays it, the top-n grouping and "Other" included, with no client
// sum. Nothing else re-derives a category total.
//
// - A row counts when it is in the view's scope (`all` is both), its NZ
//   date falls in the month, it is money out, `countsAsSpending` says
//   so, and it is not a leg of an own-account transfer. Pending and settled
//   rows count alike. Money in (income, a refund) is not spending and never
//   offsets it, as for a budget's spent (`budgetSpentCents`,
//   ./safe-to-spend.ts).
// - Own-account transfers are ruled (Baseline decision 0a37d21b, pair match,
//   #431): the pairing is `findOwnTransfers` in ./habits.ts, reused, not a
//   second matcher. It runs inside `spendingByCategory`, not in
//   `countsAsSpending`, because a pair needs both legs and that function
//   sees one row. Like `transferLegsInView` in ./habits.ts it pairs only
//   among the view's own in-scope, non-drawing rows, dated within
//   TRANSFER_WINDOW_DAYS of the month either side, so a leg dated the day
//   before the month still finds its partner.
// - The category is the effective one the caller hands in: the user's over
//   Akahu's (prd-01 Ruling 4), with drawings already laid over
//   (./drawings.ts). A row with none is uncategorised, kept apart from every
//   category and from "Other".
// - Lines are largest first; equal amounts are ordered by category in
//   code-point order, so the order never depends on the input's. With `top`,
//   the lines beyond it are summed into `otherCents`.
//
// Money is integer cents (M1 #8), summed with `sumCents`. Dates are
// `YYYY-MM-DD` calendar dates; the caller turns each instant into Hannah's
// NZ date. Nothing here reads the clock.

import type {
  Cents,
  IsoDate,
  RowScope,
  Scope,
  SpendingByCategoryResponse,
  SpendingCategoryLine,
  TransactionStatus,
} from './contracts.ts'
import { isDrawingCategory } from './drawings.ts'
import {
  TRANSFER_WINDOW_DAYS,
  findOwnTransfers,
  type HabitTransaction,
} from './habits.ts'
import { sumCents } from './money.ts'
import { daysBetween, daysInMonth } from './safe-to-spend.ts'
import { isIsoDate } from './subscriptions.ts'

/** The most lines `top` may ask for. */
export const SPENDING_TOP_MAX = 50

/** One row as the aggregate sees it. */
export interface SpendingTransaction {
  /** `transactions.id` as decimal text: digits, no leading zero, unique. */
  id: string
  /** The account the row is on; two legs of a transfer differ here. */
  accountId: string
  /** The account's scope. */
  scope: RowScope
  /** The NZ calendar date, `YYYY-MM-DD`. */
  date: IsoDate
  /** Signed: negative is money out. */
  amountCents: Cents
  /** Settled or pending. */
  status: TransactionStatus
  /** The effective category, drawings already laid over; null when none. */
  category: string | null
}

export interface SpendingByCategoryInput {
  scope: Scope
  /** `YYYY-MM`. */
  month: string
  transactions: readonly SpendingTransaction[]
  /** 1 to `SPENDING_TOP_MAX`; absent lists every category. */
  top?: number
}

const YEAR_MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/

/** A `YYYY-MM` month from 1000-01 to 9999-12. */
export function isYearMonth(value: unknown): value is string {
  return typeof value === 'string' && YEAR_MONTH.test(value)
}

/**
 * Whether a row is spending on its own (prd-02 Ruling 15): a row whose
 * effective category is Drawings, Hannah paying herself, is not.
 *
 * Own-account transfers are not decided here, because a transfer is a pair
 * of rows and this takes one. `spendingByCategory` pairs them with
 * `findOwnTransfers` (shared/habits.ts; Baseline decision 0a37d21b, pair
 * match, #431) before it asks this about each remaining row. Whether the
 * row is money out is the aggregate's check, not this one's.
 */
export function countsAsSpending(tx: SpendingTransaction): boolean {
  return !isDrawingCategory(tx.category)
}

const ROW_ID = /^[1-9]\d*$/

function validate(tx: SpendingTransaction, index: number): void {
  if (typeof tx.id !== 'string' || !ROW_ID.test(tx.id)) {
    throw new RangeError(
      `id of transaction ${index} must be a positive integer as text, got "${String(tx.id)}"`,
    )
  }
  if (typeof tx.accountId !== 'string') {
    throw new TypeError(`accountId of transaction ${index} must be text`)
  }
  if (tx.status !== 'settled' && tx.status !== 'pending') {
    throw new RangeError(
      `status of transaction ${index} must be settled or pending, got "${String(tx.status)}"`,
    )
  }
  if (!Number.isSafeInteger(tx.amountCents)) {
    throw new TypeError(
      `amountCents of transaction ${index} must be an integer number of cents, got ${tx.amountCents}`,
    )
  }
  if (tx.scope !== 'personal' && tx.scope !== 'strawb') {
    throw new RangeError(
      `scope of transaction ${index} must be personal or strawb, got "${String(tx.scope)}"`,
    )
  }
  if (!isIsoDate(tx.date)) {
    throw new RangeError(
      `date of transaction ${index} must be a YYYY-MM-DD calendar date, got "${String(tx.date)}"`,
    )
  }
  if (tx.category !== null && typeof tx.category !== 'string') {
    throw new TypeError(`category of transaction ${index} must be text or null`)
  }
}

/** Code-point order, not UTF-16 code-unit order (which `<` on strings is). */
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  const length = Math.min(x.length, y.length)
  for (let i = 0; i < length; i++) {
    const diff = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0)
    if (diff !== 0) return diff
  }
  return x.length - y.length
}

/**
 * The ids of the view's rows that are legs of an own-account transfer, from
 * `findOwnTransfers`. Only the view's in-scope rows that `countsAsSpending`
 * keeps are paired, dated within TRANSFER_WINDOW_DAYS of the month either
 * side, as `transferLegsInView` does in ./habits.ts: a Personal → Strawb
 * payment is left out of All and is spend in Personal. Drawings go first,
 * so a drawing half cannot take another row's partner.
 *
 * Exported so the transaction list (#433) leaves out the same legs as the
 * aggregate. Callers pass rows that already satisfy `SpendingTransaction`;
 * `findOwnTransfers` checks the paired subset's ids and amounts.
 */
export function transferLegIdsInView(
  transactions: readonly SpendingTransaction[],
  scope: Scope,
  month: string,
): Set<string> {
  const first = `${month}-01`
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  const last = `${month}-${String(daysInMonth(year, monthIndex)).padStart(2, '0')}`
  const legs: HabitTransaction[] = []
  for (const tx of transactions) {
    if (scope !== 'all' && tx.scope !== scope) continue
    if (daysBetween(tx.date, first) > TRANSFER_WINDOW_DAYS) continue
    if (daysBetween(last, tx.date) > TRANSFER_WINDOW_DAYS) continue
    if (!countsAsSpending(tx)) continue
    legs.push({
      id: tx.id,
      accountId: tx.accountId,
      date: tx.date,
      amountCents: tx.amountCents,
      status: tx.status,
      balanceCents: null,
      category: tx.category,
    })
  }
  return new Set(findOwnTransfers(legs).keys())
}

/**
 * The month's spending in the view's scope, per category, with the total.
 * See the header for each rule. A bad scope, month, `top` or row is a
 * RangeError or a TypeError.
 */
export function spendingByCategory(
  input: SpendingByCategoryInput,
): SpendingByCategoryResponse {
  const { scope, month, top } = input
  if (scope !== 'all' && scope !== 'personal' && scope !== 'strawb') {
    throw new RangeError(
      `scope must be all, personal or strawb, got "${String(scope)}"`,
    )
  }
  if (!isYearMonth(month)) {
    throw new RangeError(`month must be YYYY-MM, got "${String(month)}"`)
  }
  if (
    top !== undefined &&
    !(Number.isSafeInteger(top) && top >= 1 && top <= SPENDING_TOP_MAX)
  ) {
    throw new RangeError(
      `top must be a whole number from 1 to ${SPENDING_TOP_MAX}, got ${top}`,
    )
  }
  const seenIds = new Set<string>()
  input.transactions.forEach((tx, index) => {
    validate(tx, index)
    if (seenIds.has(tx.id)) {
      throw new RangeError(`id of transaction ${index} appears twice`)
    }
    seenIds.add(tx.id)
  })

  const transferLegIds = transferLegIdsInView(input.transactions, scope, month)
  const outflows: Cents[] = []
  const uncategorised: Cents[] = []
  const byCategory = new Map<string, Cents[]>()
  for (const tx of input.transactions) {
    if (scope !== 'all' && tx.scope !== scope) continue
    if (tx.date.slice(0, 7) !== month) continue
    if (tx.amountCents >= 0) continue
    if (!countsAsSpending(tx)) continue
    if (transferLegIds.has(tx.id)) continue
    const spent = -tx.amountCents
    outflows.push(spent)
    if (tx.category === null) {
      uncategorised.push(spent)
      continue
    }
    const list = byCategory.get(tx.category)
    if (list === undefined) byCategory.set(tx.category, [spent])
    else list.push(spent)
  }

  const lines: SpendingCategoryLine[] = [...byCategory].map(
    ([category, amounts]) => ({ category, spentCents: sumCents(amounts) }),
  )
  lines.sort(
    (a, b) =>
      b.spentCents - a.spentCents || compareCodePoints(a.category, b.category),
  )
  const shown = top === undefined ? lines : lines.slice(0, top)
  const rest = top === undefined ? [] : lines.slice(top)

  return {
    scope,
    month,
    totalCents: sumCents(outflows),
    categories: shown,
    otherCents: sumCents(rest.map((line) => line.spentCents)),
    uncategorisedCents: sumCents(uncategorised),
  }
}

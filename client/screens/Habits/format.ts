import { formatCents } from '../../../shared/money.ts'
import type { Verdict, VerdictRow } from '../../../shared/contracts.ts'
import { formatDay } from '../Overview/format.ts'

// Display helpers for the Habits screen. None of them computes money:
// runway is the route's tenths written as text, a streak is the route's
// days, an amount is a route field passed to `formatCents`, and a date is
// read from its string's parts by the Overview's `formatDay`, never through
// `Date`.

/** What runway shows when the route says it is unbounded (null). */
export const UNBOUNDED_RUNWAY = '∞'

/**
 * The route's tenths of a month as text: 78 → "7.8", 5 → "0.5", 120 →
 * "12.0". Written from the digits, so no division can round it; null (no
 * spending in the trailing month) is `UNBOUNDED_RUNWAY`.
 */
export function formatRunway(tenths: number | null): string {
  if (tenths === null) return UNBOUNDED_RUNWAY
  const sign = tenths < 0 ? '-' : ''
  const digits = String(tenths).replace('-', '').padStart(2, '0')
  return `${sign}${digits.slice(0, -1)}.${digits.slice(-1)}`
}

/** The note under the runway figure; unbounded runway says why. */
export function runwayNote(tenths: number | null): string {
  if (tenths === null) {
    return 'No spending in the last month, so there is nothing to divide by yet.'
  }
  return "months you could live with zero income, at this month's spending."
}

/** 1 → "1 day", 58 → "58 days". */
export function streakValue(days: number): string {
  return days === 1 ? '1 day' : `${days} days`
}

/** The pills, in the order shown, with their labels. */
export const VERDICT_PILLS: readonly { verdict: Verdict; label: string }[] = [
  { verdict: 'worth_it', label: 'Worth it' },
  { verdict: 'not_really', label: 'Not really' },
]

/**
 * "2 not worth it · 1 worth it", counted from the route's rows; "Untagged"
 * when no row has a verdict, as in the prototype.
 */
export function verdictSummary(rows: readonly VerdictRow[]): string {
  const notReally = rows.filter((r) => r.verdict === 'not_really').length
  const worthIt = rows.filter((r) => r.verdict === 'worth_it').length
  if (notReally === 0 && worthIt === 0) return 'Untagged'
  return `${notReally} not worth it · ${worthIt} worth it`
}

/**
 * "Groceries · -$1,280.00 · 20 Oct": the category when there is one, the
 * signed amount as the route sends it, and the day. The row's own date is
 * `today` for `formatDay`, so the label carries no year: the list is the
 * last 90 days.
 */
export function verdictMeta(row: VerdictRow): string {
  return [row.category, formatCents(row.amountCents), formatDay(row.date, row.date)]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

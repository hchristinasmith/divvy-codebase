import { formatCents } from '../../../shared/money.ts'
import type { GoalResponse } from '../../../shared/contracts.ts'

// Display helpers for the Goals screen. None of them computes money: the
// saved figure, the target, the pace and the months to go are the route's
// fields (server/db/goals.ts, shared/goals.ts), formatted here only by
// `formatCents` in shared/money.ts.

// A copy of `MONTHS` in ../Overview/format.ts, which is another screen's
// file; change both together.
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * "2027-11-15" → "by Nov 2027". Read from the string's parts, never through
 * `Date`, so the browser's timezone cannot move the month. Anything that is
 * not a calendar date is shown as it came.
 */
export function formatByDate(iso: string): string {
  const match = ISO_DATE.exec(iso)
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1]
  if (match === null || month === undefined) return `by ${iso}`
  return `by ${month} ${match[1]}`
}

/** 1 → "1 month", 14 → "14 months". */
export function monthsLabel(months: number): string {
  return months === 1 ? '1 month' : `${months} months`
}

/**
 * The card's pace line. Funded when saved has reached the target (a
 * comparison of two route fields, not a sum); no pace without a by-date;
 * otherwise the route's pace and months to go.
 */
export function paceLine(goal: GoalResponse): string {
  if (goal.savedCents >= goal.targetCents) return 'Funded.'
  if (goal.paceCents === null || goal.monthsToGo === null) return 'No by-date'
  return `${formatCents(goal.paceCents)}/mo · ${monthsLabel(goal.monthsToGo)} to go`
}

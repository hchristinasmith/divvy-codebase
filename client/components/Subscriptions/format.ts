import type { SubscriptionCadence } from '../../../shared/contracts.ts'

// Display helpers for the Subscriptions screen. None of them computes
// money: dates, cadences and counts are labels. Money is formatted only by
// `formatCents` in shared/money.ts.

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
 * A copy of `formatDay` in client/screens/Overview/format.ts, which is
 * another screen's file. "2026-11-28" → "28 Nov" when `today` is in the
 * same year, and "28 Nov\u00a02026" when it is not: the year is joined by a
 * non-breaking space so it never wraps onto its own line. Read from
 * the string's parts, never through `Date`, so the browser's timezone
 * cannot move the day or the year. `today` is passed in, never read here,
 * and a `today` that is not a calendar date shows the year. Anything that
 * is not a calendar date comes back unchanged.
 */
export function formatDay(iso: string, today: string): string {
  const match = ISO_DATE.exec(iso)
  if (!match) return iso
  const month = MONTHS[Number(match[2]) - 1]
  const day = Number(match[3])
  if (month === undefined || day < 1 || day > 31) return iso
  const label = `${day} ${month}`
  const todayYear = ISO_DATE.exec(today)?.[1]
  return todayYear === match[1] ? label : `${label}\u00a0${match[1]}`
}

const CADENCE: Record<SubscriptionCadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
}

const CYCLE: Record<SubscriptionCadence, string> = {
  weekly: 'per week',
  monthly: 'per month',
  yearly: 'per year',
}

/** "Monthly", or that the charges show no regular pattern yet. */
export function cadenceLabel(cadence: SubscriptionCadence | null): string {
  return cadence === null ? 'No regular pattern yet' : CADENCE[cadence]
}

/** What the amount beside a row is: "per month", or the latest charge. */
export function cycleLabel(cadence: SubscriptionCadence | null): string {
  return cadence === null ? 'latest charge' : CYCLE[cadence]
}

/** "1 charge", "3 charges". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

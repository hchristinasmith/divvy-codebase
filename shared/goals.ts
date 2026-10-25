// A goal's pace: prd-02 money math, in integer cents (M1 #8). The goals
// route (`server/db/goals.ts`) derives `savedCents` from the goal's
// contribution records and calls `goalPace`; nothing else re-derives a pace
// or a months-to-go.
//
// Pace is what is needed per month to hit the by-date (Hannah, 2026-10-25,
// Baseline decision 0d881e4c, option A: the card shows what is needed to hit
// the date). It is the amount still to save, divided over the whole months
// left, rounded up once at the end, so saving `paceCents` every month never
// falls short of the target. Every step before that one rounding is an
// integer.
//
// Nothing here reads a clock: `today` is passed in, as the Pacific/Auckland
// calendar date the server computes.

import type { Cents, IsoDate } from './contracts.ts'

export interface GoalPace {
  /**
   * Cents per month needed to reach the target by the target date, rounded
   * up once. 0 when the goal is funded; null with no target date.
   */
  paceCents: Cents | null
  /**
   * Whole months left (see `monthsUntil`): at least 1 while unfunded, 0 when
   * funded, null with no target date.
   */
  monthsToGo: number | null
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function dateParts(value: IsoDate, what: string): [number, number, number] {
  const match = ISO_DATE.exec(value)
  if (match === null) {
    throw new RangeError(`${what} must be a YYYY-MM-DD date`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`${what} must be a YYYY-MM-DD date`)
  }
  return [year, month, day]
}

/**
 * Whole months from `today` to `targetDate`, the definition the pace divides
 * by: the calendar months between the two dates, plus one more when the
 * target's day of the month is later than today's. A partial month counts as
 * a whole one, so 25 October to 26 November is two months. A target today,
 * or in the past, is one month: what is left is needed now.
 *
 * Integer arithmetic on the parsed parts; no `Date` is built. Throws
 * RangeError for a value that is not `YYYY-MM-DD`.
 */
export function monthsUntil(today: IsoDate, targetDate: IsoDate): number {
  const [y, m, d] = dateParts(today, 'today')
  const [ty, tm, td] = dateParts(targetDate, 'targetDate')
  return Math.max(1, (ty - y) * 12 + (tm - m) + (td > d ? 1 : 0))
}

/**
 * `n / d` rounded up, for a non-negative safe integer `n` and a positive
 * safe integer `d`. `n - r` is an exact multiple of `d`, so the division is
 * exact; no float quotient is rounded.
 */
function ceilDiv(n: number, d: number): number {
  const r = n % d
  const q = (n - r) / d
  return r > 0 ? q + 1 : q
}

/**
 * A goal's pace and months to go. A funded goal (saved at or above the
 * target) is `{ paceCents: 0, monthsToGo: 0 }`, with or without a target
 * date. An unfunded goal with no target date has no pace: both are null.
 * Otherwise the amount still to save over `monthsUntil(today, targetDate)`,
 * rounded up once.
 *
 * Throws RangeError unless both amounts are safe integers, the target is
 * above zero and saved is not below zero.
 */
export function goalPace(input: {
  targetCents: Cents
  savedCents: Cents
  targetDate: IsoDate | null
  today: IsoDate
}): GoalPace {
  const { targetCents, savedCents, targetDate, today } = input
  if (!Number.isSafeInteger(targetCents) || targetCents <= 0) {
    throw new RangeError('targetCents must be a whole number of cents above 0')
  }
  if (!Number.isSafeInteger(savedCents) || savedCents < 0) {
    throw new RangeError(
      'savedCents must be a whole number of cents, 0 or more',
    )
  }
  const remaining = targetCents - savedCents
  if (remaining <= 0) return { paceCents: 0, monthsToGo: 0 }
  if (targetDate === null) return { paceCents: null, monthsToGo: null }
  const monthsToGo = monthsUntil(today, targetDate)
  return { paceCents: ceilDiv(remaining, monthsToGo), monthsToGo }
}

import type { Bill } from '../../models/planning.ts'
import type { IsoDate } from '../../shared/contracts.ts'
import { daysInMonth } from '../../shared/safe-to-spend.ts'

// The overview's data module (prd-02, issue #44): every read behind
// GET /api/v1/overview and the one write behind dismissing an alert.
//
// This module does no money arithmetic. Every figure it sends is either a
// stored value passed through (a balance, a bill's amount) or read off what
// `safeToSpend` in shared/safe-to-spend.ts returned (prd-02 Ruling 1). The
// only things computed here are calendar dates: today in Hannah's timezone,
// and which occurrences of a repeating bill are due.

/**
 * A failure the route may name to the client. The message is one of a closed
 * set of constant texts, so no row id, stored value or SQL can reach a
 * response through it.
 */
export type OverviewDataErrorMessage =
  | 'safe-to-spend input invalid'
  | 'a stored setting is not valid'
  | 'an account has no balance'
  | 'a transaction is incomplete'
  | 'a bill has too many unpaid occurrences'

export class OverviewDataError extends Error {
  constructor(message: OverviewDataErrorMessage) {
    super(message)
    this.name = 'OverviewDataError'
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// Built once. `formatToParts` is read field by field rather than trusting a
// locale's string order.
const NZ_DATE = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The calendar date `at` falls on in Pacific/Auckland, as `YYYY-MM-DD`.
 * Safe-to-spend takes `today` in Hannah's timezone (shared/safe-to-spend.ts),
 * and a transaction's date is read the same way, so a purchase at 9am NZ on
 * a Tuesday is Tuesday's spend even though it is Monday in UTC.
 */
export function nzCalendarDate(at: Date): IsoDate {
  if (Number.isNaN(at.getTime())) {
    throw new OverviewDataError('a transaction is incomplete')
  }
  let year = ''
  let month = ''
  let day = ''
  for (const part of NZ_DATE.formatToParts(at)) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year.padStart(4, '0')}-${month}-${day}`
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

interface CivilDate {
  year: number
  month: number // 1 to 12
  day: number
}

function parseIsoDate(value: IsoDate): CivilDate {
  const match = ISO_DATE.exec(value)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month)
    ) {
      return { year, month, day }
    }
  }
  // The value is not echoed: the route turns this into a fixed text.
  throw new RangeError('a bill date is not a YYYY-MM-DD calendar date')
}

function formatIsoDate({ year, month, day }: CivilDate): IsoDate {
  if (year < 0 || year > 9999) {
    throw new RangeError('a bill date falls outside the years 0000 to 9999')
  }
  const yyyy = String(year).padStart(4, '0')
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * `date` moved by `days` calendar days. Built with `setUTCFullYear`, as
 * shared/safe-to-spend.ts does, never `Date.UTC`, which reads the years 0 to
 * 99 as 1900 to 1999.
 */
function addDaysIso(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date)
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day + days)
  return formatIsoDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  })
}

/**
 * The anchor moved by `months` whole months, keeping the anchor's day of
 * month clamped to the end of a shorter month: the 31st falls on the 30th,
 * 29th or 28th, and on the 31st again the month after. 29 February moved by
 * twelve months falls on 28 February in a year that is not a leap year.
 */
function addMonthsClamped(anchor: CivilDate, months: number): IsoDate {
  const index = anchor.year * 12 + (anchor.month - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const day = Math.min(anchor.day, daysInMonth(year, month))
  return formatIsoDate({ year, month, day })
}

/**
 * Every occurrence of a bill from its anchor (`first_due_date`) up to and
 * including `through`, ascending (#35 option C). Each occurrence is computed
 * from the anchor, never from the previous occurrence, so nothing drifts:
 *
 * - `none`: the anchor alone, if it is not after `through`.
 * - `weekly`: anchor + 7n days.
 * - `monthly`: the anchor's day of month, clamped to the month's end.
 * - `yearly`: the anchor's month and day, clamped the same way.
 *
 * Paid occurrences are included; dropping them is the caller's job.
 */
export function billOccurrencesThrough(
  bill: Pick<Bill, 'repeat' | 'first_due_date'>,
  through: IsoDate,
): IsoDate[] {
  parseIsoDate(through)
  const anchorDate = parseIsoDate(bill.first_due_date)
  const anchor = formatIsoDate(anchorDate)
  const occurrences: IsoDate[] = []
  if (anchor > through) return occurrences
  if (bill.repeat === 'none') return [anchor]
  for (let n = 0; ; n += 1) {
    let next: IsoDate
    if (bill.repeat === 'weekly') next = addDaysIso(anchor, 7 * n)
    else if (bill.repeat === 'monthly') next = addMonthsClamped(anchorDate, n)
    else if (bill.repeat === 'yearly')
      next = addMonthsClamped(anchorDate, 12 * n)
    else throw new RangeError('a bill has an unknown repeat')
    // ISO dates compare correctly as strings.
    if (next > through) return occurrences
    occurrences.push(next)
  }
}

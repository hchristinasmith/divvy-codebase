import { nzCalendarDate } from '../../../shared/nz-dates.ts'

// The Spending screen's month picker (issue 272): `YYYY-MM` NZ calendar
// months, the form GET /api/v1/spending/categories takes. Calendar labels
// only; nothing here touches money.

/** The NZ calendar month `now` falls in. */
export function nzMonth(now: Date): string {
  return nzCalendarDate(now).slice(0, 7)
}

function firstDay(month: string): Date {
  return new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1),
  )
}

/** The month `by` months after `month` (before, when negative). */
export function shiftMonth(month: string, by: number): string {
  const day = firstDay(month)
  day.setUTCMonth(day.getUTCMonth() + by)
  return day.toISOString().slice(0, 7)
}

const LABEL = new Intl.DateTimeFormat('en-NZ', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/** "2026-10" → "October 2026". */
export function monthLabel(month: string): string {
  return LABEL.format(firstDay(month))
}

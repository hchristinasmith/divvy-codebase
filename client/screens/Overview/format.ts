// Display helpers for the Overview. None of them computes money: dates and
// rates are labels, and `barPercent` is the width of a bar. Money is
// formatted only by `formatCents` in shared/money.ts.

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
 * "2026-11-28" → "28 Nov" when `today` is in the same year, and
 * "28 Nov\u00a02026" when it is not: the year is joined by a non-breaking
 * space so it never wraps onto its own line. Read from the string's
 * parts, never through `Date`, so the browser's timezone cannot move the
 * day or the year. `today` is passed in, never read here, and a `today`
 * that is not a calendar date shows the year. Anything that is not a
 * calendar date comes back unchanged.
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

/** Basis points as a percentage label: 2500 → "25%", 1050 → "10.5%". */
export function formatRate(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100)
  const rest = Math.abs(basisPoints % 100)
  if (rest === 0) return `${whole}%`
  const fraction = String(rest).padStart(2, '0').replace(/0$/, '')
  return `${whole}.${fraction}%`
}

/**
 * How full a bar is, as a whole percentage from 0 to 100: `part` of
 * `whole`, floored and clamped. Floored, not rounded, so a bar reads 100
 * only when the part has reached the whole: 299999 of 300000 is 99, not a
 * full bar. 0 when `whole` is not positive.
 */
export function barPercent(part: number, whole: number): number {
  if (whole <= 0) return 0
  // Multiply before dividing: (part / whole) * 100 can land just under a
  // whole number (29 / 50 * 100 is 57.99999999999999), and floor would drop it.
  const percent = Math.floor((part * 100) / whole)
  return Math.min(100, Math.max(0, percent))
}

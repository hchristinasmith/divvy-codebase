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
 * "2026-11-28" → "28 Nov". Read from the string's parts, never through
 * `Date`, so the browser's timezone cannot move the day. Anything that is
 * not a calendar date comes back unchanged.
 */
export function formatDay(iso: string): string {
  const match = ISO_DATE.exec(iso)
  if (!match) return iso
  const month = MONTHS[Number(match[2]) - 1]
  const day = Number(match[3])
  if (month === undefined || day < 1 || day > 31) return iso
  return `${day} ${month}`
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
 * `whole`, rounded and clamped. 0 when `whole` is not positive.
 */
export function barPercent(part: number, whole: number): number {
  if (whole <= 0) return 0
  const percent = Math.round((part / whole) * 100)
  return Math.min(100, Math.max(0, percent))
}

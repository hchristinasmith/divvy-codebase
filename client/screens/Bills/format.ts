import { formatCents } from '../../../shared/money.ts'
import type { BillResponse, RowScope } from '../../../shared/contracts.ts'
import type { BillRepeat } from '../../../models/planning.ts'
import { formatDay } from '../Overview/format.ts'

// Display helpers for the Bills screen. None of them computes money: an
// amount is a route field passed to `formatCents`, and a date is read from
// its string's parts by the Overview's `formatDay`, never through `Date`.

/** Every repeat the schema has, with its label; tsc refuses a missing or extra key. */
export const REPEAT_LABELS: Record<BillRepeat, string> = {
  none: 'One-off',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
}

/** The Repeat select's options, in the order shown. */
export const REPEAT_OPTIONS = [
  'none',
  'weekly',
  'monthly',
  'yearly',
] as const satisfies readonly BillRepeat[]

/** A select's value back as a repeat, without a cast; null if it is not one. */
export function toRepeat(value: string): BillRepeat | null {
  return REPEAT_OPTIONS.find((option) => option === value) ?? null
}

export function scopeLabel(scope: RowScope): string {
  return scope === 'strawb' ? 'Strawb' : 'Personal'
}

/** "Personal · Test Everyday · Monthly", or "Strawb · One-off" with no account. */
export function metaLine(bill: BillResponse): string {
  return [scopeLabel(bill.scope), bill.accountName, REPEAT_LABELS[bill.repeat]]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** "2026-11-28" → day "28", month "Nov" for the date tile. */
export function dateTileParts(iso: string): { day: string; month: string } {
  const label = formatDay(iso)
  const [day, month] = label.split(' ')
  if (label === iso || month === undefined) return { day: iso, month: '' }
  return { day, month }
}

/** The "Next one" tile: "$1,200.00 · 1 Nov", or "None". */
export function nextOneLabel(bill: BillResponse | null): string {
  if (bill === null) return 'None'
  return `${formatCents(bill.amountCents)} · ${formatDay(bill.dueDate)}`
}

export type RowTone = 'next' | 'later' | 'paid'

/**
 * The date tile's colour. The route sends unpaid bills first, by due date,
 * so the first two rows that are not paid are the next two due.
 */
export function rowTone(bill: BillResponse, index: number): RowTone {
  if (bill.paid) return 'paid'
  return index < 2 ? 'next' : 'later'
}

import { formatCents } from '../../../shared/money.ts'
import type { BudgetLine, BudgetsResponse } from '../../../shared/contracts.ts'
import { formatDay } from '../Overview/format.ts'

// Display helpers for the Budgets screen (issue 53). An amount is a route
// field passed to `formatCents`; a date is read from its string's parts by
// the Overview's `formatDay`, never through `Date`. The one comparison on
// cents is `isNearLimit`, which the money tripwire
// (./__tests__/noMoneyArithmetic.test.ts) allows by name.

export type BudgetTone = 'left' | 'near' | 'over'

/**
 * Spent is more than 80% of the limit, compared in whole cents: spent × 5
 * against limit × 4, so no fraction is ever formed. A limit of 0 with
 * nothing spent is not near.
 */
export function isNearLimit(spentCents: number, limitCents: number): boolean {
  return spentCents * 5 > limitCents * 4
}

/**
 * Over when the route says so (`overCents > 0`), else near when spent is
 * past 80% of the limit, else left. Spent exactly at the limit is near and
 * reads "$0.00 left", as the server's status does.
 */
export function budgetTone(budget: BudgetLine): BudgetTone {
  if (budget.overCents > 0) return 'over'
  return isNearLimit(budget.spentCents, budget.limitCents) ? 'near' : 'left'
}

/** "$12.00 over" or "$30.00 left", from the route's own fields. */
export function statusLabel(budget: BudgetLine): string {
  if (budget.overCents > 0) return `${formatCents(budget.overCents)} over`
  return `${formatCents(budget.remainingCents)} left`
}

/**
 * The header's subtitle. The days come from the overview's safe-to-spend
 * (the server's payday); until that has loaded, the budgets' own period end
 * is shown as a date instead; with neither, just the reset.
 */
export function paydaySubtitle(
  daysToPayday: number | undefined,
  period: Pick<BudgetsResponse, 'periodStart' | 'periodEnd'> | undefined,
): string {
  if (daysToPayday !== undefined) {
    const days = daysToPayday === 1 ? '1 day' : `${daysToPayday} days`
    return `Resets on payday · ${days} left`
  }
  if (period !== undefined) {
    // The period's start stands in for today, so a reset in the same year
    // shows no year.
    return `Resets on payday · ${formatDay(period.periodEnd, period.periodStart)}`
  }
  return 'Resets on payday'
}

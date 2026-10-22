// Safe to spend: the one definition (prd-02 Ruling 1). The overview route
// calls `safeToSpend` and sends what it returns; prd-03's
// `get_safe_to_spend` imports the same function. Nothing else re-derives
// the number or any of its parts.
//
//   safe = liquid − unpaid bills − remaining budget − tax hold
//
// Each term is exactly as prd-02 Ruling 2 rules it:
//
// - liquid: balances of in-scope accounts whose role is `current`. Savings,
//   the tax pot and accounts with no role are not liquid.
// - unpaid bills: in-scope bills not paid and due on or before the next
//   payday, overdue ones included.
// - remaining budget: over in-scope budgets, `max(0, limit − spent)`; spent
//   is effective-category outflow, settled and pending, since the last
//   payday (`budgetSpentCents`).
// - tax hold: `max(0, taxRate × profit − taxPot)` in All and Strawb, 0 in
//   Personal. Profit is Strawb's year-to-date accrual profit; until Xero is
//   connected it is the typed setting and is 0 by default, so the hold is 0
//   (prd-02 open question, answered 2026-10-23; prd-05 Ruling 4).
//
// The result is signed (prd-02 Ruling 3): a negative `safeCents` is
// returned as it is, with `shortByCents`; showing `$0` is the screen's job.
// There is deliberately no input for Xero receivables (prd-02 Ruling 4,
// prd-05 Ruling 4) or for goal contributions (prd-02 Ruling 5).
//
// Money is integer cents throughout (M1 #8). Sums go through `sumCents`,
// which refuses a non-integer. The only divisions are the tax owed (rounded
// up, so the hold is never under-reserved) and the per-day figure (rounded
// down, so it never flatters); each is one rounding of exact integers.
//
// Dates are `YYYY-MM-DD` calendar dates with no timezone. `today` is an
// input, so the function never reads the clock; the caller passes the date
// in Hannah's timezone (Pacific/Auckland).

import type {
  AccountRole,
  BudgetLine,
  Cents,
  IsoDate,
  RowScope,
  SafeToSpendResult,
  Scope,
  TransactionStatus,
} from './contracts.ts'
import { sumCents } from './money.ts'

export interface SafeToSpendAccount {
  id: string
  scope: RowScope
  role: AccountRole | null
  balanceCents: Cents
}

/** A bill as due on one date (whatever #35 rules about repeats). */
export interface SafeToSpendBill {
  id: string
  scope: RowScope
  amountCents: Cents
  dueDate: IsoDate
  paid: boolean
}

export interface SafeToSpendBudget {
  id: string
  scope: RowScope
  /** An effective-category name. */
  category: string
  limitCents: Cents
}

export interface SafeToSpendTransaction {
  /** Must be one of the input accounts; its scope is the account's. */
  accountId: string
  date: IsoDate
  /** Signed: negative is money out. */
  amountCents: Cents
  /** The effective category (prd-01 Ruling 4), not Akahu's. */
  category: string | null
  /** Carried, never filtered on: settled and pending both count. */
  status: TransactionStatus
}

export interface SafeToSpendInput {
  scope: Scope
  today: IsoDate
  /** Day of the month pay arrives, 1 to 31. */
  paydayDay: number
  /** Tax rate in basis points: 2500 is 25%. */
  taxRateBasisPoints: number
  /** Strawb's year-to-date accrual profit; 0 until Xero is connected. */
  profitCents: Cents
  /** Every account; the function applies the scope. */
  accounts: readonly SafeToSpendAccount[]
  bills: readonly SafeToSpendBill[]
  budgets: readonly SafeToSpendBudget[]
  /** At least every transaction from the last payday to today. */
  transactions: readonly SafeToSpendTransaction[]
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

interface CivilDate {
  year: number
  month: number // 1 to 12
  day: number
}

function parseDate(value: IsoDate, what: string): CivilDate {
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
  throw new RangeError(
    `${what} must be a YYYY-MM-DD calendar date, got "${value}"`,
  )
}

function formatDate({ year, month, day }: CivilDate): IsoDate {
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${mm}-${dd}`
}

function assertPaydayDay(paydayDay: number): void {
  if (!Number.isInteger(paydayDay) || paydayDay < 1 || paydayDay > 31) {
    throw new RangeError(
      `paydayDay must be a whole day from 1 to 31, got ${paydayDay}`,
    )
  }
}

/** Days in a month (1 to 12) of the proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Payday in a given month: `paydayDay`, or the month's last day if shorter. */
function paydayIn(year: number, month: number, paydayDay: number): CivilDate {
  return { year, month, day: Math.min(paydayDay, daysInMonth(year, month)) }
}

/**
 * The most recent payday on or before `today`. On payday itself that is
 * today: pay has landed and the budgets have reset.
 */
export function lastPayday(today: IsoDate, paydayDay: number): IsoDate {
  assertPaydayDay(paydayDay)
  const t = parseDate(today, 'today')
  const thisMonth = paydayIn(t.year, t.month, paydayDay)
  if (t.day >= thisMonth.day) return formatDate(thisMonth)
  const year = t.month === 1 ? t.year - 1 : t.year
  const month = t.month === 1 ? 12 : t.month - 1
  return formatDate(paydayIn(year, month, paydayDay))
}

/** The first payday strictly after `today`. */
export function nextPayday(today: IsoDate, paydayDay: number): IsoDate {
  assertPaydayDay(paydayDay)
  const t = parseDate(today, 'today')
  const thisMonth = paydayIn(t.year, t.month, paydayDay)
  if (t.day < thisMonth.day) return formatDate(thisMonth)
  const year = t.month === 12 ? t.year + 1 : t.year
  const month = t.month === 12 ? 1 : t.month + 1
  return formatDate(paydayIn(year, month, paydayDay))
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseDate(from, 'from')
  const b = parseDate(to, 'to')
  // Date.UTC is plain arithmetic on the given fields: no clock, no timezone.
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)
  return Math.round(ms / 86_400_000)
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${what} must be an integer number of cents, got ${value}`,
    )
  }
}

function assertNonNegativeCents(value: number, what: string): void {
  assertCents(value, what)
  if (value < 0)
    throw new RangeError(`${what} must not be negative, got ${value}`)
}

/** `a ÷ b` rounded towards −∞, for integers, with −0 normalised to 0. */
function floorDiv(a: number, b: number): number {
  const q = Math.floor(a / b)
  return q === 0 ? 0 : q
}

/**
 * `rate × profit`, rounded up to the cent. A loss owes nothing. This is
 * what the Tax card calls "owed so far" before the pot is netted.
 */
function taxOwedCents(taxRateBasisPoints: number, profitCents: Cents): Cents {
  if (
    !Number.isInteger(taxRateBasisPoints) ||
    taxRateBasisPoints < 0 ||
    taxRateBasisPoints > 10_000
  ) {
    throw new RangeError(
      `taxRateBasisPoints must be a whole number from 0 to 10000, got ${taxRateBasisPoints}`,
    )
  }
  assertCents(profitCents, 'profitCents')
  if (profitCents <= 0) return 0
  const scaled = taxRateBasisPoints * profitCents
  assertCents(scaled, 'taxRateBasisPoints × profitCents')
  return Math.ceil(scaled / 10_000)
}

// ---------------------------------------------------------------------------
// Spent
// ---------------------------------------------------------------------------

/**
 * How much of a budget has been spent: the outflow of `scope`'s accounts in
 * `category` (the effective category) dated from `from` to `to`, both
 * included, as a positive number of cents. Pending rows count like settled
 * ones. Money in (income, a refund) is not spend and never offsets it.
 *
 * `safeToSpend` calls this with the last payday and today; the budgets
 * route reads the result off `SafeToSpendResult.budgets` rather than
 * calling it again.
 */
export function budgetSpentCents(args: {
  accounts: readonly SafeToSpendAccount[]
  transactions: readonly SafeToSpendTransaction[]
  scope: RowScope
  category: string
  from: IsoDate
  to: IsoDate
}): Cents {
  parseDate(args.from, 'from')
  parseDate(args.to, 'to')
  const scopeOf = accountScopes(args.accounts)
  const outflows: number[] = []
  for (const tx of args.transactions) {
    assertCents(tx.amountCents, 'transaction amountCents')
    parseDate(tx.date, 'transaction date')
    const accountScope = scopeOf.get(tx.accountId)
    if (accountScope === undefined) {
      throw new RangeError(`transaction on unknown account "${tx.accountId}"`)
    }
    if (accountScope !== args.scope) continue
    if (tx.category !== args.category) continue
    if (tx.amountCents >= 0) continue
    // ISO dates compare correctly as strings.
    if (tx.date < args.from || tx.date > args.to) continue
    outflows.push(-tx.amountCents)
  }
  return sumCents(outflows)
}

function accountScopes(
  accounts: readonly SafeToSpendAccount[],
): Map<string, RowScope> {
  const scopes = new Map<string, RowScope>()
  for (const a of accounts) scopes.set(a.id, a.scope)
  return scopes
}

// ---------------------------------------------------------------------------
// Safe to spend
// ---------------------------------------------------------------------------

function inScope(scope: Scope, rowScope: RowScope): boolean {
  return scope === 'all' || rowScope === scope
}

export function safeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  const { scope, today, paydayDay } = input
  if (scope !== 'all' && scope !== 'personal' && scope !== 'strawb') {
    throw new RangeError(
      `scope must be all, personal or strawb, got "${String(scope)}"`,
    )
  }
  const last = lastPayday(today, paydayDay)
  const next = nextPayday(today, paydayDay)
  const daysToPayday = daysBetween(today, next)

  const accounts = input.accounts.filter((a) => inScope(scope, a.scope))
  for (const a of accounts)
    assertCents(a.balanceCents, `balanceCents of account "${a.id}"`)

  const liquidCents = sumCents(
    accounts.filter((a) => a.role === 'current').map((a) => a.balanceCents),
  )

  const unpaidBillsCents = sumCents(
    input.bills
      .filter((b) => inScope(scope, b.scope))
      .filter((b) => {
        assertNonNegativeCents(b.amountCents, `amountCents of bill "${b.id}"`)
        parseDate(b.dueDate, `dueDate of bill "${b.id}"`)
        return !b.paid && b.dueDate <= next
      })
      .map((b) => b.amountCents),
  )

  const budgets: BudgetLine[] = input.budgets
    .filter((b) => inScope(scope, b.scope))
    .map((b) => {
      assertNonNegativeCents(b.limitCents, `limitCents of budget "${b.id}"`)
      const spentCents = budgetSpentCents({
        accounts: input.accounts,
        transactions: input.transactions,
        scope: b.scope,
        category: b.category,
        from: last,
        to: today,
      })
      return {
        id: b.id,
        scope: b.scope,
        category: b.category,
        limitCents: b.limitCents,
        spentCents,
        remainingCents: Math.max(0, b.limitCents - spentCents),
        overCents: Math.max(0, spentCents - b.limitCents),
      }
    })
  const remainingBudgetCents = sumCents(budgets.map((b) => b.remainingCents))

  // Personal never holds tax, whatever the data says (Ruling 2).
  const owed = taxOwedCents(input.taxRateBasisPoints, input.profitCents)
  const taxOwed = scope === 'personal' ? 0 : owed
  const taxPotCents =
    scope === 'personal'
      ? 0
      : sumCents(
          accounts
            .filter((a) => a.role === 'tax_pot')
            .map((a) => a.balanceCents),
        )
  const taxHoldCents = Math.max(0, taxOwed - taxPotCents)

  const safeCents = sumCents([
    liquidCents,
    -unpaidBillsCents,
    -remainingBudgetCents,
    -taxHoldCents,
  ])

  return {
    scope,
    today,
    lastPayday: last,
    nextPayday: next,
    liquidCents,
    unpaidBillsCents,
    remainingBudgetCents,
    taxOwedCents: taxOwed,
    taxPotCents,
    taxHoldCents,
    safeCents,
    shortByCents: Math.max(0, -safeCents),
    daysToPayday,
    perDayCents: floorDiv(safeCents, daysToPayday),
    budgets,
  }
}

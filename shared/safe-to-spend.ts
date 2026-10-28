// Safe to spend: the one definition (prd-02 Ruling 1). The overview route
// calls `safeToSpend` and sends what it returns; prd-03's
// `get_safe_to_spend` imports the same function. Nothing else re-derives
// the number or any of its parts.
//
//   safe = liquid − unpaid bills − remaining budget − tax hold − card debt
//
// Each term is exactly as prd-02 Ruling 2 rules it, as amended by Rulings 9,
// 10, 11 and 12:
//
// - liquid: balances of in-scope accounts whose role is `current`. Savings,
//   tax pots, credit cards and accounts with no role are not liquid.
// - unpaid bills: in-scope bills not paid and due on or before the next
//   payday, overdue ones included, less the Strawb bills buffer (Ruling 12).
//   Strawb's bills are paid from the Strawb tax pot first, so the buffer is
//   `max(0, min(Strawb tax pots, Strawb's unpaid bills))` and only Strawb's
//   unpaid bills beyond it come out of liquid. Personal bills always come
//   out in full. The clamp at 0 keeps an overdrawn pot from adding bills.
// - remaining budget: over in-scope budgets, `max(0, limit − spent)`; spent
//   is effective-category outflow, settled and pending, since the last
//   payday (`budgetSpentCents`). Payday is weekly (Ruling 9), so a limit is
//   a weekly amount. Spend on a credit card counts like any other. A row
//   whose effective category is Drawings is never spent, in any budget
//   (prd-02 Ruling 15): a drawing is Hannah paying herself, and the caller
//   hands each half over with Drawings as its category.
// - tax hold: each scope holds its own, against its own pot (Ruling 11).
//   - Strawb: `max(0, taxRate × profit − (Strawb tax pots − buffer))`: the
//     money the pot keeps for Strawb's bills is not tax set aside (Ruling
//     12). Profit is Strawb's year-to-date accrual profit; until Xero is
//     connected it is the typed setting and is 0 by default, so this hold is
//     0 (prd-02 open question, answered 2026-10-23; prd-05 Ruling 4).
//   - Personal: `max(0, personalTaxOwed − personal tax pots)`, the owed
//     amount typed in, with no rate.
//   Strawb scope holds the Strawb hold, Personal the personal one, All the
//   sum of both. A surplus pot on one side never reduces the other's hold.
// - card debt: over in-scope `credit_card` accounts, `max(0, −balance)`
//   (Ruling 10). Akahu reports what is owed on a card as a negative balance;
//   a card in credit adds 0 and never offsets another card.
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
import { isDrawingCategory } from './drawings.ts'
import { sumCents } from './money.ts'
import {
  addDaysCivil,
  formatIsoDate,
  parseIsoDate,
  type CivilDate,
} from './nz-dates.ts'

// The day helpers live in nz-dates.ts (#335). Re-exported so existing callers
// keep importing `daysInMonth` from here.
export { daysInMonth } from './nz-dates.ts'

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
  /** The weekday pay arrives, every week: 0 (Sunday) to 6 (Saturday). */
  paydayWeekday: number
  /** Tax rate in basis points: 2500 is 25%. Feeds the Strawb hold only. */
  taxRateBasisPoints: number
  /**
   * Strawb's year-to-date accrual profit; 0 until Xero is connected. Feeds
   * the Strawb hold only.
   */
  profitCents: Cents
  /**
   * Personal income tax owed, as typed in. Feeds the personal hold only; no
   * rate is applied (prd-02 Ruling 11).
   */
  personalTaxOwedCents: Cents
  /** Every account; the function applies the scope. */
  accounts: readonly SafeToSpendAccount[]
  bills: readonly SafeToSpendBill[]
  budgets: readonly SafeToSpendBudget[]
  /**
   * The transactions from the last payday to today. Rows outside that window
   * are ignored, so pass only the window rather than the whole table.
   */
  transactions: readonly SafeToSpendTransaction[]
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// The texts are safe-to-spend's own (prd-02 Ruling 1): `what` names the
// argument and the value is echoed, as they always were.
function parseDate(value: IsoDate, what: string): CivilDate {
  try {
    return parseIsoDate(value)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw new RangeError(
      `${what} must be a YYYY-MM-DD calendar date, got "${value}"`,
    )
  }
}

function formatDate({ year, month, day }: CivilDate): IsoDate {
  // A payday moved out of the years 0000 to 9999 has no YYYY-MM-DD form:
  // year −1 would print as "00-1" (#126).
  if (year < 0 || year > 9999) {
    throw new RangeError(
      `a payday must fall in the years 0000 to 9999, got year ${year}`,
    )
  }
  return formatIsoDate({ year, month, day })
}

function assertPaydayWeekday(paydayWeekday: number): void {
  if (
    !Number.isInteger(paydayWeekday) ||
    paydayWeekday < 0 ||
    paydayWeekday > 6
  ) {
    throw new RangeError(
      `paydayWeekday must be a whole weekday from 0 (Sunday) to 6 (Saturday), got ${paydayWeekday}`,
    )
  }
}

// setUTCFullYear and the getUTC* readers are plain arithmetic on the given
// fields: no clock, no timezone.

/**
 * Midnight UTC on a civil date, as epoch milliseconds. A `day` past the end
 * of the month (or below 1) rolls over, as `Date` does. Built with
 * `setUTCFullYear`, never `Date.UTC`: `Date.UTC` reads years 0 to 99 as 1900
 * to 1999, which would give wrong weekdays and day counts for dates
 * `parseDate` accepts (#126).
 */
function utcMidnight({ year, month, day }: CivilDate): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  return d.getTime()
}

/** The weekday of a date: 0 is Sunday, 6 is Saturday. */
function weekday(date: CivilDate): number {
  return new Date(utcMidnight(date)).getUTCDay()
}

function lastPaydayDate(today: IsoDate, paydayWeekday: number): CivilDate {
  assertPaydayWeekday(paydayWeekday)
  const t = parseDate(today, 'today')
  return addDaysCivil(t, -((weekday(t) - paydayWeekday + 7) % 7))
}

/**
 * The most recent payday weekday on or before `today` (prd-02 Ruling 9). On
 * payday itself that is today: pay has landed and the budgets have reset.
 */
export function lastPayday(today: IsoDate, paydayWeekday: number): IsoDate {
  return formatDate(lastPaydayDate(today, paydayWeekday))
}

/**
 * The first payday strictly after `today`: seven days after the last one
 * (prd-02 Ruling 9), so a week from today on payday itself.
 */
export function nextPayday(today: IsoDate, paydayWeekday: number): IsoDate {
  return formatDate(addDaysCivil(lastPaydayDate(today, paydayWeekday), 7))
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseDate(from, 'from')
  const b = parseDate(to, 'to')
  return Math.round((utcMidnight(b) - utcMidnight(a)) / 86_400_000)
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
 * Strawb's `rate × profit`, rounded up to the cent. A loss owes nothing.
 * This is what the Tax card calls "owed so far" before the pot is netted.
 */
function strawbTaxOwed(taxRateBasisPoints: number, profitCents: Cents): Cents {
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
 * ones. Money in (income, a refund) is not spend and never offsets it. A
 * row in Drawings is never spend, even for a budget named Drawings (prd-02
 * Ruling 15).
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
    if (isDrawingCategory(tx.category)) continue
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
  const { scope, today, paydayWeekday } = input
  if (scope !== 'all' && scope !== 'personal' && scope !== 'strawb') {
    throw new RangeError(
      `scope must be all, personal or strawb, got "${String(scope)}"`,
    )
  }
  const last = lastPayday(today, paydayWeekday)
  const next = nextPayday(today, paydayWeekday)
  const daysToPayday = daysBetween(today, next)

  // Every row is checked before the scope filter, so the same rows never
  // succeed in one scope and throw in another.
  const known = new Set<string>()
  for (const a of input.accounts) {
    if (known.has(a.id)) throw new RangeError(`account "${a.id}" appears twice`)
    known.add(a.id)
  }
  for (const a of input.accounts)
    assertCents(a.balanceCents, `balanceCents of account "${a.id}"`)
  for (const b of input.bills) {
    assertNonNegativeCents(b.amountCents, `amountCents of bill "${b.id}"`)
    parseDate(b.dueDate, `dueDate of bill "${b.id}"`)
  }
  for (const b of input.budgets)
    assertNonNegativeCents(b.limitCents, `limitCents of budget "${b.id}"`)
  for (const tx of input.transactions) {
    assertCents(tx.amountCents, 'transaction amountCents')
    parseDate(tx.date, 'transaction date')
    if (!known.has(tx.accountId)) {
      throw new RangeError(`transaction on unknown account "${tx.accountId}"`)
    }
  }
  // Both tax inputs are checked whatever the scope, for the same reason.
  const strawbOwed = strawbTaxOwed(input.taxRateBasisPoints, input.profitCents)
  assertNonNegativeCents(input.personalTaxOwedCents, 'personalTaxOwedCents')

  const accounts = input.accounts.filter((a) => inScope(scope, a.scope))

  const liquidCents = sumCents(
    accounts.filter((a) => a.role === 'current').map((a) => a.balanceCents),
  )

  const dueBills = input.bills
    .filter((b) => inScope(scope, b.scope))
    .filter((b) => !b.paid && b.dueDate <= next)

  const budgets: BudgetLine[] = input.budgets
    .filter((b) => inScope(scope, b.scope))
    .map((b) => {
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

  // Each scope's hold nets only that scope's pots, and each is clamped at 0
  // before they are added, so a surplus on one side never reduces the
  // other's hold (Ruling 11). A scope not in view holds nothing.
  const potsOf = (rowScope: RowScope): Cents =>
    sumCents(
      accounts
        .filter((a) => a.role === 'tax_pot' && a.scope === rowScope)
        .map((a) => a.balanceCents),
    )
  const strawbInView = inScope(scope, 'strawb')
  const personalInView = inScope(scope, 'personal')

  const strawbTaxOwedCents = strawbInView ? strawbOwed : 0
  const strawbTaxPotCents = strawbInView ? potsOf('strawb') : 0

  // Strawb's bills are paid from its tax pot first (Ruling 12): the part of
  // the pot that covers them is not tax set aside, and those bills are not
  // taken from liquid as well. Clamped at 0, so an overdrawn pot adds no
  // bills and its overdraft stays in the hold. `dueBills` is already scoped,
  // so out of Strawb's view there are no Strawb bills and the buffer is 0.
  const strawbBillsCents = sumCents(
    dueBills.filter((b) => b.scope === 'strawb').map((b) => b.amountCents),
  )
  const strawbBillsBufferCents = Math.max(
    0,
    Math.min(strawbTaxPotCents, strawbBillsCents),
  )
  const strawbTaxHoldCents = Math.max(
    0,
    strawbTaxOwedCents - (strawbTaxPotCents - strawbBillsBufferCents),
  )

  // What comes out of liquid: every due bill in view, less what the Strawb
  // pot pays. Personal bills always come out in full.
  const unpaidBillsCents = sumCents([
    ...dueBills.map((b) => b.amountCents),
    -strawbBillsBufferCents,
  ])

  // `!== 0` also turns a typed −0 into 0, so the reported figure is never −0.
  const personalTaxOwedCents =
    personalInView && input.personalTaxOwedCents !== 0
      ? input.personalTaxOwedCents
      : 0
  const personalTaxPotCents = personalInView ? potsOf('personal') : 0
  const personalTaxHoldCents = Math.max(
    0,
    personalTaxOwedCents - personalTaxPotCents,
  )

  const taxHoldCents = sumCents([strawbTaxHoldCents, personalTaxHoldCents])

  // Owed is a negative balance (Akahu's convention, Ruling 10). Each card is
  // clamped before the sum, so credit on one never offsets debt on another.
  const cardDebtCents = sumCents(
    accounts
      .filter((a) => a.role === 'credit_card')
      .map((a) => Math.max(0, -a.balanceCents)),
  )

  const safeCents = sumCents([
    liquidCents,
    -unpaidBillsCents,
    -remainingBudgetCents,
    -taxHoldCents,
    -cardDebtCents,
  ])

  return {
    scope,
    today,
    lastPayday: last,
    nextPayday: next,
    liquidCents,
    unpaidBillsCents,
    remainingBudgetCents,
    strawbTaxOwedCents,
    strawbTaxPotCents,
    strawbBillsBufferCents,
    strawbTaxHoldCents,
    personalTaxOwedCents,
    personalTaxPotCents,
    personalTaxHoldCents,
    taxHoldCents,
    cardDebtCents,
    safeCents,
    shortByCents: Math.max(0, -safeCents),
    daysToPayday,
    perDayCents: floorDiv(safeCents, daysToPayday),
    budgets,
  }
}

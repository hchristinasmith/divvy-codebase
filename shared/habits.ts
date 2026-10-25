// Habits: the one definition of runway, the streaks and which spending is
// listed for a verdict (prd-02 Ruling 1, issue #52). `server/db/habits.ts`
// loads rows and calls these functions; GET /api/v1/habits sends what they
// return. prd-03's `get_habits` imports the same functions. Nothing else
// re-derives runway, a streak or the verdict list.
//
// Inputs are plain integer cents (M1 #8), `YYYY-MM-DD` calendar dates in
// Hannah's timezone (Pacific/Auckland) and an injected `today`; nothing here
// reads the clock. Every row is checked before the scope filter, so the same
// rows never succeed in one scope and throw in another. A row dated after
// `today` is never counted by anything here.
//
// Runway (`runwayTenths`), as `handoff.md:44` words it: liquid + savings ÷
// trailing-month spend, in tenths of a month.
//
// - assets: `runwayAssetsCents`, balances of in-scope `current` and
//   `savings` accounts (see the decision note on it).
// - spend: `trailingSpendCents`, outflow over the last `TRAILING_DAYS` NZ
//   days, today included, settled and pending, on in-scope accounts of any
//   role (a credit-card purchase is spend). Money in never nets against it.
//   Own-account transfers are not spend (`findOwnTransfers`), and neither
//   is a drawing (below).
// - A month is `TRAILING_DAYS` days of that spend, so runway in months is
//   assets ÷ spend, and in tenths it is floor(assets × 10 ÷ spend): one
//   rounding, of exact integers, down, so it never flatters (as
//   safe-to-spend's per-day figure). Assets of 0 or less are 0 months; with
//   no spend and positive assets, runway is unbounded and the contract's
//   answer is null.
//
// Drawings (prd-02 Ruling 15): a row whose effective category is Drawings
// (`isDrawingCategory`, shared/drawings.ts) is never spending, in any scope:
// not Strawb's, not Personal's, not All's. It adds nothing to runway's spend
// and is never listed for a verdict. Each row carries its effective
// category, with drawings laid over as the overview hands them to
// safe-to-spend: Drawings on both halves of a matched drawing unless Hannah
// set the row's category by hand, which wins (`effectiveCategory`). This
// module does not match drawings itself; the caller does, with
// `findDrawingIds` over every candidate, not only the rows passed here.
// prd-03's `get_habits` must hand over the same effective category.
// Drawings still move balances, so the no-overdraft streak reads them as
// any other row.
//
// Streaks (`habitStreaks`) hold only what stored data can compute (#52
// Done-when 2). The one streak is no overdraft (`noOverdraftDays`). Omitted
// deliberately, rather than estimated:
//
// - "Tax fully reserved": Divvy keeps no history of tax pots or holds. The
//   pot is an account balance known only now, and the settings it is netted
//   against are overwritten in place, so no past day can be graded.
// - "Under budget overall": there is no history of budget limits, and a
//   deleted budget leaves no trace. Grading past weeks against today's
//   limits would be an estimate, which Done-when 2 forbids.
// - "No purchases after 9pm": transactions carry a date, not a time of day.
//
// The no-overdraft streak reads `transactions.balance_cents`, which prd-03's
// scrubbed replica does not keep on its allowlist; `get_habits` cannot
// compute it from the replica as the allowlist stands.
//
// Two definitions are provisional and each sits in one function:
// `findOwnTransfers` (D1) and `runwayAssetsCents` (D2).

import type {
  AccountRole,
  Cents,
  HabitStreak,
  IsoDate,
  RowScope,
  Scope,
  TransactionStatus,
} from './contracts.ts'
import { isDrawingCategory } from './drawings.ts'
import { sumCents } from './money.ts'
import { daysBetween, daysInMonth } from './safe-to-spend.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Days of spend runway is measured against, today included. This many days
 * is one month of runway.
 */
export const TRAILING_DAYS = 30

/**
 * Days back, today included, that spending is listed for a verdict
 * (`handoff.md:42`, "last 90 days").
 */
export const VERDICT_WINDOW_DAYS = 90

/** Most verdict rows listed, newest first. */
export const VERDICT_LIST_LIMIT = 50

/**
 * Most NZ calendar days apart the two legs of an own-account transfer may
 * be dated, either way: a transfer can leave one bank on a Friday and land
 * in the other on the Monday's processing.
 */
export const TRANSFER_WINDOW_DAYS = 2

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface HabitAccount {
  id: string
  scope: RowScope
  role: AccountRole | null
  /** The account's balance now; owed on a card is negative. */
  balanceCents: Cents
}

export interface HabitTransaction {
  /** `transactions.id` as decimal text: digits, no leading zero. */
  id: string
  /** Must be one of the input accounts' `id`; its scope is the account's. */
  accountId: string
  /** The NZ calendar date. */
  date: IsoDate
  /** Signed: negative is money out. */
  amountCents: Cents
  status: TransactionStatus
  /** The account balance after this row; null when the bank sent none. */
  balanceCents: Cents | null
  /**
   * The effective category, with drawings laid over (`effectiveCategory`,
   * shared/drawings.ts): Drawings on a half of a matched drawing unless
   * Hannah set the row's category by hand. Null when it has none.
   */
  category: string | null
}

export interface HabitsInput {
  scope: Scope
  today: IsoDate
  /** Every account; the functions apply the scope. */
  accounts: readonly HabitAccount[]
  /**
   * Every row from `habitsReadFrom(today)` onward on every account, plus,
   * for the overdraft streak, every older settled row of a `current`
   * account. Rows of other scopes may be passed; a view pairs transfers
   * among its own rows only.
   */
  transactions: readonly HabitTransaction[]
}

// ---------------------------------------------------------------------------
// Validation and dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ROW_ID = /^[1-9]\d*$/
const ROLES: readonly AccountRole[] = [
  'current',
  'savings',
  'tax_pot',
  'credit_card',
]

interface CivilDate {
  year: number
  month: number // 1 to 12
  day: number
}

function parseDate(value: IsoDate, what: string): CivilDate {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null
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
  throw new RangeError(`${what} must be a YYYY-MM-DD calendar date`)
}

/**
 * `date` moved by `days` calendar days. Built with `setUTCFullYear`, never
 * `Date.UTC`, which reads the years 0 to 99 as 1900 to 1999 (#126).
 */
function addDaysIso(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseDate(date, 'date')
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day + days)
  const y = d.getUTCFullYear()
  if (y < 0 || y > 9999) {
    throw new RangeError('a date falls outside the years 0000 to 9999')
  }
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${String(y).padStart(4, '0')}-${mm}-${dd}`
}

function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${what} must be an integer number of cents`)
  }
}

/** Ids compare as the integers they spell. */
function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

function inScope(scope: Scope, rowScope: RowScope): boolean {
  return scope === 'all' || rowScope === scope
}

function checkAccounts(
  accounts: readonly HabitAccount[],
): Map<string, RowScope> {
  const scopes = new Map<string, RowScope>()
  for (const a of accounts) {
    if (scopes.has(a.id)) throw new RangeError('an account appears twice')
    if (a.scope !== 'personal' && a.scope !== 'strawb') {
      throw new RangeError('an account scope must be personal or strawb')
    }
    if (a.role !== null && !ROLES.includes(a.role)) {
      throw new RangeError('an account role is not a role')
    }
    assertCents(a.balanceCents, 'an account balanceCents')
    scopes.set(a.id, a.scope)
  }
  return scopes
}

function checkTransactions(
  transactions: readonly HabitTransaction[],
  known: ReadonlySet<string> | null,
): void {
  const ids = new Set<string>()
  for (const tx of transactions) {
    if (typeof tx.id !== 'string' || !ROW_ID.test(tx.id)) {
      throw new RangeError(
        'a transaction id must be a positive integer as text',
      )
    }
    if (ids.has(tx.id)) throw new RangeError('a transaction appears twice')
    ids.add(tx.id)
    if (known !== null && !known.has(tx.accountId)) {
      throw new RangeError('a transaction is on an unknown account')
    }
    parseDate(tx.date, 'a transaction date')
    assertCents(tx.amountCents, 'a transaction amountCents')
    if (tx.status !== 'settled' && tx.status !== 'pending') {
      throw new RangeError('a transaction status must be settled or pending')
    }
    if (tx.balanceCents !== null)
      assertCents(tx.balanceCents, 'a transaction balanceCents')
    // A caller that left the category off would count every drawing as
    // spend without a word; refuse it instead.
    if (tx.category !== null && typeof tx.category !== 'string') {
      throw new TypeError('a transaction category must be text or null')
    }
  }
}

interface Checked {
  scopeOf: Map<string, RowScope>
}

function checkInput(input: HabitsInput): Checked {
  const { scope } = input
  if (scope !== 'all' && scope !== 'personal' && scope !== 'strawb') {
    throw new RangeError('scope must be all, personal or strawb')
  }
  parseDate(input.today, 'today')
  const scopeOf = checkAccounts(input.accounts)
  checkTransactions(input.transactions, new Set(scopeOf.keys()))
  return { scopeOf }
}

/**
 * The earliest NZ date any habits figure reads, the overdraft streak
 * excepted (it reads every settled row of a `current` account): the start
 * of the longer window, less `TRANSFER_WINDOW_DAYS`, so a transfer whose
 * outflow is the window's first day still finds its inflow.
 */
export function habitsReadFrom(today: IsoDate): IsoDate {
  const longest = Math.max(TRAILING_DAYS, VERDICT_WINDOW_DAYS)
  return addDaysIso(today, -(longest - 1) - TRANSFER_WINDOW_DAYS)
}

// ---------------------------------------------------------------------------
// Decision points
// ---------------------------------------------------------------------------

/**
 * Own-account transfers among `transactions`, whatever their scope: each
 * excluded leg's id mapped to its partner leg's id, both ways.
 *
 * A transfer is an outflow of −X and an inflow of +X on two different
 * accounts, dated at most `TRANSFER_WINDOW_DAYS` NZ days apart either way,
 * settled or pending. Legs pair one to one: the candidate pairs are taken
 * nearest dates first, then lowest outflow id, then lowest inflow id, and a
 * leg already taken is skipped. So one inflow never cancels two outflows.
 * Only the date, amount and account are read, which are what prd-03's
 * replica keeps.
 *
 * Category is not read, so it pairs a drawing like any row; the view drops
 * drawings before calling it (prd-02 Ruling 15, see `transferLegsInView`).
 */
// DECISION PENDING (#52): own-account transfer detection. Provisional
// option A (pair match). Alternatives: B, Akahu `type === 'TRANSFER'`;
// C, `other_account` matches one of her accounts' `formatted_account`.
export function findOwnTransfers(
  transactions: readonly HabitTransaction[],
): Map<string, string> {
  checkTransactions(transactions, null)
  const outflows = new Map<number, HabitTransaction[]>()
  const inflows = new Map<number, HabitTransaction[]>()
  for (const tx of transactions) {
    if (tx.amountCents === 0) continue
    const side = tx.amountCents < 0 ? outflows : inflows
    const amount = Math.abs(tx.amountCents)
    const list = side.get(amount)
    if (list === undefined) side.set(amount, [tx])
    else list.push(tx)
  }
  const candidates: {
    out: HabitTransaction
    in: HabitTransaction
    gap: number
  }[] = []
  for (const [amount, outs] of outflows) {
    const ins = inflows.get(amount)
    if (ins === undefined) continue
    for (const out of outs) {
      for (const inn of ins) {
        if (out.accountId === inn.accountId) continue
        const gap = Math.abs(daysBetween(out.date, inn.date))
        if (gap <= TRANSFER_WINDOW_DAYS) candidates.push({ out, in: inn, gap })
      }
    }
  }
  candidates.sort(
    (a, b) =>
      a.gap - b.gap ||
      compareIds(a.out.id, b.out.id) ||
      compareIds(a.in.id, b.in.id),
  )
  const pairs = new Map<string, string>()
  for (const c of candidates) {
    if (pairs.has(c.out.id) || pairs.has(c.in.id)) continue
    pairs.set(c.out.id, c.in.id)
    pairs.set(c.in.id, c.out.id)
  }
  return pairs
}

/**
 * The money runway counts: balances of `scope`'s accounts whose role is
 * `current` or `savings`. Tax pots, credit cards and accounts with no role
 * add nothing.
 */
// DECISION PENDING (#52): card debt. Provisional: the literal formula,
// liquid + savings, with card debt not subtracted. Alternative: subtract,
// over in-scope `credit_card` accounts, max(0, −balance) per card.
export function runwayAssetsCents(
  accounts: readonly HabitAccount[],
  scope: Scope,
): Cents {
  checkAccounts(accounts)
  return sumCents(
    accounts
      .filter((a) => inScope(scope, a.scope))
      .filter((a) => a.role === 'current' || a.role === 'savings')
      .map((a) => a.balanceCents),
  )
}

// ---------------------------------------------------------------------------
// Transfers in a view
// ---------------------------------------------------------------------------

/**
 * Transfer legs left out of `input.scope`'s view. Pairs are found among the
 * view's own rows only, from `habitsReadFrom(today)` to today, so how much
 * older history a caller passes changes nothing, and a row of another
 * scope can never take a leg's partner and move this view's figures. A
 * pair is left out only when both legs are in the view: a Personal →
 * Strawb payment is not spend in All, and is Personal's spend in the
 * Personal view. A Strawb → Personal payment matched as a drawing is
 * never spend in any view (prd-02 Ruling 15); one the drawing match did not
 * take, or whose halves Hannah gave another category by hand, is a transfer
 * like any other, so Strawb's spend in the Strawb view.
 */
function transferLegsInView(input: HabitsInput, checked: Checked): Set<string> {
  const from = habitsReadFrom(input.today)
  const inView = input.transactions.filter((tx) => {
    const rowScope = checked.scopeOf.get(tx.accountId)
    return (
      rowScope !== undefined &&
      inScope(input.scope, rowScope) &&
      tx.date >= from &&
      tx.date <= input.today &&
      // A drawing is never spend, so it never needs a partner to drop out;
      // left in, a drawing half could take another row's partner and leave
      // that row counted as spend. Dropped here, before pairing.
      !isDrawingCategory(tx.category)
    )
  })
  return new Set(findOwnTransfers(inView).keys())
}

/**
 * In-scope outflows of the view, not drawings and not transfer legs, dated
 * `from` to today.
 */
function viewOutflows(
  input: HabitsInput,
  checked: Checked,
  from: IsoDate,
  settledOnly: boolean,
): HabitTransaction[] {
  const transfers = transferLegsInView(input, checked)
  return input.transactions.filter((tx) => {
    const rowScope = checked.scopeOf.get(tx.accountId)
    if (rowScope === undefined || !inScope(input.scope, rowScope)) return false
    if (tx.amountCents >= 0) return false
    // A drawing is never spending (prd-02 Ruling 15).
    if (isDrawingCategory(tx.category)) return false
    if (settledOnly && tx.status !== 'settled') return false
    // ISO dates compare correctly as strings.
    if (tx.date < from || tx.date > input.today) return false
    return !transfers.has(tx.id)
  })
}

// ---------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------

/**
 * Outflow of the view over the last `TRAILING_DAYS` NZ days, today
 * included, as a positive number of cents: settled and pending rows on
 * in-scope accounts of any role, drawings and own-account transfers left
 * out.
 */
export function trailingSpendCents(input: HabitsInput): Cents {
  const checked = checkInput(input)
  const from = addDaysIso(input.today, -(TRAILING_DAYS - 1))
  return sumCents(
    viewOutflows(input, checked, from, false).map((tx) => -tx.amountCents),
  )
}

/**
 * Months of runway in tenths: floor(assets × 10 ÷ trailing spend), one
 * rounding of exact integers, down. 0 when assets are 0 or less; null when
 * there is no spend and runway is unbounded. Throws a RangeError when
 * assets × 10 is past the safe integers rather than rounding it.
 */
export function runwayTenths(input: HabitsInput): number | null {
  checkInput(input)
  const assets = runwayAssetsCents(input.accounts, input.scope)
  if (assets <= 0) return 0
  const spend = trailingSpendCents(input)
  if (spend === 0) return null
  const scaled = assets * 10
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError('runway assets are too large to compute exactly')
  }
  return (scaled - (scaled % spend)) / spend
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

/**
 * Days without an overdraft on the view's `current` accounts, today
 * counted. 0 only on evidence of an overdraft today; null (the streak is
 * omitted, #52 Done-when 2) when the view has no `current` account, or when
 * one of them has no balance evidence to count from.
 *
 * - A NZ day is overdrawn on an account when any settled row that day
 *   leaves its balance below 0. Rows within a day have no order, so one
 *   negative row makes the whole day overdrawn. The carry rule: a day with
 *   no row keeps the state of the latest earlier day with a row that
 *   carries a balance. Pending rows carry no balance and are not read.
 * - A settled row with no balance moves the balance by an unknown amount,
 *   so no day from its own onward is clean on evidence until a later day
 *   has a row that carries a balance. It never ends an overdraft: an
 *   overdrawn state carries across it.
 * - 0: an account's balance now is below 0, or an account's overdrawn
 *   state, carried, reaches today. This wins over null.
 * - Known from, per account: the earliest day with a settled row that
 *   carries a balance and is later than every settled row with no balance.
 *   An account with no such day (no settled rows, only rows with no
 *   balance, or a row with no balance on or after its newest balance) has
 *   nothing to count from, so the streak is null. Its balance now, when not
 *   below 0, is not that evidence: it is one moment, not a day.
 * - Otherwise start = the latest of each account's known-from and the day
 *   after each account's last overdrawn day, carried. The streak is the
 *   days from start to today, both counted, so at least 1: 1 when
 *   yesterday was the last overdrawn day.
 */
export function noOverdraftDays(input: HabitsInput): number | null {
  checkInput(input)
  // Drawings are not dropped here: they still move balances (prd-02 Ruling
  // 15), and this reads only balances, never categories.
  const { today } = input
  const currents = input.accounts.filter(
    (a) => a.role === 'current' && inScope(input.scope, a.scope),
  )
  if (currents.length === 0) return null
  if (currents.some((a) => a.balanceCents < 0)) return 0

  let start = '0000-01-01'
  let unevidenced = false
  for (const account of currents) {
    const rows = input.transactions.filter(
      (tx) =>
        tx.accountId === account.id &&
        tx.status === 'settled' &&
        tx.date <= today,
    )
    // Each day with a row that carries a balance, and whether it is
    // overdrawn.
    const days = new Map<IsoDate, boolean>()
    let newestUnknown: IsoDate | null = null
    for (const tx of rows) {
      if (tx.balanceCents === null) {
        if (newestUnknown === null || tx.date > newestUnknown)
          newestUnknown = tx.date
        continue
      }
      days.set(tx.date, (days.get(tx.date) ?? false) || tx.balanceCents < 0)
    }
    const rowDays = [...days.keys()].sort()

    let lastOverdrawnRowDay = -1
    for (let i = 0; i < rowDays.length; i++) {
      if (days.get(rowDays[i])) lastOverdrawnRowDay = i
    }
    if (lastOverdrawnRowDay !== -1) {
      // The overdraft runs until the next row day, which is not overdrawn;
      // with no later row day it runs through today.
      const clearFrom = rowDays[lastOverdrawnRowDay + 1]
      if (clearFrom === undefined) return 0
      if (clearFrom > start) start = clearFrom
    }

    const knownFrom = rowDays.find(
      (day) => newestUnknown === null || day > newestUnknown,
    )
    if (knownFrom === undefined) unevidenced = true
    else if (knownFrom > start) start = knownFrom
  }
  if (unevidenced) return null
  return daysBetween(start, today) + 1
}

/**
 * The streaks stored data can compute, for the view. See the header for
 * the ones left out and why.
 */
export function habitStreaks(input: HabitsInput): HabitStreak[] {
  const days = noOverdraftDays(input)
  if (days === null) return []
  return [{ key: 'no_overdraft', label: 'No overdraft', days }]
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * The spending listed for a verdict: settled outflows of the view over the
 * last `VERDICT_WINDOW_DAYS` NZ days, today included, drawings (never
 * spending, prd-02 Ruling 15) and own-account transfers left out, newest
 * date first, then highest id, at most
 * `VERDICT_LIST_LIMIT`. A pending row is never listed: its id changes on
 * every sync (prd-01 Ruling 1), so a verdict on it would be lost.
 */
export function recentSpendingIds(input: HabitsInput): string[] {
  const checked = checkInput(input)
  const from = addDaysIso(input.today, -(VERDICT_WINDOW_DAYS - 1))
  return viewOutflows(input, checked, from, true)
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : compareIds(b.id, a.id),
    )
    .slice(0, VERDICT_LIST_LIMIT)
    .map((tx) => tx.id)
}

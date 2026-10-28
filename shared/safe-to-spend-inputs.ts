// Safe-to-spend's inputs, gathered from stored rows (#472). The overview
// (server/db/overview.ts) and prd-03's `get_safe_to_spend` load the same
// rows and hand them here, so the two feed `safeToSpend` from one
// piece of code and cannot differ by a cent (prd-02 Ruling 1). `mcp/` imports
// `shared/`, never `server/` (prd-03 Ruling 6), which is why this lives
// here and not beside the queries.
//
// This module is pure: rows in, inputs out. No knex, no clock, no I/O; `now`
// is an argument. It does no money arithmetic either: every amount is a
// stored value passed through, and the figures are `safeToSpend`'s
// (shared/safe-to-spend.ts). Calendar dates come from shared/nz-dates.ts.
//
// What the caller loads, and what this module makes of it:
//
// - Settings: the safe-to-spend setting rows (`SAFE_TO_SPEND_SETTING_KEYS`)
//   in the query's order, newest first within a key; the first row per key
//   wins. An absent key takes its documented default (`SETTINGS_DEFAULTS`);
//   a present one that is not a whole number, or not a safe integer, is an
//   error, never the default. Range is left to `safeToSpend`.
// - Accounts: every stored Akahu account in id order, and the
//   `account_settings` role rows. No role row means no role. An account with
//   no balance is an error, never 0. A Xero row (prd-01 Ruling 9) is never
//   handed over: prd-02 Ruling 4 keeps Xero out of safe-to-spend.
// - Bills (#35 option C, as ruled on #151, option A): every unpaid
//   occurrence of a bill due on or before the next payday is its own input,
//   overdue ones included. A paid occurrence is one with a `bill_payments`
//   row for its date. A bill past `MAX_UNPAID_OCCURRENCES` is left out whole
//   and returned in `leftOutBills`, so the overview can name it (#247).
// - The window: Akahu transaction rows dated from `safeToSpendWindowStart`
//   on, plus every row with no date, so an undated row is refused rather
//   than silently left out of spent. A row on an account that is not stored
//   is skipped; a stored one with no date or amount is an error.
// - Drawings (prd-02 Ruling 15): the all-time candidate rows
//   (server/db/drawings.ts loads them); a half Hannah has not categorised by
//   hand is handed over as Drawings, which `safeToSpend` never counts.
//
// Errors leave as `SafeToSpendInputError`, whose message is one of a closed
// set of constant texts, so no row id or stored value reaches a response.
// The date and money code's RangeError and TypeError, whose messages name
// ids and values, are turned into one of those texts here.

import {
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type AccountRole,
  type AccountSummary,
  type Cents,
  type IsoDate,
  type RowScope,
  type TransactionStatus,
} from './contracts.ts'
import type { BillRepeat } from '../models/planning.ts'
import type { CategorySource } from '../models/transactions.ts'
import {
  effectiveCategory,
  findDrawingIds,
  type DrawingCandidate,
} from './drawings.ts'
import {
  MAX_UNPAID_OCCURRENCES,
  addDaysIso,
  billOccurrencesThrough,
  nzCalendarDate,
} from './nz-dates.ts'
import {
  lastPayday,
  nextPayday,
  type SafeToSpendAccount,
  type SafeToSpendBill,
  type SafeToSpendBudget,
  type SafeToSpendInput,
  type SafeToSpendTransaction,
} from './safe-to-spend.ts'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The closed set of texts a gathering failure may carry. */
export type SafeToSpendInputErrorMessage =
  | 'safe-to-spend input invalid'
  | 'a stored setting is not valid'
  | 'an account has no balance'
  | 'a transaction is incomplete'

export class SafeToSpendInputError extends Error {
  readonly reason: SafeToSpendInputErrorMessage

  constructor(reason: SafeToSpendInputErrorMessage) {
    super(reason)
    this.name = 'SafeToSpendInputError'
    this.reason = reason
  }
}

/**
 * Runs a call into shared date or money code, turning its RangeError or
 * TypeError into the fixed text.
 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new SafeToSpendInputError('safe-to-spend input invalid')
    }
    throw err
  }
}

/**
 * The NZ calendar date of `at`, with the shared RangeError for an invalid
 * Date turned into `a transaction is incomplete`.
 */
function nzDate(at: Date): IsoDate {
  try {
    return nzCalendarDate(at)
  } catch (err) {
    if (err instanceof RangeError) {
      throw new SafeToSpendInputError('a transaction is incomplete')
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A stored Akahu account, as much of it as safe-to-spend reads. */
export interface InputAccountRow {
  id: number
  akahu_id: string | null
  name: string
  scope: RowScope
  balance_cents: Cents | null
}

/** A row of `account_settings`. */
export interface InputAccountRoleRow {
  account_id: number
  role: AccountRole
}

/** A row of `settings`. `value` is checked here, so it is not trusted. */
export interface InputSettingRow {
  key: string
  value: unknown
}

/** A row of `bills`. */
export interface InputBillRow {
  id: number
  scope: RowScope
  name: string
  amount_cents: Cents
  repeat: BillRepeat
  first_due_date: IsoDate
}

/** A row of `bill_payments`: that occurrence of that bill is paid. */
export interface InputBillPaymentRow {
  bill_id: number
  due_date: IsoDate
}

/** A row of `budgets`. */
export interface InputBudgetRow {
  id: number
  scope: RowScope
  category: string
  limit_cents: Cents
}

/** An Akahu row of `transactions` in the window, or with no date. */
export interface InputTransactionRow {
  id: number
  account_id: string | null
  /** A stored UTC instant. */
  date: string | null
  amount_cents: Cents | null
  category: string | null
  category_source: CategorySource
  status: TransactionStatus
}

/**
 * A row that could be a half of a drawing: an Akahu row on a stored Akahu
 * account, a Strawb outflow or a personal inflow, with a date. Its scope is
 * its account's.
 */
export interface DrawingCandidateRow {
  id: number
  scope: RowScope
  /** A stored UTC instant. */
  date: string
  amount_cents: number
}

/** Every row the gathering reads, as loaded. */
export interface SafeToSpendRows {
  /** Every stored Akahu account, in id order. */
  accounts: readonly InputAccountRow[]
  accountRoles: readonly InputAccountRoleRow[]
  /** In the query's order: within a key, the row to use first. */
  settings: readonly InputSettingRow[]
  /** In id order. */
  bills: readonly InputBillRow[]
  billPayments: readonly InputBillPaymentRow[]
  /** In id order. */
  budgets: readonly InputBudgetRow[]
  /** Rows dated from `safeToSpendWindowStart` on, and rows with no date. */
  windowTransactions: readonly InputTransactionRow[]
  /** All-time drawing candidates. */
  drawingCandidates: readonly DrawingCandidateRow[]
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Settings {
  taxRateBasisPoints: number
  profitCents: number
  paydayWeekday: number
  personalTaxOwedCents: number
}

const NUMERIC_SETTINGS = [
  'taxRateBasisPoints',
  'profitCents',
  'paydayWeekday',
  'personalTaxOwedCents',
] as const satisfies readonly (keyof Settings)[]

/** The `settings` keys the gathering reads; load only these. */
export const SAFE_TO_SPEND_SETTING_KEYS: readonly string[] =
  NUMERIC_SETTINGS.map((field) => SETTING_KEYS[field])

const WHOLE_NUMBER = /^-?\d+$/

/**
 * The settings safe-to-spend needs. `settings` has a UNIQUE `key`
 * (migration 20261025150000, #46), so a key has at most one row; taking the
 * first row per key in the caller's order picks between rows only on a
 * table without that constraint, and is kept as a guard.
 */
function readSettings(rows: readonly InputSettingRow[]): Settings {
  const newest = new Map<string, unknown>()
  for (const row of rows) {
    if (!newest.has(row.key)) newest.set(row.key, row.value)
  }
  const settings: Settings = {
    taxRateBasisPoints: SETTINGS_DEFAULTS.tax_rate_bp,
    profitCents: SETTINGS_DEFAULTS.profit_cents,
    paydayWeekday: SETTINGS_DEFAULTS.payday_weekday,
    personalTaxOwedCents: SETTINGS_DEFAULTS.personal_tax_owed_cents,
  }
  for (const field of NUMERIC_SETTINGS) {
    const key = SETTING_KEYS[field]
    if (!newest.has(key)) continue
    const value = newest.get(key)
    // `value` is NOT NULL (#46), so the type test is a guard; the whole-number
    // test is live, since stored text such as a blank or a decimal reaches it.
    if (typeof value !== 'string' || !WHOLE_NUMBER.test(value)) {
      throw new SafeToSpendInputError('a stored setting is not valid')
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      throw new SafeToSpendInputError('a stored setting is not valid')
    }
    settings[field] = parsed
  }
  return settings
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * The first stored date the window query must read from: the day before
 * the last payday. Stored dates are UTC instants and NZ is ahead of UTC, so
 * a row on the NZ payday is never dated earlier than the day before it in
 * UTC; `safeToSpend` drops whatever falls before the payday once the NZ
 * date is known. The caller needs it before the transactions load, so it
 * takes only the setting rows. Refuses as `gatherSafeToSpendInputs` would.
 */
export function safeToSpendWindowStart(
  settingRows: readonly InputSettingRow[],
  now: Date,
): IsoDate {
  const today = nzDate(now)
  const settings = readSettings(settingRows)
  const last = guard(() => lastPayday(today, settings.paydayWeekday))
  return guard(() => addDaysIso(last, -1))
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

/** The only date shape the shared matcher accepts. */
const NZ_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The ids of both halves of every drawing among the candidates (prd-02
 * Ruling 15). A candidate whose date is not an instant cannot be placed and
 * is never a drawing. The matcher is strict and throws on one bad
 * candidate; a row it cannot place (a year past 9999, an amount that is not
 * whole cents) is skipped here instead, so one odd row never fails every
 * list. The matcher's own RangeError and TypeError are left to the caller.
 */
export function drawingIdsFromCandidates(
  rows: readonly DrawingCandidateRow[],
): Set<number> {
  const candidates: DrawingCandidate[] = []
  for (const row of rows) {
    const at = new Date(row.date)
    // Skipped before `nzCalendarDate` is called, so its RangeError is never
    // reached here.
    if (Number.isNaN(at.getTime())) continue
    const date = nzCalendarDate(at)
    if (!NZ_DAY.test(date) || !Number.isSafeInteger(row.amount_cents)) continue
    candidates.push({
      id: row.id,
      scope: row.scope,
      date,
      amountCents: row.amount_cents,
    })
  }
  return findDrawingIds(candidates)
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * A bill with more unpaid occurrences than `MAX_UNPAID_OCCURRENCES`. None of
 * its occurrences reach safe-to-spend or the alerts; it is named by its own
 * alert instead (#247, ruled by Hannah 2026-10-26).
 */
export interface LeftOutBill {
  id: number
  name: string
  scope: RowScope
  amount_cents: Cents
}

/** One unpaid occurrence of a bill, as the alerts need it. */
export interface BillOccurrence {
  billId: number
  name: string
  scope: RowScope
  amountCents: Cents
  dueDate: IsoDate
}

/** `SafeToSpendInput` but its scope, and what the overview's alerts read. */
export interface GatheredSafeToSpendInputs
  extends Omit<SafeToSpendInput, 'scope'> {
  accounts: SafeToSpendAccount[]
  bills: SafeToSpendBill[]
  budgets: SafeToSpendBudget[]
  transactions: SafeToSpendTransaction[]
  /** The same accounts as cards, picked field by field, never spread. */
  cards: AccountSummary[]
  occurrences: BillOccurrence[]
  /** Bills past the unpaid-occurrence limit, in id order. */
  leftOutBills: LeftOutBill[]
  /** Both halves of every drawing (prd-02 Ruling 15). */
  drawingIds: Set<number>
}

/**
 * Safe-to-spend's inputs for every scope, from stored rows and `now`.
 * `safeToSpend` applies the scope itself, so every account, occurrence,
 * budget and window row is handed over whatever scope is asked for.
 */
export function gatherSafeToSpendInputs(
  rows: SafeToSpendRows,
  now: Date,
): GatheredSafeToSpendInputs {
  // Refuses in the order `safeToSpendWindowStart` does: today, the
  // settings, then the payday (`nextPayday` refuses whatever `lastPayday`
  // would, with the same text).
  const today = nzDate(now)
  const settings = readSettings(rows.settings)
  const next = guard(() => nextPayday(today, settings.paydayWeekday))

  // Accounts and their roles. No role row means no role.
  const accountRoles = new Map(
    rows.accountRoles.map((r) => [r.account_id, r.role]),
  )
  const accounts: SafeToSpendAccount[] = []
  const cards: AccountSummary[] = []
  for (const row of rows.accounts) {
    // Sync always writes a balance; a missing one is not fabricated as 0.
    if (row.balance_cents === null) {
      throw new SafeToSpendInputError('an account has no balance')
    }
    const role = accountRoles.get(row.id) ?? null
    accounts.push({
      id: String(row.id),
      scope: row.scope,
      role,
      balanceCents: row.balance_cents,
    })
    cards.push({
      id: String(row.id),
      name: row.name,
      scope: row.scope,
      role,
      balanceCents: row.balance_cents,
    })
  }

  // Bills: every unpaid occurrence through the next payday.
  const paid = new Set(
    rows.billPayments.map((p) => `${p.bill_id}|${p.due_date}`),
  )
  const bills: SafeToSpendBill[] = []
  const occurrences: BillOccurrence[] = []
  const leftOutBills: LeftOutBill[] = []
  for (const bill of rows.bills) {
    const unpaid = guard(() => billOccurrencesThrough(bill, next)).filter(
      (dueDate) => !paid.has(`${bill.id}|${dueDate}`),
    )
    // Past the limit the bill is left out whole, never truncated, and
    // named by an alert so the missing amount is visible (#247).
    if (unpaid.length > MAX_UNPAID_OCCURRENCES) {
      leftOutBills.push({
        id: bill.id,
        name: bill.name,
        scope: bill.scope,
        amount_cents: bill.amount_cents,
      })
      continue
    }
    for (const dueDate of unpaid) {
      bills.push({
        id: `${bill.id}:${dueDate}`,
        scope: bill.scope,
        amountCents: bill.amount_cents,
        dueDate,
        paid: false,
      })
      occurrences.push({
        billId: bill.id,
        name: bill.name,
        scope: bill.scope,
        amountCents: bill.amount_cents,
        dueDate,
      })
    }
  }

  const budgets: SafeToSpendBudget[] = rows.budgets.map((row) => ({
    id: String(row.id),
    scope: row.scope,
    category: row.category,
    limitCents: row.limit_cents,
  }))

  // The window, with drawings laid over each row's effective category.
  const accountIdByAkahuId = new Map<string, string>()
  for (const row of rows.accounts) {
    if (row.akahu_id !== null)
      accountIdByAkahuId.set(row.akahu_id, String(row.id))
  }
  const drawingIds = guard(() =>
    drawingIdsFromCandidates(rows.drawingCandidates),
  )
  const transactions: SafeToSpendTransaction[] = []
  for (const row of rows.windowTransactions) {
    // A row on an account that is not stored has no scope to count in.
    const accountId =
      row.account_id === null
        ? undefined
        : accountIdByAkahuId.get(row.account_id)
    if (accountId === undefined) continue
    if (row.date === null || row.amount_cents === null) {
      throw new SafeToSpendInputError('a transaction is incomplete')
    }
    transactions.push({
      accountId,
      date: nzDate(new Date(row.date)),
      amountCents: row.amount_cents,
      category: effectiveCategory(
        { category: row.category, categorySource: row.category_source },
        drawingIds.has(row.id),
      ).category,
      status: row.status,
    })
  }

  return {
    today,
    paydayWeekday: settings.paydayWeekday,
    taxRateBasisPoints: settings.taxRateBasisPoints,
    profitCents: settings.profitCents,
    personalTaxOwedCents: settings.personalTaxOwedCents,
    accounts,
    cards,
    bills,
    occurrences,
    leftOutBills,
    budgets,
    transactions,
    drawingIds,
  }
}

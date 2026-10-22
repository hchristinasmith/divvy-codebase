// The typed API contract for prd-02's routes (prd-02 Sequencing: "built
// against the typed contract from wave 1"). Screens and routes in later
// waves build against these shapes instead of against each other, and the
// MCP advisor (prd-03) imports the same ones.
//
// Field names here are API shapes in camelCase. Column names belong to the
// migrations (#39) and are mapped in each route's data module; nothing here
// names a column.
//
// Every money field is `Cents`: integer cents, never a float, never a
// decimal string (M1 #8). Format with `formatCents` from `./money.ts` at the
// edge; there is no second formatter.
//
// No runtime code beyond the settings constants and no runtime imports, so
// it is safe to import from the client, the server and `mcp/`.

import type { CategorySource } from '../models/transactions.ts'

export type { CategorySource }

/** Integer cents. A plain number at runtime; the alias marks money fields. */
export type Cents = number

/** A calendar date as `YYYY-MM-DD`, with no time and no timezone. */
export type IsoDate = string

/** An instant as an ISO 8601 timestamp, e.g. a sync time. */
export type IsoTimestamp = string

/**
 * The All / Personal / Strawb toggle (`handoff.md:19-20`). `all` is a view,
 * not an owner: no row is ever stored with scope `all`.
 */
export type Scope = 'all' | 'personal' | 'strawb'

/** Who owns a row (prd-01 Ruling 8, prd-02 Ruling 4). */
export type RowScope = 'personal' | 'strawb'

/**
 * What an account is for (prd-02 Ruling 2; the values #39 constrains
 * `account_settings.role` to). An account with no role row is `null` where
 * it appears, and is not liquid.
 */
export type AccountRole = 'current' | 'savings' | 'tax_pot'

export type TransactionStatus = 'settled' | 'pending'

/** Query shape for every scoped read: `?scope=all|personal|strawb`. */
export interface ScopeQuery {
  scope: Scope
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Settings key names as stored in the key/value `settings` table, with the
 * value each takes when no row exists. Values are stored as strings in that
 * table; the settings route parses them into `SettingsResponse`.
 *
 * - `tax_rate_bp`: tax rate in basis points (2500 = 25%), an integer so a
 *   rate like 10.5% needs no float. 25% is the handoff's default
 *   (`handoff.md:78`).
 * - `profit_cents`: Strawb's year-to-date accrual profit (prd-02 open
 *   question, answered 2026-10-23). 0 until Xero is connected (prd-05
 *   Ruling 4), which makes the tax hold 0.
 * - `payday_day`: day of the month pay arrives, 1 to 31. A day past the end
 *   of a short month means that month's last day.
 * - `currency`: the display symbol tweak from `handoff.md:78`.
 */
export const SETTINGS_DEFAULTS = {
  tax_rate_bp: 2500,
  profit_cents: 0,
  payday_day: 28,
  currency: '$',
} as const

export type SettingKey = keyof typeof SETTINGS_DEFAULTS

/** Which stored key each `SettingsResponse` field is read from. */
export const SETTING_KEYS = {
  taxRateBasisPoints: 'tax_rate_bp',
  profitCents: 'profit_cents',
  paydayDay: 'payday_day',
  currency: 'currency',
} as const satisfies Record<keyof SettingsResponse, SettingKey>

export type CurrencySymbol = '$' | 'NZ$' | '£'

/** GET /api/v1/settings */
export interface SettingsResponse {
  taxRateBasisPoints: number
  profitCents: Cents
  paydayDay: number
  currency: CurrencySymbol
}

/** PATCH /api/v1/settings: any subset; omitted keys are unchanged. */
export type UpdateSettingsRequest = Partial<SettingsResponse>

// ---------------------------------------------------------------------------
// Safe to spend (the overview hero)
// ---------------------------------------------------------------------------

/**
 * What `safeToSpend` in `./safe-to-spend.ts` returns, and what the overview
 * route sends unchanged. The client displays it; it never recomputes it
 * (prd-02 Ruling 1).
 *
 * `safeCents` is signed (prd-02 Ruling 3): the hero shows `$0` and
 * "short by `shortByCents`" when it is negative. The clamp is the screen's.
 */
export interface SafeToSpendResult {
  scope: Scope
  today: IsoDate
  lastPayday: IsoDate
  nextPayday: IsoDate
  liquidCents: Cents
  unpaidBillsCents: Cents
  remainingBudgetCents: Cents
  /** `taxRate × profit`, before netting the tax pot. 0 in Personal. */
  taxOwedCents: Cents
  /** Balance of the in-scope `tax_pot` accounts. 0 in Personal. */
  taxPotCents: Cents
  /** `max(0, taxOwedCents − taxPotCents)`. 0 in Personal. */
  taxHoldCents: Cents
  safeCents: Cents
  /** `max(0, −safeCents)`. */
  shortByCents: Cents
  /** Whole days from `today` to `nextPayday`; at least 1. */
  daysToPayday: number
  /** `safeCents ÷ daysToPayday`, rounded down. Negative when short. */
  perDayCents: Cents
  /** One line per in-scope budget; `remainingBudgetCents` is their sum. */
  budgets: BudgetLine[]
}

/** A budget as the safe-to-spend function saw it. */
export interface BudgetLine {
  id: string
  scope: RowScope
  category: string
  limitCents: Cents
  /** Outflow in `category` from `lastPayday` to `today`, as a positive. */
  spentCents: Cents
  /** `max(0, limitCents − spentCents)`. */
  remainingCents: Cents
  /** `max(0, spentCents − limitCents)`. */
  overCents: Cents
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AccountSummary {
  id: string
  /** A display name only, never an account number. */
  name: string
  scope: RowScope
  role: AccountRole | null
  balanceCents: Cents
}

export type AlertKind = 'over_budget' | 'bill_due_soon' | 'bill_overdue'

/** Alerts are derived on read; only a dismissal is stored. */
export interface Alert {
  /** Stable for the same condition, so a dismissal keeps matching it. */
  id: string
  kind: AlertKind
  scope: RowScope
  /** The budget's category or the bill's name. */
  subject: string
  /** Amount over budget, or the bill's amount. */
  amountCents: Cents
  /** The bill's due date; null for a budget alert. */
  dueDate: IsoDate | null
}

export interface ActivityRow {
  id: string
  date: IsoDate
  description: string
  /** Signed: negative is money out, positive is money in. */
  amountCents: Cents
  scope: RowScope
  /** A display name only, never an account number. */
  accountName: string
  status: TransactionStatus
  /** Effective category; null when neither Akahu nor the user set one. */
  category: string | null
  categorySource: CategorySource
}

/** GET /api/v1/overview?scope= */
export interface OverviewResponse {
  safeToSpend: SafeToSpendResult
  accounts: AccountSummary[]
  alerts: Alert[]
  recentActivity: ActivityRow[]
  /** When the last successful sync finished; null if none has. */
  dataAsOf: IsoTimestamp | null
}

/** POST /api/v1/alerts/:id/dismiss */
export interface DismissAlertResponse {
  id: string
  dismissedAt: IsoTimestamp
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * A budget for the Budgets screen: the line `safeToSpend` computed for it
 * (so the screen and the hero cannot disagree on spent) plus its note.
 * `category` is an effective-category name.
 */
export interface BudgetResponse extends BudgetLine {
  note: string | null
}

/** GET /api/v1/budgets?scope= */
export interface BudgetsResponse {
  items: BudgetResponse[]
  /** The last payday: spend is counted from this date. */
  periodStart: IsoDate
  /** The next payday: the budget resets on this date. */
  periodEnd: IsoDate
}

/** POST /api/v1/budgets */
export interface CreateBudgetRequest {
  scope: RowScope
  category: string
  limitCents: Cents
  note?: string | null
}

/** PATCH /api/v1/budgets/:id */
export interface UpdateBudgetRequest {
  limitCents?: Cents
  note?: string | null
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

/**
 * One bill as due on one date. Whether bills repeat is #35's answer and the
 * migration's (#39); whatever it is, the bills route resolves each bill to
 * the occurrence that is due, which is the shape here.
 */
export interface BillResponse {
  id: string
  scope: RowScope
  name: string
  amountCents: Cents
  dueDate: IsoDate
  paid: boolean
  /** When "Mark paid" was pressed for this occurrence; null if unpaid. */
  paidAt: IsoTimestamp | null
  /** The account it is paid from, for the "Personal · BNZ" meta line. */
  accountName: string | null
}

/** GET /api/v1/bills?scope= */
export interface BillsResponse {
  items: BillResponse[]
  /** Unpaid, due on or before the next payday (the same rule as the hero). */
  dueBeforePaydayCents: Cents
  paidThisMonthCents: Cents
}

/** POST /api/v1/bills */
export interface CreateBillRequest {
  scope: RowScope
  name: string
  amountCents: Cents
  dueDate: IsoDate
  accountId?: string | null
}

/** PATCH /api/v1/bills/:id */
export type UpdateBillRequest = Partial<CreateBillRequest>

/** POST /api/v1/bills/:id/payments: "Mark paid" records a payment. */
export interface MarkBillPaidResponse {
  bill: BillResponse
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * A goal. `savedCents` is the sum of its contribution records, never a
 * stored column, and a contribution never changes safe-to-spend
 * (prd-02 Ruling 5).
 */
export interface GoalResponse {
  id: string
  name: string
  targetCents: Cents
  savedCents: Cents
  targetDate: IsoDate | null
}

/** GET /api/v1/goals */
export interface GoalsResponse {
  items: GoalResponse[]
}

/** POST /api/v1/goals */
export interface CreateGoalRequest {
  name: string
  targetCents: Cents
  targetDate?: IsoDate | null
}

/** PATCH /api/v1/goals/:id */
export type UpdateGoalRequest = Partial<CreateGoalRequest>

/** POST /api/v1/goals/:id/contributions: the +$50 / +$200 buttons. */
export interface AddGoalContributionRequest {
  amountCents: Cents
}

export interface AddGoalContributionResponse {
  goal: GoalResponse
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

/** The user's own verdict on a spend (`handoff.md:44`); null clears it. */
export type Verdict = 'worth_it' | 'not_really'

export interface HabitStreak {
  /** Stable identifier, e.g. `no_overdraft`. */
  key: string
  label: string
  days: number
}

export interface VerdictRow {
  transactionId: string
  date: IsoDate
  merchant: string
  category: string | null
  /** Signed, as on the transaction. */
  amountCents: Cents
  verdict: Verdict | null
}

/**
 * GET /api/v1/habits?scope=. There is deliberately no freedom-date field:
 * its formula is an open question (prd-02), hidden rather than faked.
 */
export interface HabitsResponse {
  /**
   * Months of runway in tenths (78 = 7.8 months), so the ratio is an
   * integer; null when trailing-month spend is 0 and runway is unbounded.
   */
  runwayTenths: number | null
  /** Only streaks computable from stored data; others are omitted. */
  streaks: HabitStreak[]
  verdicts: VerdictRow[]
}

/** PUT /api/v1/habits/verdicts/:transactionId */
export interface SetVerdictRequest {
  verdict: Verdict | null
}

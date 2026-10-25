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
// No runtime code beyond the settings constants and the closed lists
// `CURRENCY_SYMBOLS` and `ACCOUNT_ROLES`, and no runtime imports, so it is
// safe to import from the client, the server and `mcp/`.

import type { BillRepeat } from '../models/planning.ts'
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
 * What an account is for (prd-02 Rulings 2, 10 and 11; the values #39
 * constrains `account_settings.role` to). An account with no role row is
 * `null` where it appears, and is not liquid.
 *
 * - `current`: liquid.
 * - `savings`: not liquid.
 * - `tax_pot`: not liquid; nets the tax hold of its own scope only. Each
 *   scope may have its own (Ruling 11).
 * - `credit_card`: not liquid; what is owed on it is card debt, subtracted
 *   from safe-to-spend (Ruling 10).
 */
export type AccountRole = 'current' | 'savings' | 'tax_pot' | 'credit_card'

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
 *   (`handoff.md:78`). It applies to Strawb's profit only (prd-02
 *   Ruling 11).
 * - `profit_cents`: Strawb's year-to-date accrual profit (prd-02 open
 *   question, answered 2026-10-23). 0 until Xero is connected (prd-05
 *   Ruling 4), which makes the Strawb tax hold 0.
 * - `payday_weekday`: the weekday pay arrives, every week, 0 (Sunday) to
 *   6 (Saturday) (prd-02 Ruling 9). Hannah's is Tuesday, 2.
 * - `personal_tax_owed_cents`: what Hannah owes Inland Revenue in personal
 *   income tax, typed in; no rate is applied (prd-02 Ruling 11).
 * - `currency`: the display symbol tweak from `handoff.md:78`.
 */
export const SETTINGS_DEFAULTS = {
  tax_rate_bp: 2500,
  profit_cents: 0,
  payday_weekday: 2,
  personal_tax_owed_cents: 0,
  currency: '$',
} as const

export type SettingKey = keyof typeof SETTINGS_DEFAULTS

/** Which stored key each `SettingsResponse` field is read from. */
export const SETTING_KEYS = {
  taxRateBasisPoints: 'tax_rate_bp',
  profitCents: 'profit_cents',
  paydayWeekday: 'payday_weekday',
  personalTaxOwedCents: 'personal_tax_owed_cents',
  currency: 'currency',
} as const satisfies Record<keyof SettingsResponse, SettingKey>

export type CurrencySymbol = '$' | 'NZ$' | '£'

/** GET /api/v1/settings */
export interface SettingsResponse {
  taxRateBasisPoints: number
  profitCents: Cents
  /** 0 = Sunday … 6 = Saturday (prd-02 Ruling 9). */
  paydayWeekday: number
  personalTaxOwedCents: Cents
  currency: CurrencySymbol
}

/** PATCH /api/v1/settings: any subset; omitted keys are unchanged. */
export type UpdateSettingsRequest = Partial<SettingsResponse>

/**
 * Every `CurrencySymbol`, for validating a stored or sent value and for the
 * settings panel's choices. `shared/__tests__/settings-lists.test.ts` fails
 * if the type and this list drift apart.
 */
export const CURRENCY_SYMBOLS: readonly CurrencySymbol[] = ['$', 'NZ$', '£']

/**
 * Every `AccountRole`, for validating a sent role and for the settings
 * panel's choices; the same values the migration constrains
 * `account_settings.role` to. `shared/__tests__/settings-lists.test.ts`
 * fails if the type and this list drift apart.
 */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'current',
  'savings',
  'tax_pot',
  'credit_card',
]

/**
 * One account as the settings panel lists it: who owns it and what it is
 * for. A display name only, never an account number or a balance.
 */
export interface AccountSettingsRow {
  id: string
  name: string
  scope: RowScope
  /** null: no role, and not liquid. */
  role: AccountRole | null
}

/** GET /api/v1/settings/accounts */
export interface SettingsAccountsResponse {
  items: AccountSettingsRow[]
}

/**
 * PUT /api/v1/settings/accounts/:id. `null` removes the role (no role, not
 * liquid). Responds with the updated `AccountSettingsRow`. The scope is not
 * editable here.
 */
export interface SetAccountRoleRequest {
  role: AccountRole | null
}

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
 *
 * Each scope holds its own tax against its own pot (prd-02 Ruling 11), so
 * the tax parts come per scope. A part for a scope not in view is 0: in
 * Personal every `strawb…` field is 0, in Strawb every `personal…` field.
 */
export interface SafeToSpendResult {
  scope: Scope
  today: IsoDate
  /** The most recent payday weekday on or before `today` (prd-02 Ruling 9). */
  lastPayday: IsoDate
  /** Seven days after `lastPayday`. */
  nextPayday: IsoDate
  liquidCents: Cents
  /**
   * The unpaid bills subtracted from liquid: in-scope bills not paid and due
   * on or before `nextPayday`, less `strawbBillsBufferCents`, the part the
   * Strawb tax pot pays (prd-02 Ruling 12).
   */
  unpaidBillsCents: Cents
  remainingBudgetCents: Cents
  /** `taxRate × profit`, rounded up, before netting the Strawb tax pot. */
  strawbTaxOwedCents: Cents
  /** Balance of the Strawb-scope `tax_pot` accounts. */
  strawbTaxPotCents: Cents
  /**
   * The part of the Strawb tax pot set aside for Strawb's unpaid bills:
   * `max(0, min(strawbTaxPotCents, Strawb unpaid bills))` (prd-02 Ruling 12).
   * It is not counted as tax set aside, and those bills are not subtracted
   * from liquid again. 0 when Strawb is not in view.
   */
  strawbBillsBufferCents: Cents
  /** `max(0, strawbTaxOwedCents − (strawbTaxPotCents − strawbBillsBufferCents))`. */
  strawbTaxHoldCents: Cents
  /** The `personal_tax_owed_cents` setting, before netting the personal pot. */
  personalTaxOwedCents: Cents
  /** Balance of the personal-scope `tax_pot` accounts. */
  personalTaxPotCents: Cents
  /** `max(0, personalTaxOwedCents − personalTaxPotCents)`. */
  personalTaxHoldCents: Cents
  /**
   * `strawbTaxHoldCents + personalTaxHoldCents`. One scope's surplus pot
   * never reduces the other's hold.
   */
  taxHoldCents: Cents
  /**
   * What is owed on the in-scope `credit_card` accounts: per card
   * `max(0, −balance)`, summed (prd-02 Ruling 10). A card in credit adds 0
   * and never offsets another card.
   */
  cardDebtCents: Cents
  safeCents: Cents
  /** `max(0, −safeCents)`. */
  shortByCents: Cents
  /** Whole days from `today` to `nextPayday`: 1 to 7, and 7 on payday. */
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
  /** A weekly amount: spend is counted from the last payday (prd-02 Ruling 9). */
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
 * One bill, resolved by the bills route to the occurrence that is due
 * (`dueDate`), with its `repeat` and anchor `firstDueDate`.
 */
export interface BillResponse {
  id: string
  scope: RowScope
  name: string
  amountCents: Cents
  /** The occurrence that is due. */
  dueDate: IsoDate
  /** How the bill repeats (#35 option C). */
  repeat: BillRepeat
  /** The anchor every occurrence is computed from. */
  firstDueDate: IsoDate
  /**
   * Only a one-off is ever paid: a repeating bill moves on to its next
   * unpaid occurrence (#35).
   */
  paid: boolean
  /** When "Mark paid" was pressed for this occurrence; null if unpaid. */
  paidAt: IsoTimestamp | null
  /** The account it is paid from, for the "Personal · BNZ" meta line. */
  accountName: string | null
}

/** GET /api/v1/bills?scope= */
export interface BillsResponse {
  items: BillResponse[]
  /**
   * Unpaid occurrences due on or before the next payday, gross: before the
   * Strawb tax-pot buffer, so it equals the hero's
   * `unpaidBillsCents + strawbBillsBufferCents`.
   */
  dueBeforePaydayCents: Cents
  /** The earliest unpaid bill in scope, overdue included; null when none. */
  nextBill: BillResponse | null
  /**
   * Sum of the amounts of payments whose paid-at instant falls in the current
   * Pacific/Auckland calendar month.
   */
  paidThisMonthCents: Cents
}

/** POST /api/v1/bills */
export interface CreateBillRequest {
  scope: RowScope
  name: string
  amountCents: Cents
  /** The anchor: on create, the date given is the first due date. */
  firstDueDate: IsoDate
  /** How the bill repeats (#35 option C). */
  repeat: BillRepeat
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

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** How often a subscription charges, from the gaps between its charges. */
export type SubscriptionCadence = 'weekly' | 'monthly' | 'yearly'

/**
 * Hannah's answer about a merchant (prd-02 Ruling 14). It wins over
 * detection both ways; no answer leaves detection and the name-hint
 * question to decide.
 */
export type SubscriptionAnswer = 'subscription' | 'not_subscription'

/**
 * `cancelled` once Hannah marks it cancelled, until a charge lands after
 * the cancel date; then `active` again.
 */
export type SubscriptionStatus = 'active' | 'cancelled'

/** A merchant in one scope, as its settled charges show it. */
export interface SubscriptionMerchant {
  /**
   * Opaque: send it back unchanged to mark, cancel or uncancel. One
   * merchant paid from both scopes is a separate merchant in each.
   */
  merchantKey: string
  scope: RowScope
  /** From the latest charge. */
  name: string
  chargeCount: number
  lastChargedOn: IsoDate
  /** The latest charge, as a positive amount. */
  amountCents: Cents
}

export interface SubscriptionRow extends SubscriptionMerchant {
  /** Null when Hannah marked it but its charges show no single cadence. */
  cadence: SubscriptionCadence | null
  /** Its charges alone make it a subscription. */
  detected: boolean
  /** Hannah said it is one. */
  marked: boolean
  status: SubscriptionStatus
  cancelledOn: IsoDate | null
  /** The first charge after `cancelledOn`, which makes it active again. */
  chargedAgainOn: IsoDate | null
  /** Null exactly when `cadence` is null. */
  perMonthCents: Cents | null
  perYearCents: Cents | null
}

/**
 * Over active rows with a cadence. Cancelled rows, questions and
 * not-a-subscription merchants are never in a total.
 */
export interface SubscriptionTotals {
  perMonthCents: Cents
  /** 12 × `perMonthCents`. */
  perYearCents: Cents
  /** Active rows summed. */
  countedCount: number
  /** Active rows left out because their cadence is null. */
  uncountedCount: number
}

/** GET /api/v1/subscriptions?scope= */
export interface SubscriptionsResponse {
  subscriptions: SubscriptionRow[]
  /** "Is this a subscription?": a name that looks like one, too few charges. */
  questions: SubscriptionMerchant[]
  /** Merchants Hannah said are not subscriptions, so she can undo it. */
  notSubscriptions: SubscriptionMerchant[]
  totals: SubscriptionTotals
}

/** PUT /api/v1/subscriptions/mark. A null answer clears hers. */
export interface MarkSubscriptionRequest {
  scope: RowScope
  merchantKey: string
  answer: SubscriptionAnswer | null
}

/**
 * POST /api/v1/subscriptions/cancel. Records the date only; nothing is sent
 * to the merchant or the bank. `on` defaults to today in NZ and may not be
 * in the future.
 */
export interface CancelSubscriptionRequest {
  scope: RowScope
  merchantKey: string
  on?: IsoDate
}

/** POST /api/v1/subscriptions/uncancel */
export interface UncancelSubscriptionRequest {
  scope: RowScope
  merchantKey: string
}

/** What is stored for the merchant after a write to the three above. */
export interface SubscriptionMarkResponse {
  scope: RowScope
  merchantKey: string
  answer: SubscriptionAnswer | null
  cancelledOn: IsoDate | null
}

import type { Account, SyncRun } from '../../models/sync.ts'
import type { Bill, BillRepeat } from '../../models/planning.ts'
import type { CategorySource } from '../../models/transactions.ts'
import {
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type AccountRole,
  type AccountSummary,
  type ActivityRow,
  type Alert,
  type AlertKind,
  type DismissAlertResponse,
  type IsoDate,
  type OverviewResponse,
  type RowScope,
  type SafeToSpendResult,
  type Scope,
  type TransactionStatus,
} from '../../shared/contracts.ts'
import {
  daysInMonth,
  lastPayday,
  nextPayday,
  safeToSpend,
  type SafeToSpendAccount,
  type SafeToSpendBill,
  type SafeToSpendBudget,
  type SafeToSpendTransaction,
} from '../../shared/safe-to-spend.ts'
import connection from './connection.ts'
import { listAccounts } from './synced.ts'

// The overview's data module (prd-02, issue #44): every read behind
// GET /api/v1/overview and the one write behind dismissing an alert.
//
// This module does no money arithmetic. Every figure it sends is either a
// stored value passed through (a balance, a bill's amount) or read off what
// `safeToSpend` in shared/safe-to-spend.ts returned (prd-02 Ruling 1). The
// only things computed here are calendar dates: today in Hannah's timezone,
// and which occurrences of a repeating bill are due.
//
// Inputs. `safeToSpend` is handed every stored Akahu account, bill
// occurrence, budget and window transaction, whatever the scope asked for;
// it applies the scope itself. A Xero row (prd-01 Ruling 9) is never read:
// prd-02 Ruling 4 keeps Xero receivables out of safe-to-spend.
//
// Bills (#35 option C, as ruled on #151, option A): every unpaid occurrence
// of a bill due on or before the next payday is its own input, overdue ones
// included, so a weekly bill two cycles behind holds back both weeks. A
// paid occurrence is one with a `bill_payments` row for its date.
//
// Nothing is defaulted silently. An absent setting takes its documented
// default (`SETTINGS_DEFAULTS`); a present one that is not a whole number is
// an error, never the default. An Akahu account with no balance is an
// error, never 0. Errors the client may see are `OverviewDataError`s with a
// fixed text; the shared module's RangeError and TypeError, whose messages
// name ids and values, are turned into one of those before leaving here.
//
// Alerts are derived on every read from the same result and occurrences;
// only a dismissal is stored (`alert_dismissals`). Each id is stable for
// the same condition and names its kind, so a budget and a bill that share
// a row id never collide:
//
// - `over_budget:<budgetId>:<lastPayday>`: a new week is a new alert.
// - `bill_overdue:<billId>:<dueDate>`: an unpaid occurrence before today.
// - `bill_due_soon:<billId>:<dueDate>`: an unpaid occurrence from today to
//   the next payday.

/**
 * A failure the route may name to the client. The message is one of a closed
 * set of constant texts, so no row id, stored value or SQL can reach a
 * response through it.
 */
export type OverviewDataErrorMessage =
  | 'safe-to-spend input invalid'
  | 'a stored setting is not valid'
  | 'an account has no balance'
  | 'a transaction is incomplete'
  | 'a bill has too many unpaid occurrences'

export class OverviewDataError extends Error {
  constructor(message: OverviewDataErrorMessage) {
    super(message)
    this.name = 'OverviewDataError'
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// Built once. `formatToParts` is read field by field rather than trusting a
// locale's string order.
const NZ_DATE = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The calendar date `at` falls on in Pacific/Auckland, as `YYYY-MM-DD`.
 * Safe-to-spend takes `today` in Hannah's timezone (shared/safe-to-spend.ts),
 * and a transaction's date is read the same way, so a purchase at 9am NZ on
 * a Tuesday is Tuesday's spend even though it is Monday in UTC.
 */
export function nzCalendarDate(at: Date): IsoDate {
  if (Number.isNaN(at.getTime())) {
    throw new OverviewDataError('a transaction is incomplete')
  }
  let year = ''
  let month = ''
  let day = ''
  for (const part of NZ_DATE.formatToParts(at)) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year.padStart(4, '0')}-${month}-${day}`
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

interface CivilDate {
  year: number
  month: number // 1 to 12
  day: number
}

function parseIsoDate(value: IsoDate): CivilDate {
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
  // The value is not echoed: the route turns this into a fixed text.
  throw new RangeError('a bill date is not a YYYY-MM-DD calendar date')
}

function formatIsoDate({ year, month, day }: CivilDate): IsoDate {
  if (year < 0 || year > 9999) {
    throw new RangeError('a bill date falls outside the years 0000 to 9999')
  }
  const yyyy = String(year).padStart(4, '0')
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * `date` moved by `days` calendar days. Built with `setUTCFullYear`, as
 * shared/safe-to-spend.ts does, never `Date.UTC`, which reads the years 0 to
 * 99 as 1900 to 1999.
 */
function addDaysIso(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date)
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day + days)
  return formatIsoDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  })
}

/**
 * The anchor moved by `months` whole months, keeping the anchor's day of
 * month clamped to the end of a shorter month: the 31st falls on the 30th,
 * 29th or 28th, and on the 31st again the month after. 29 February moved by
 * twelve months falls on 28 February in a year that is not a leap year.
 */
function addMonthsClamped(anchor: CivilDate, months: number): IsoDate {
  const index = anchor.year * 12 + (anchor.month - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const day = Math.min(anchor.day, daysInMonth(year, month))
  return formatIsoDate({ year, month, day })
}

/**
 * Every occurrence of a bill from its anchor (`first_due_date`) up to and
 * including `through`, ascending (#35 option C). Each occurrence is computed
 * from the anchor, never from the previous occurrence, so nothing drifts:
 *
 * - `none`: the anchor alone, if it is not after `through`.
 * - `weekly`: anchor + 7n days.
 * - `monthly`: the anchor's day of month, clamped to the month's end.
 * - `yearly`: the anchor's month and day, clamped the same way.
 *
 * Paid occurrences are included; dropping them is the caller's job.
 */
export function billOccurrencesThrough(
  bill: Pick<Bill, 'repeat' | 'first_due_date'>,
  through: IsoDate,
): IsoDate[] {
  parseIsoDate(through)
  const anchorDate = parseIsoDate(bill.first_due_date)
  const anchor = formatIsoDate(anchorDate)
  const occurrences: IsoDate[] = []
  if (anchor > through) return occurrences
  if (bill.repeat === 'none') return [anchor]
  for (let n = 0; ; n += 1) {
    let next: IsoDate
    if (bill.repeat === 'weekly') next = addDaysIso(anchor, 7 * n)
    else if (bill.repeat === 'monthly') next = addMonthsClamped(anchorDate, n)
    else if (bill.repeat === 'yearly')
      next = addMonthsClamped(anchorDate, 12 * n)
    else throw new RangeError('a bill has an unknown repeat')
    // ISO dates compare correctly as strings.
    if (next > through) return occurrences
    occurrences.push(next)
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** How many rows the overview's recent activity list shows. */
export const RECENT_ACTIVITY_LIMIT = 10

// A bill with more unpaid occurrences than this is refused rather than
// truncated: a truncated list would be a fake number.
const MAX_UNPAID_OCCURRENCES = 1000

type Db = typeof connection

/**
 * Runs a call into shared date or money code, turning its RangeError or
 * TypeError (whose messages name ids and values) into the fixed text.
 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new OverviewDataError('safe-to-spend input invalid')
    }
    throw err
  }
}

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

const WHOLE_NUMBER = /^-?\d+$/

/**
 * The settings safe-to-spend needs. Several rows may hold one key (the
 * table has no uniqueness on it and a `user_id` Divvy no longer has); the
 * one with the newest `updated_at` wins, then the higher `id` (a text
 * column, so compared as text). An absent key takes its default; a present
 * one must be a whole number. Range is left to the shared module.
 */
async function readSettings(db: Db): Promise<Settings> {
  const rows: { key: string; value: unknown }[] = await db('settings')
    .select('key', 'value')
    .whereIn(
      'key',
      NUMERIC_SETTINGS.map((field) => SETTING_KEYS[field]),
    )
    .orderBy([
      { column: 'key' },
      { column: 'updated_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
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
    // A NULL value is a row that is present and says nothing usable.
    if (typeof value !== 'string' || !WHOLE_NUMBER.test(value)) {
      throw new OverviewDataError('a stored setting is not valid')
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      throw new OverviewDataError('a stored setting is not valid')
    }
    settings[field] = parsed
  }
  return settings
}

/** One unpaid occurrence of a bill, as the alerts need it. */
interface BillOccurrence {
  billId: number
  name: string
  scope: RowScope
  amountCents: number
  dueDate: IsoDate
}

interface BillRow {
  id: number
  scope: RowScope
  name: string
  amount_cents: number
  repeat: BillRepeat
  first_due_date: IsoDate
}

interface WindowTransactionRow {
  account_id: string | null
  date: string | null
  amount_cents: number | null
  category: string | null
  status: TransactionStatus
}

interface Inputs {
  today: IsoDate
  settings: Settings
  /** Every stored Akahu account, in id order. */
  accountRows: Account[]
  /** The same accounts as cards, picked field by field, never spread. */
  cards: AccountSummary[]
  accounts: SafeToSpendAccount[]
  bills: SafeToSpendBill[]
  occurrences: BillOccurrence[]
  budgets: SafeToSpendBudget[]
  transactions: SafeToSpendTransaction[]
}

async function loadInputs(now: Date, db: Db): Promise<Inputs> {
  const today = nzCalendarDate(now)
  const settings = await readSettings(db)
  const last = guard(() => lastPayday(today, settings.paydayWeekday))
  const next = guard(() => nextPayday(today, settings.paydayWeekday))

  // Accounts and their roles. No role row means no role.
  const accountRows = await listAccounts(db)
  const roleRows: { account_id: number; role: AccountRole }[] = await db(
    'account_settings',
  ).select('account_id', 'role')
  const accountRoles = new Map(roleRows.map((r) => [r.account_id, r.role]))
  const accounts: SafeToSpendAccount[] = []
  const cards: AccountSummary[] = []
  for (const row of accountRows) {
    // Sync always writes a balance; a missing one is not fabricated as 0.
    if (row.balance_cents === null) {
      throw new OverviewDataError('an account has no balance')
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
  const billRows: BillRow[] = await db('bills')
    .select('id', 'scope', 'name', 'amount_cents', 'repeat', 'first_due_date')
    .orderBy('id')
  const paymentRows: { bill_id: number; due_date: IsoDate }[] = await db(
    'bill_payments',
  ).select('bill_id', 'due_date')
  const paid = new Set(paymentRows.map((p) => `${p.bill_id}|${p.due_date}`))
  const bills: SafeToSpendBill[] = []
  const occurrences: BillOccurrence[] = []
  for (const bill of billRows) {
    const unpaid = guard(() => billOccurrencesThrough(bill, next)).filter(
      (dueDate) => !paid.has(`${bill.id}|${dueDate}`),
    )
    if (unpaid.length > MAX_UNPAID_OCCURRENCES) {
      throw new OverviewDataError('a bill has too many unpaid occurrences')
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

  const budgetRows: {
    id: number
    scope: RowScope
    category: string
    limit_cents: number
  }[] = await db('budgets')
    .select('id', 'scope', 'category', 'limit_cents')
    .orderBy('id')
  const budgets: SafeToSpendBudget[] = budgetRows.map((row) => ({
    id: String(row.id),
    scope: row.scope,
    category: row.category,
    limitCents: row.limit_cents,
  }))

  // The window: Akahu rows from the day before the last payday. Stored
  // dates are UTC instants and NZ is ahead of UTC, so a row on the NZ
  // payday is never dated earlier than the day before it in UTC; the
  // shared module drops whatever falls before the payday once the NZ date
  // is known. A row with no date is read too, so it is refused rather than
  // silently left out of spent.
  const windowStart = guard(() => addDaysIso(last, -1))
  const windowRows: WindowTransactionRow[] = await db('transactions')
    .select('account_id', 'date', 'amount_cents', 'category', 'status')
    .where({ source: 'akahu' })
    .where((q) => q.where('date', '>=', windowStart).orWhereNull('date'))
  const accountIdByAkahuId = new Map<string, string>()
  for (const row of accountRows) {
    if (row.akahu_id !== null)
      accountIdByAkahuId.set(row.akahu_id, String(row.id))
  }
  const transactions: SafeToSpendTransaction[] = []
  for (const row of windowRows) {
    // A row on an account that is not stored has no scope to count in.
    const accountId =
      row.account_id === null
        ? undefined
        : accountIdByAkahuId.get(row.account_id)
    if (accountId === undefined) continue
    if (row.date === null || row.amount_cents === null) {
      throw new OverviewDataError('a transaction is incomplete')
    }
    transactions.push({
      accountId,
      date: nzCalendarDate(new Date(row.date)),
      amountCents: row.amount_cents,
      category: row.category,
      status: row.status,
    })
  }

  return {
    today,
    settings,
    accountRows,
    cards,
    accounts,
    bills,
    occurrences,
    budgets,
    transactions,
  }
}

function computeSafeToSpend(scope: Scope, inputs: Inputs): SafeToSpendResult {
  return guard(() =>
    safeToSpend({
      scope,
      today: inputs.today,
      paydayWeekday: inputs.settings.paydayWeekday,
      taxRateBasisPoints: inputs.settings.taxRateBasisPoints,
      profitCents: inputs.settings.profitCents,
      personalTaxOwedCents: inputs.settings.personalTaxOwedCents,
      accounts: inputs.accounts,
      bills: inputs.bills,
      budgets: inputs.budgets,
      transactions: inputs.transactions,
    }),
  )
}

const KIND_ORDER: Record<AlertKind, number> = {
  over_budget: 0,
  bill_overdue: 1,
  bill_due_soon: 2,
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The alerts for a safe-to-spend result, before dismissals: a budget line
 * the result says is over, and every unpaid bill occurrence in the result's
 * scope that is overdue or due by the next payday. Ordered by kind, then
 * due date, then id.
 */
function deriveAlerts(
  result: SafeToSpendResult,
  occurrences: readonly BillOccurrence[],
): Alert[] {
  const alerts: Alert[] = []
  // `result.budgets` is already scoped by the shared module.
  for (const line of result.budgets) {
    if (line.overCents <= 0) continue
    alerts.push({
      id: `over_budget:${line.id}:${result.lastPayday}`,
      kind: 'over_budget',
      scope: line.scope,
      subject: line.category,
      amountCents: line.overCents,
      dueDate: null,
    })
  }
  for (const o of occurrences) {
    if (result.scope !== 'all' && o.scope !== result.scope) continue
    let kind: AlertKind
    if (o.dueDate < result.today) kind = 'bill_overdue'
    else if (o.dueDate <= result.nextPayday) kind = 'bill_due_soon'
    else continue
    alerts.push({
      id: `${kind}:${o.billId}:${o.dueDate}`,
      kind,
      scope: o.scope,
      subject: o.name,
      amountCents: o.amountCents,
      dueDate: o.dueDate,
    })
  }
  return alerts.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      compareText(a.dueDate ?? '', b.dueDate ?? '') ||
      compareText(a.id, b.id),
  )
}

interface ActivityQueryRow {
  id: number
  account_id: string
  date: string | null
  description: string | null
  amount_cents: number | null
  status: TransactionStatus
  category: string | null
  category_source: CategorySource
}

/**
 * The overview for one scope: the safe-to-spend result exactly as the
 * shared module returned it, the in-scope accounts, the undismissed alerts,
 * the newest in-scope activity and when sync last succeeded. Reads only.
 */
export async function readOverview(
  scope: Scope,
  now: Date = new Date(),
  db = connection,
): Promise<OverviewResponse> {
  const inputs = await loadInputs(now, db)
  const result = computeSafeToSpend(scope, inputs)

  const derived = deriveAlerts(result, inputs.occurrences)
  const dismissedRows: { alert_id: string }[] = await db('alert_dismissals')
    .select('alert_id')
    .whereIn(
      'alert_id',
      derived.map((a) => a.id),
    )
  const dismissed = new Set(dismissedRows.map((r) => r.alert_id))
  const alerts = derived.filter((a) => !dismissed.has(a.id))

  const inScope = inputs.accountRows.filter(
    (row) => scope === 'all' || row.scope === scope,
  )
  const accounts = inputs.cards.filter(
    (card) => scope === 'all' || card.scope === scope,
  )

  const byAkahuId = new Map<string, Account>()
  for (const row of inScope) {
    if (row.akahu_id !== null) byAkahuId.set(row.akahu_id, row)
  }
  const activityRows: ActivityQueryRow[] = await db('transactions')
    .select(
      'id',
      'account_id',
      'date',
      'description',
      'amount_cents',
      'status',
      'category',
      'category_source',
    )
    .where({ source: 'akahu' })
    .whereIn('account_id', [...byAkahuId.keys()])
    .orderBy([
      { column: 'date', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .limit(RECENT_ACTIVITY_LIMIT)
  const recentActivity: ActivityRow[] = activityRows.map((row) => {
    const account = byAkahuId.get(row.account_id)
    if (
      account === undefined ||
      row.date === null ||
      row.amount_cents === null
    ) {
      throw new OverviewDataError('a transaction is incomplete')
    }
    return {
      // The row id, pending or settled; `status` says which. A pending
      // row's id changes on every sync (prd-01 Ruling 1).
      id: String(row.id),
      date: nzCalendarDate(new Date(row.date)),
      description: row.description ?? '',
      amountCents: row.amount_cents,
      scope: account.scope,
      accountName: account.name,
      status: row.status,
      category: row.category,
      categorySource: row.category_source,
    }
  })

  // A copy of `lastSuccessAt` in server/routes/sync.ts GET /status; change
  // together with it. Only a started_at in the exact toISOString() form is
  // ranked, by julianday(), so a malformed one never shows as the latest.
  const lastSuccess: Pick<SyncRun, 'finished_at'> | undefined = await db(
    'sync_runs',
  )
    .where({ outcome: 'success' })
    .whereRaw("strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at")
    .orderByRaw('julianday(started_at) DESC')
    .orderBy('id', 'desc')
    .first('finished_at')

  return {
    safeToSpend: result,
    accounts,
    alerts,
    recentActivity,
    dataAsOf: lastSuccess?.finished_at ?? null,
  }
}

/**
 * Dismisses an alert that is currently derived, in any scope. Answers null,
 * writing nothing, when no such alert exists now. Dismissing again keeps the
 * first dismissal's time.
 */
export async function dismissAlert(
  alertId: string,
  now: Date = new Date(),
  db = connection,
): Promise<DismissAlertResponse | null> {
  const inputs = await loadInputs(now, db)
  // `all` covers every alert either scope can show.
  const result = computeSafeToSpend('all', inputs)
  const derived = deriveAlerts(result, inputs.occurrences)
  if (!derived.some((a) => a.id === alertId)) return null

  await db('alert_dismissals')
    .insert({ alert_id: alertId, dismissed_at: now.toISOString() })
    .onConflict('alert_id')
    .ignore()
  const stored: { dismissed_at: string } | undefined = await db(
    'alert_dismissals',
  )
    .where({ alert_id: alertId })
    .first('dismissed_at')
  if (stored === undefined) {
    throw new Error('a dismissal was not stored')
  }
  return { id: alertId, dismissedAt: stored.dismissed_at }
}

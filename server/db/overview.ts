import type { Account, SyncRun } from '../../models/sync.ts'
import type { BillRepeat } from '../../models/planning.ts'
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
  lastPayday,
  nextPayday,
  safeToSpend,
  type SafeToSpendAccount,
  type SafeToSpendBill,
  type SafeToSpendBudget,
  type SafeToSpendTransaction,
} from '../../shared/safe-to-spend.ts'
import { effectiveCategory } from '../../shared/drawings.ts'
import {
  MAX_UNPAID_OCCURRENCES,
  addDaysIso,
  billOccurrencesThrough,
  nzCalendarDate as sharedNzCalendarDate,
} from '../../shared/nz-dates.ts'
import connection from './connection.ts'
import { loadDrawingIds } from './drawings.ts'
import { listAccounts } from './synced.ts'

// The overview's data module (prd-02, issue #44): every read behind
// GET /api/v1/overview and the one write behind dismissing an alert.
//
// This module does no money arithmetic. Every figure it sends is either a
// stored value passed through (a balance, a bill's amount) or read off what
// `safeToSpend` in shared/safe-to-spend.ts returned (prd-02 Ruling 1).
// Calendar dates are not computed here either: today in Hannah's timezone,
// which occurrences of a repeating bill are due, and the limit on unpaid
// ones come from shared/nz-dates.ts, the module the Bills screen reads too.
//
// Inputs. `safeToSpend` is handed every stored Akahu account, bill
// occurrence, budget and window transaction, whatever the scope asked for;
// it applies the scope itself. A Xero row (prd-01 Ruling 9) is never read:
// prd-02 Ruling 4 keeps Xero receivables out of safe-to-spend.
//
// Categories are effective ones with drawings laid over them (prd-02 Ruling
// 15): the drawing ids are loaded once per read (server/db/drawings.ts) and
// a half of a drawing that Hannah has not categorised by hand is handed to
// `safeToSpend` and shown in the activity as Drawings, set by `rule`, which
// the shared module never counts as spent.
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

// Stays exported because ./goals.ts and ./subscriptions.ts (and an open
// PR's spending.ts) import it from here, and ./goals.ts catches its
// OverviewDataError. #322 retires this wrapper.
/**
 * The calendar date `at` falls on in Pacific/Auckland (shared/nz-dates.ts),
 * with the shared module's RangeError for an invalid Date turned into the
 * fixed text `a transaction is incomplete`. Every call here goes through it,
 * so nothing this module returns changed when the date code moved to
 * shared/.
 */
export function nzCalendarDate(at: Date): IsoDate {
  try {
    return sharedNzCalendarDate(at)
  } catch (err) {
    if (err instanceof RangeError) {
      throw new OverviewDataError('a transaction is incomplete')
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** How many rows the overview's recent activity list shows. */
export const RECENT_ACTIVITY_LIMIT = 10

type Db = typeof connection

/**
 * Runs a call into shared date or money code, turning its RangeError or
 * TypeError (whose messages name ids and values) into the fixed text.
 * Copied as `guard` in ./bills.ts and ./goals.ts; change all together.
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

/**
 * The drawing ids, with the shared matcher's RangeError or TypeError (whose
 * messages name ids and values) turned into the fixed text.
 */
async function loadDrawings(db: Db): Promise<Set<number>> {
  try {
    return await loadDrawingIds(db)
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
 * The settings safe-to-spend needs. `settings` has a UNIQUE `key`
 * (migration 20261025150000, #46), so a key has at most one row; the query's
 * ordering (newest `updated_at`, then higher integer `id`) picks between rows
 * only on a table without that constraint, and is kept as a guard. An absent
 * key takes its default; a present one must be a whole number. Range is left
 * to the shared module.
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
    // `value` is NOT NULL (#46), so the type test is a guard; the whole-number
    // test is live, since stored text such as a blank or a decimal reaches it.
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
  id: number
  account_id: string | null
  date: string | null
  amount_cents: number | null
  category: string | null
  category_source: CategorySource
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
  /** Both halves of every drawing (prd-02 Ruling 15), loaded once per read. */
  drawingIds: Set<number>
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
    .select(
      'id',
      'account_id',
      'date',
      'amount_cents',
      'category',
      'category_source',
      'status',
    )
    .where({ source: 'akahu' })
    .where((q) => q.where('date', '>=', windowStart).orWhereNull('date'))
  const accountIdByAkahuId = new Map<string, string>()
  for (const row of accountRows) {
    if (row.akahu_id !== null)
      accountIdByAkahuId.set(row.akahu_id, String(row.id))
  }
  const drawingIds = await loadDrawings(db)
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
      category: effectiveCategory(
        { category: row.category, categorySource: row.category_source },
        drawingIds.has(row.id),
      ).category,
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
    drawingIds,
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

// Subjects are names a person reads, so they sort as words in a fixed
// locale ("power" beside "Power", not after every capital), never by the
// server's default locale.
const SUBJECT_ORDER = new Intl.Collator('en')

/**
 * The alerts for a safe-to-spend result, before dismissals: a budget line
 * the result says is over, and every unpaid bill occurrence in the result's
 * scope that is overdue or due by the next payday. Ordered by kind, then
 * due date, then subject (the bill's name or the budget's category), then
 * id, so the order is fixed. The id is never the visible tie-break: as text
 * it would put bill 10 before bill 9.
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
      SUBJECT_ORDER.compare(a.subject, b.subject) ||
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
    const shown = effectiveCategory(
      { category: row.category, categorySource: row.category_source },
      inputs.drawingIds.has(row.id),
    )
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
      category: shown.category,
      categorySource: shown.categorySource,
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

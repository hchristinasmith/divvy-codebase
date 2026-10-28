import type { Account, SyncRun } from '../../models/sync.ts'
import type { CategorySource } from '../../models/transactions.ts'
import type {
  ActivityRow,
  Alert,
  AlertKind,
  DismissAlertResponse,
  IsoDate,
  OverviewResponse,
  SafeToSpendResult,
  Scope,
  TransactionStatus,
} from '../../shared/contracts.ts'
import { safeToSpend } from '../../shared/safe-to-spend.ts'
import {
  SAFE_TO_SPEND_SETTING_KEYS,
  SafeToSpendInputError,
  gatherSafeToSpendInputs,
  safeToSpendWindowStart,
  type BillOccurrence,
  type GatheredSafeToSpendInputs,
  type InputAccountRoleRow,
  type InputBillPaymentRow,
  type InputBillRow,
  type InputBudgetRow,
  type InputSettingRow,
  type InputTransactionRow,
  type LeftOutBill,
} from '../../shared/safe-to-spend-inputs.ts'
import { effectiveCategory } from '../../shared/drawings.ts'
import { nzCalendarDate as sharedNzCalendarDate } from '../../shared/nz-dates.ts'
import connection from './connection.ts'
import { loadDrawingCandidates } from './drawings.ts'
import { listAccounts } from './synced.ts'
import { rankByStartedAt } from '../sync/ranked-runs.ts'

// The overview's data module (prd-02, issue #44): every read behind
// GET /api/v1/overview and the one write behind dismissing an alert.
//
// This module does no money arithmetic. Every figure it sends is either a
// stored value passed through (a balance, a bill's amount) or read off what
// `safeToSpend` in shared/safe-to-spend.ts returned (prd-02 Ruling 1).
// Calendar dates are not computed here either: they come from
// shared/nz-dates.ts, the module the Bills screen reads too.
//
// Inputs. This module loads the rows; `gatherSafeToSpendInputs` in
// shared/safe-to-spend-inputs.ts turns them into `safeToSpend`'s inputs
// (#472), so prd-03's `get_safe_to_spend`, which may import only shared/
// (prd-03 Ruling 6), feeds it from the same code. That module's header
// says what each row becomes: setting defaults and whole-number checks,
// account roles, every unpaid bill occurrence through the next payday and
// the limit on unpaid ones (#151, #247), the transaction window, NZ dates
// and the drawings overlay (prd-02 Ruling 15). `safeToSpend` is handed
// every stored Akahu account, bill occurrence, budget and window
// transaction, whatever the scope asked for; it applies the scope itself.
// A Xero row (prd-01 Ruling 9) is never read: prd-02 Ruling 4 keeps Xero
// receivables out of safe-to-spend.
//
// The activity list lays the same drawing ids over its rows: a half of a
// drawing that Hannah has not categorised by hand shows as Drawings, set
// by `rule`.
//
// Nothing is defaulted silently. Errors the client may see are
// `OverviewDataError`s with a fixed text: the gathering's
// `SafeToSpendInputError` leaves here with its own text, one of the same
// closed set, and the shared module's RangeError and TypeError, whose
// messages name ids and values, are turned into one of those texts.
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
// - `bill_too_many_unpaid:<billId>:<lastPayday>`: a bill past the
//   unpaid-occurrence limit, left out of the totals (#247). Like
//   over_budget, a dismissal lasts one pay period.

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
 * Copied as `guard` in ./bills.ts, ./goals.ts and
 * shared/safe-to-spend-inputs.ts; change all together.
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
 * Runs the shared gathering, its fixed-text error leaving as an
 * `OverviewDataError` with the same text.
 */
function gathered<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof SafeToSpendInputError) {
      throw new OverviewDataError(err.reason)
    }
    throw err
  }
}

interface Inputs extends GatheredSafeToSpendInputs {
  /** Every stored Akahu account, in id order. */
  accountRows: Account[]
}

/**
 * Loads the rows safe-to-spend reads and gathers them in the shared module.
 * The window's start depends on the payday setting, so the settings load
 * and are checked first; a bad setting is refused before anything else is
 * read.
 */
async function loadInputs(now: Date, db: Db): Promise<Inputs> {
  // `settings` has a UNIQUE `key` (migration 20261025150000, #46), so a key
  // has at most one row; the ordering (newest `updated_at`, then higher
  // integer `id`) picks between rows only on a table without that
  // constraint, and is kept as a guard. The first row per key wins.
  const settings: InputSettingRow[] = await db('settings')
    .select('key', 'value')
    .whereIn('key', [...SAFE_TO_SPEND_SETTING_KEYS])
    .orderBy([
      { column: 'key' },
      { column: 'updated_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
  const windowStart = gathered(() => safeToSpendWindowStart(settings, now))

  const accountRows = await listAccounts(db)
  const accountRoles: InputAccountRoleRow[] = await db(
    'account_settings',
  ).select('account_id', 'role')
  const bills: InputBillRow[] = await db('bills')
    .select('id', 'scope', 'name', 'amount_cents', 'repeat', 'first_due_date')
    .orderBy('id')
  const billPayments: InputBillPaymentRow[] = await db('bill_payments').select(
    'bill_id',
    'due_date',
  )
  const budgets: InputBudgetRow[] = await db('budgets')
    .select('id', 'scope', 'category', 'limit_cents')
    .orderBy('id')
  // The window: Akahu rows from `windowStart`, and every row with no date.
  const windowTransactions: InputTransactionRow[] = await db('transactions')
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
  const drawingCandidates = await loadDrawingCandidates(db)

  const inputs = gathered(() =>
    gatherSafeToSpendInputs(
      {
        accounts: accountRows,
        accountRoles,
        settings,
        bills,
        billPayments,
        budgets,
        windowTransactions,
        drawingCandidates,
      },
      now,
    ),
  )
  return { ...inputs, accountRows }
}

function computeSafeToSpend(scope: Scope, inputs: Inputs): SafeToSpendResult {
  return guard(() =>
    safeToSpend({
      scope,
      today: inputs.today,
      paydayWeekday: inputs.paydayWeekday,
      taxRateBasisPoints: inputs.taxRateBasisPoints,
      profitCents: inputs.profitCents,
      personalTaxOwedCents: inputs.personalTaxOwedCents,
      accounts: inputs.accounts,
      bills: inputs.bills,
      budgets: inputs.budgets,
      transactions: inputs.transactions,
    }),
  )
}

// A left-out bill comes first: it means the totals are missing a bill.
const KIND_ORDER: Record<AlertKind, number> = {
  bill_too_many_unpaid: 0,
  over_budget: 1,
  bill_overdue: 2,
  bill_due_soon: 3,
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Subjects are names a person reads, so they sort as words in a fixed
// locale ("power" beside "Power", not after every capital), never by the
// server's default locale.
const SUBJECT_ORDER = new Intl.Collator('en')

/**
 * The alerts for a safe-to-spend result, before dismissals: a bill in the
 * result's scope left out for too many unpaid occurrences, a budget line
 * the result says is over, and every unpaid bill occurrence in the result's
 * scope that is overdue or due by the next payday. Ordered by kind, then
 * due date, then subject (the bill's name or the budget's category), then
 * id, so the order is fixed. The id is never the visible tie-break: as text
 * it would put bill 10 before bill 9.
 */
function deriveAlerts(
  result: SafeToSpendResult,
  occurrences: readonly BillOccurrence[],
  leftOutBills: readonly LeftOutBill[],
): Alert[] {
  const alerts: Alert[] = []
  for (const bill of leftOutBills) {
    if (result.scope !== 'all' && bill.scope !== result.scope) continue
    alerts.push({
      id: `bill_too_many_unpaid:${bill.id}:${result.lastPayday}`,
      kind: 'bill_too_many_unpaid',
      scope: bill.scope,
      subject: bill.name,
      amountCents: bill.amount_cents,
      dueDate: null,
    })
  }
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

  const derived = deriveAlerts(result, inputs.occurrences, inputs.leftOutBills)
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

  // dataAsOf is the finish time of the latest ranked success (rankByStartedAt).
  const lastSuccess: Pick<SyncRun, 'finished_at'> | undefined =
    await rankByStartedAt(db('sync_runs').where({ outcome: 'success' })).first(
      'finished_at',
    )

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
  const derived = deriveAlerts(result, inputs.occurrences, inputs.leftOutBills)
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

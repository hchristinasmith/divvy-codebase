import type { Knex } from 'knex'

import type {
  AccountRole,
  HabitsResponse,
  IsoDate,
  IsoTimestamp,
  Scope,
  TransactionStatus,
  Verdict,
  VerdictRow,
} from '../../shared/contracts.ts'
import {
  habitStreaks,
  habitsReadFrom,
  recentSpendingIds,
  runwayTenths,
  type HabitAccount,
  type HabitTransaction,
  type HabitsInput,
} from '../../shared/habits.ts'
import connection from './connection.ts'
import { OverviewDataError, nzCalendarDate } from './overview.ts'
import { listAccounts } from './synced.ts'

// The habits data module (prd-02, issue #52): the read behind
// GET /api/v1/habits and the write behind
// PUT /api/v1/habits/verdicts/:transactionId.
//
// This module does no money arithmetic and defines no streak. It loads
// rows, turns each transaction's instant into Hannah's NZ calendar date,
// and hands them to shared/habits.ts, whose runway, streaks and verdict
// list it sends unchanged. There is deliberately no freedom date (prd-02,
// open question): the response has the three contract keys only.
//
// Rows read are Akahu rows whose `account_id` names a stored Akahu
// account, by an inner join, so a row no scope can see is never read,
// listed or tagged. A Xero row is never read (prd-05 is M4). Read are:
// every row from `habitsReadFrom(today)` (less a day, for the UTC instant
// of an NZ date) on every account, since All pairs transfers across scopes,
// and every settled row of a `current` account, for the overdraft streak.
// A row in that read with no date or amount is an error, never skipped.
//
// Writes go to `habit_verdicts` only (20261025180000_prd02_habit_verdicts.js),
// one row per transaction, inside one database transaction with the checks
// that allow them: the row is an Akahu row on a stored account, settled,
// and money out. Clearing deletes the row.
//
// Errors the client may see are `HabitsDataError`s with a fixed text; the
// shared module's RangeError and TypeError, whose messages name values, and
// `OverviewDataError` from `nzCalendarDate`, are turned into one of those.

/**
 * A `habit_verdicts` row. It lives here rather than in `models/` because
 * nothing else reads the table.
 */
export interface HabitVerdictRow {
  id: number
  transaction_id: number
  verdict: Verdict
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

/**
 * A failure the route may name to the client: one of a closed set of
 * constant texts, so no id, stored value or SQL reaches a response.
 */
export type HabitsDataErrorMessage =
  | 'a transaction is incomplete'
  | 'an account has no balance'
  | 'habits input invalid'

export class HabitsDataError extends Error {
  constructor(message: HabitsDataErrorMessage) {
    super(message)
    this.name = 'HabitsDataError'
  }
}

type Db = typeof connection

/**
 * Runs a call into shared date or money code, turning its RangeError or
 * TypeError (whose messages name values), or an `OverviewDataError` from a
 * function borrowed from ./overview.ts, into the fixed text. A copy of
 * `guard` in ./bills.ts and ./overview.ts; change all together.
 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (
      err instanceof RangeError ||
      err instanceof TypeError ||
      err instanceof OverviewDataError
    ) {
      throw new HabitsDataError('habits input invalid')
    }
    throw err
  }
}

function nzDate(instant: string | null): IsoDate {
  if (instant === null) throw new HabitsDataError('a transaction is incomplete')
  try {
    return nzCalendarDate(new Date(instant))
  } catch {
    throw new HabitsDataError('a transaction is incomplete')
  }
}

/** The UTC date string a stored instant on NZ date `from` is never before. */
function utcDayBefore(from: IsoDate): string {
  return new Date(Date.parse(`${from}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface HabitQueryRow {
  id: number
  account_id: number
  date: string | null
  amount_cents: number | null
  status: TransactionStatus
  balance_cents: number | null
}

interface VerdictQueryRow {
  id: number
  date: string | null
  merchant_name: string | null
  description: string | null
  category: string | null
  amount_cents: number | null
  verdict: Verdict | null
}

/**
 * Transactions joined to the stored Akahu account they belong to. The
 * inner join is what keeps a row on an unmapped `account_id` out of every
 * read and write here.
 */
function onStoredAccounts(db: Knex) {
  return db('transactions')
    .join('accounts', 'transactions.account_id', 'accounts.akahu_id')
    .where('transactions.source', 'akahu')
    .where('accounts.source', 'akahu')
}

async function loadAccounts(db: Db): Promise<HabitAccount[]> {
  // A copy of the role load in `loadInputs` (./overview.ts); change
  // together. No role row means no role.
  const accountRows = await listAccounts(db)
  const roleRows: { account_id: number; role: AccountRole }[] = await db(
    'account_settings',
  ).select('account_id', 'role')
  const accountRoles = new Map(roleRows.map((r) => [r.account_id, r.role]))
  return accountRows.map((row) => {
    // Sync always writes a balance; a missing one is not fabricated as 0.
    if (row.balance_cents === null) {
      throw new HabitsDataError('an account has no balance')
    }
    return {
      id: String(row.id),
      scope: row.scope,
      role: accountRoles.get(row.id) ?? null,
      balanceCents: row.balance_cents,
    }
  })
}

async function loadTransactions(
  today: IsoDate,
  currentAccountIds: readonly number[],
  db: Db,
): Promise<HabitTransaction[]> {
  const from = utcDayBefore(guard(() => habitsReadFrom(today)))
  const rows: HabitQueryRow[] = await onStoredAccounts(db)
    .select(
      'transactions.id as id',
      'accounts.id as account_id',
      'transactions.date as date',
      'transactions.amount_cents as amount_cents',
      'transactions.status as status',
      'transactions.balance_cents as balance_cents',
    )
    .where((q) =>
      q
        .where('transactions.date', '>=', from)
        .orWhereNull('transactions.date')
        .orWhere((older) =>
          older
            .where('transactions.status', 'settled')
            .whereIn('accounts.id', [...currentAccountIds]),
        ),
    )
    .orderBy('transactions.id', 'asc')
  return rows.map((row) => {
    if (row.amount_cents === null)
      throw new HabitsDataError('a transaction is incomplete')
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      date: nzDate(row.date),
      amountCents: row.amount_cents,
      status: row.status,
      balanceCents: row.balance_cents,
    }
  })
}

function toVerdictRow(row: VerdictQueryRow): VerdictRow {
  if (row.amount_cents === null)
    throw new HabitsDataError('a transaction is incomplete')
  return {
    transactionId: String(row.id),
    date: nzDate(row.date),
    merchant: row.merchant_name ?? row.description ?? '',
    // The effective category (prd-01 Ruling 4), not Akahu's.
    category: row.category,
    amountCents: row.amount_cents,
    verdict: row.verdict,
  }
}

const VERDICT_COLUMNS = [
  'transactions.id as id',
  'transactions.date as date',
  'transactions.merchant_name as merchant_name',
  'transactions.description as description',
  'transactions.category as category',
  'transactions.amount_cents as amount_cents',
  'habit_verdicts.verdict as verdict',
]

/**
 * Runway, the computable streaks and the recent spending with Hannah's
 * verdicts, for one scope, exactly as shared/habits.ts computed them.
 * Reads only.
 */
export async function readHabits(
  scope: Scope,
  now: Date = new Date(),
  db: Db = connection,
): Promise<HabitsResponse> {
  const today = guard(() => nzCalendarDate(now))
  const accounts = await loadAccounts(db)
  const currentIds = accounts
    .filter((a) => a.role === 'current')
    .map((a) => Number(a.id))
  const transactions = await loadTransactions(today, currentIds, db)
  const input: HabitsInput = { scope, today, accounts, transactions }

  const runway = guard(() => runwayTenths(input))
  const streaks = guard(() => habitStreaks(input))
  const ids = guard(() => recentSpendingIds(input))

  const rows: VerdictQueryRow[] = await onStoredAccounts(db)
    .leftJoin(
      'habit_verdicts',
      'habit_verdicts.transaction_id',
      'transactions.id',
    )
    .select(VERDICT_COLUMNS)
    .whereIn('transactions.id', ids.map(Number))
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const verdicts = ids.map((id) => {
    const row = byId.get(id)
    if (row === undefined)
      throw new HabitsDataError('a transaction is incomplete')
    return toVerdictRow(row)
  })

  return { runwayTenths: runway, streaks, verdicts }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Sets Hannah's verdict on one transaction, or clears it with null. Refused
 * without writing: 'not_found' for no such row, a non-Akahu row or a row on
 * an account that is not stored; 'pending' for a row not yet settled (its
 * id changes on every sync, prd-01 Ruling 1); 'not_spend' for money in.
 * Setting again changes the verdict and keeps `created_at`; clearing a row
 * that has none is not an error. Checks and write share one database
 * transaction.
 */
export async function setVerdict(
  transactionId: number,
  verdict: Verdict | null,
  now: Date = new Date(),
  db: Db = connection,
): Promise<VerdictRow | 'not_found' | 'pending' | 'not_spend'> {
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw new HabitsDataError('habits input invalid')
  }
  const at = now.toISOString()
  return db.transaction(async (trx) => {
    const target:
      | { status: TransactionStatus; amount_cents: number | null }
      | undefined = await onStoredAccounts(trx)
      .where('transactions.id', transactionId)
      .first(
        'transactions.status as status',
        'transactions.amount_cents as amount_cents',
      )
    if (target === undefined) return 'not_found'
    if (target.status !== 'settled') return 'pending'
    if (target.amount_cents === null)
      throw new HabitsDataError('a transaction is incomplete')
    if (target.amount_cents >= 0) return 'not_spend'

    if (verdict === null) {
      await trx('habit_verdicts').where({ transaction_id: transactionId }).del()
    } else {
      await trx('habit_verdicts')
        .insert({
          transaction_id: transactionId,
          verdict,
          created_at: at,
          updated_at: at,
        })
        .onConflict('transaction_id')
        .merge(['verdict', 'updated_at'])
    }

    const row: VerdictQueryRow | undefined = await onStoredAccounts(trx)
      .leftJoin(
        'habit_verdicts',
        'habit_verdicts.transaction_id',
        'transactions.id',
      )
      .where('transactions.id', transactionId)
      .first(VERDICT_COLUMNS)
    if (row === undefined)
      throw new HabitsDataError('a transaction is incomplete')
    return toVerdictRow(row)
  })
}

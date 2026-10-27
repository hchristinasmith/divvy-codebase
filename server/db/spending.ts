import type {
  IsoDate,
  RowScope,
  Scope,
  SpendingByCategoryResponse,
  TransactionStatus,
} from '../../shared/contracts.ts'
import type { CategorySource } from '../../models/transactions.ts'
import { effectiveCategory } from '../../shared/drawings.ts'
import { TRANSFER_WINDOW_DAYS } from '../../shared/habits.ts'
import {
  isYearMonth,
  spendingByCategory,
  type SpendingTransaction,
} from '../../shared/spending.ts'
import connection from './connection.ts'
import { loadDrawingIds } from './drawings.ts'
import { nzCalendarDate } from './overview.ts'
import { listAccounts } from './synced.ts'

// The spending data module (#271): the read behind
// GET /api/v1/spending/categories.
//
// This module does no money arithmetic. It loads rows, turns each
// transaction's instant into Hannah's NZ calendar date, lays drawings over
// each row's category, and hands everything to `spendingByCategory` in
// shared/spending.ts, whose result it returns unchanged. Nothing here is
// read by safe-to-spend.
//
// Rows read: settled and pending rows of both signs, on stored Akahu
// accounts of both scopes, each taking its account's scope; the shared
// module applies the scope asked for. Money in is read because a transfer's
// inflow leg is what pairs its outflow leg (#431); money in is never
// spending. A Xero row is never read (prd-05 is M4), and a transaction whose
// account is not stored is not read.
//
// Categories are effective ones (prd-02 Ruling 15): a half of a drawing
// that Hannah has not categorised by hand shows Drawings here, and the
// shared module's `countsAsSpending` leaves it out. Nothing is dropped
// here, so that rule lives in one place.
//
// Own-account transfers (Baseline decision 0a37d21b, pair match, #431) are
// left out by the shared module, which pairs the legs with
// `findOwnTransfers` from shared/habits.ts. Nothing here pairs anything.
//
// The month is an NZ calendar month. Stored dates are UTC instants and NZ
// is ahead of UTC, so a row in the month is never dated before the day
// before its first day in UTC, nor on or after the first of the next month;
// rows in that range are read and the NZ date of each decides. The range
// is widened by TRANSFER_WINDOW_DAYS either side, because a transfer leg
// dated just outside the month pairs with one inside it. A row with
// no date, or one in range with no amount, is read too, so it is refused
// rather than silently left out.
//
// Errors the client may see are `SpendingDataError`s with a fixed text. The
// shared modules' RangeError and TypeError, whose messages name values, and
// `OverviewDataError` from `nzCalendarDate`, are turned into one of those
// before leaving here.

/**
 * A failure the route may name to the client. The message is one of a
 * closed set of constant texts, so no stored value can reach a response
 * through it.
 */
export type SpendingDataErrorMessage =
  | 'a transaction is incomplete'
  | 'spending input invalid'

export class SpendingDataError extends Error {
  constructor(message: SpendingDataErrorMessage) {
    super(message)
    this.name = 'SpendingDataError'
  }
}

type Db = typeof connection

export interface SpendingQuery {
  scope: Scope
  /** `YYYY-MM`; today's NZ month when absent. */
  month?: string
  /** 1 to `SPENDING_TOP_MAX`; absent lists every category. */
  top?: number
}

interface SpendingQueryRow {
  id: number
  account_id: string
  date: string | null
  amount_cents: number | null
  status: TransactionStatus
  category: string | null
  category_source: CategorySource
}

/** Runs the shared code, turning its RangeError or TypeError into the fixed text. */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new SpendingDataError('spending input invalid')
    }
    throw err
  }
}

/**
 * The drawing ids, with the shared matcher's RangeError or TypeError (whose
 * messages name values) turned into the fixed text.
 */
async function loadDrawings(db: Db): Promise<Set<number>> {
  try {
    return await loadDrawingIds(db)
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new SpendingDataError('spending input invalid')
    }
    throw err
  }
}

function nzDate(instant: string | null): IsoDate {
  if (instant === null)
    throw new SpendingDataError('a transaction is incomplete')
  try {
    return nzCalendarDate(new Date(instant))
  } catch {
    throw new SpendingDataError('a transaction is incomplete')
  }
}

/** A UTC calendar date as `YYYY-MM-DD`. */
function utcDay(at: Date): IsoDate {
  return at.toISOString().slice(0, 10)
}

/**
 * The stored-date range that holds every instant whose NZ date is in the
 * month, widened by TRANSFER_WINDOW_DAYS either side so a transfer leg just
 * outside the month is read for its partner. NZ is ahead of UTC, so a
 * stored date is at most its NZ date and at least a day before it: the range
 * starts a day before the earliest NZ date read and stops before the first
 * UTC date that can fall after the latest. The month is a checked `YYYY-MM`
 * from 1000-01, so `Date.UTC`'s reading of the years 0 to 99 never applies.
 * There is no upper bound after 9999-12, which text comparison could not
 * express.
 */
function storedRange(month: string): { from: IsoDate; before: IsoDate | null } {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1
  return {
    from: utcDay(
      new Date(Date.UTC(year, index, 1 - TRANSFER_WINDOW_DAYS - 1)),
    ),
    before:
      year === 9999 && index === 11
        ? null
        : utcDay(
            new Date(Date.UTC(year, index + 1, 1 + TRANSFER_WINDOW_DAYS)),
          ),
  }
}

/**
 * Spending per category in one scope and NZ month, exactly as
 * `spendingByCategory` returned it. Reads only.
 */
export async function readSpendingByCategory(
  query: SpendingQuery,
  now: Date = new Date(),
  db: Db = connection,
): Promise<SpendingByCategoryResponse> {
  const month = query.month ?? nzCalendarDate(now).slice(0, 7)
  // Checked before it builds a date range; the shared module checks it again.
  if (!isYearMonth(month)) throw new SpendingDataError('spending input invalid')
  const range = storedRange(month)

  const accountScopes = new Map<string, RowScope>()
  for (const account of await listAccounts(db)) {
    if (account.akahu_id !== null)
      accountScopes.set(account.akahu_id, account.scope)
  }
  const rows: SpendingQueryRow[] = await db('transactions')
    .select(
      'id',
      'account_id',
      'date',
      'amount_cents',
      'status',
      'category',
      'category_source',
    )
    .where({ source: 'akahu' })
    .whereIn('account_id', [...accountScopes.keys()])
    .where((q) =>
      q
        .where((inRange) => {
          inRange.where('date', '>=', range.from)
          if (range.before !== null) inRange.where('date', '<', range.before)
        })
        .orWhereNull('date'),
    )
    .orderBy('id', 'asc')
  const drawingIds = await loadDrawings(db)

  const transactions: SpendingTransaction[] = rows.map((row) => {
    const scope = accountScopes.get(row.account_id)
    if (scope === undefined || row.amount_cents === null)
      throw new SpendingDataError('a transaction is incomplete')
    return {
      id: String(row.id),
      accountId: row.account_id,
      scope,
      date: nzDate(row.date),
      amountCents: row.amount_cents,
      status: row.status,
      category: effectiveCategory(
        { category: row.category, categorySource: row.category_source },
        drawingIds.has(row.id),
      ).category,
    }
  })
  return guard(() =>
    spendingByCategory({
      scope: query.scope,
      month,
      transactions,
      top: query.top,
    }),
  )
}

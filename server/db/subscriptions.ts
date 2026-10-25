import type {
  IsoDate,
  IsoTimestamp,
  RowScope,
  Scope,
  SubscriptionAnswer,
  SubscriptionMarkResponse,
  SubscriptionsResponse,
  TransactionStatus,
} from '../../shared/contracts.ts'
import {
  isIsoDate,
  merchantKeyOf,
  subscriptions,
  type SubscriptionMark,
  type SubscriptionTransaction,
} from '../../shared/subscriptions.ts'
import type { CategorySource } from '../../models/transactions.ts'
import { effectiveCategory, isDrawingCategory } from '../../shared/drawings.ts'
import connection from './connection.ts'
import { loadDrawingIds } from './drawings.ts'
import { nzCalendarDate } from './overview.ts'
import { listAccounts } from './synced.ts'

// The subscriptions data module (prd-02 Ruling 14, issue #229): the read
// behind GET /api/v1/subscriptions and the writes behind marking,
// cancelling and uncancelling a merchant.
//
// This module does no money arithmetic and no detection. It loads rows,
// turns each transaction's instant into Hannah's NZ calendar date, and
// hands everything to `subscriptions` in shared/subscriptions.ts, whose
// result it returns unchanged. Subscriptions never enter safe-to-spend:
// nothing here is read by server/db/overview.ts.
//
// Rows read: settled Akahu outflows on stored Akahu accounts, each taking
// its account's scope. A Xero row is never read (prd-05 is M4). A
// transaction whose account is not stored is not read. A row whose
// effective category is Drawings, a half of a drawing or one Hannah tagged
// Drawings by hand, is dropped before detection: paying herself is not a
// subscription (prd-02 Ruling 15). Dropped here, it is also not a charge
// any mark can be written against.
//
// Writes go to `subscription_marks` only, one row per scope and merchant
// key. Cancel and uncancel record a date; nothing is sent to the merchant
// or the bank. Every write first checks that the merchant has a charge in
// that scope now, so a junk key or a key from the other scope writes
// nothing and answers 'not_found'.
//
// Errors the client may see are `SubscriptionsDataError`s with a fixed
// text. The shared module's RangeError and TypeError, whose messages name
// values, and `OverviewDataError` from `nzCalendarDate`, are turned into one
// of those before leaving here.

/**
 * A `subscription_marks` row (20261025170000_subscription_marks.js). It
 * lives here rather than in `models/` because nothing else reads the table.
 */
export interface SubscriptionMarkRow {
  id: number
  scope: RowScope
  merchant_key: string
  answer: SubscriptionAnswer | null
  cancelled_on: IsoDate | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

/**
 * A failure the route may name to the client. The message is one of a
 * closed set of constant texts, so no stored value can reach a response
 * through it.
 */
export type SubscriptionsDataErrorMessage =
  | 'a transaction is incomplete'
  | 'subscription input invalid'

export class SubscriptionsDataError extends Error {
  constructor(message: SubscriptionsDataErrorMessage) {
    super(message)
    this.name = 'SubscriptionsDataError'
  }
}

type Db = typeof connection

/** One merchant in one scope, as the writes name it. */
interface MerchantTarget {
  scope: RowScope
  merchantKey: string
}

interface ChargeQueryRow {
  id: number
  account_id: string
  date: string | null
  description: string | null
  amount_cents: number
  status: TransactionStatus
  merchant_id: string | null
  merchant_name: string | null
  category: string | null
  category_source: CategorySource
}

function nzDate(instant: string | null): IsoDate {
  if (instant === null)
    throw new SubscriptionsDataError('a transaction is incomplete')
  try {
    return nzCalendarDate(new Date(instant))
  } catch {
    throw new SubscriptionsDataError('a transaction is incomplete')
  }
}

/**
 * Settled Akahu outflows on stored Akahu accounts in `scope`, oldest row
 * first, without drawings.
 */
async function loadCharges(
  scope: Scope,
  db: Db,
): Promise<SubscriptionTransaction[]> {
  const accountScopes = new Map<string, RowScope>()
  for (const account of await listAccounts(db)) {
    if (account.akahu_id === null) continue
    if (scope === 'all' || account.scope === scope) {
      accountScopes.set(account.akahu_id, account.scope)
    }
  }
  const rows: ChargeQueryRow[] = await db('transactions')
    .select(
      'id',
      'account_id',
      'date',
      'description',
      'amount_cents',
      'status',
      'merchant_id',
      'merchant_name',
      'category',
      'category_source',
    )
    .where({ source: 'akahu', status: 'settled' })
    .where('amount_cents', '<', 0)
    .whereIn('account_id', [...accountScopes.keys()])
    .orderBy('id', 'asc')
  const drawingIds = await loadDrawings(db)

  const charges = rows.filter(
    (row) =>
      !isDrawingCategory(
        effectiveCategory(
          { category: row.category, categorySource: row.category_source },
          drawingIds.has(row.id),
        ).category,
      ),
  )
  return charges.map((row) => {
    const rowScope = accountScopes.get(row.account_id)
    if (rowScope === undefined)
      throw new SubscriptionsDataError('a transaction is incomplete')
    return {
      scope: rowScope,
      status: row.status,
      date: nzDate(row.date),
      amountCents: row.amount_cents,
      merchantId: row.merchant_id,
      merchantName: row.merchant_name,
      description: row.description,
    }
  })
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
      throw new SubscriptionsDataError('subscription input invalid')
    }
    throw err
  }
}

async function loadMarks(db: Db): Promise<SubscriptionMark[]> {
  const rows: SubscriptionMarkRow[] = await db('subscription_marks').orderBy(
    'id',
    'asc',
  )
  return rows.map((row) => ({
    scope: row.scope,
    merchantKey: row.merchant_key,
    answer: row.answer,
    cancelledOn: row.cancelled_on,
  }))
}

/**
 * Subscriptions, questions and not-a-subscription merchants for one scope,
 * with the totals, exactly as `subscriptions` returned them. Reads only.
 */
export async function readSubscriptions(
  scope: Scope,
  db: Db = connection,
): Promise<SubscriptionsResponse> {
  const transactions = await loadCharges(scope, db)
  const marks = await loadMarks(db)
  try {
    return subscriptions({ scope, transactions, marks })
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new SubscriptionsDataError('subscription input invalid')
    }
    throw err
  }
}

/** The merchant has a charge in that scope now. */
async function knownMerchant(target: MerchantTarget, db: Db): Promise<boolean> {
  const charges = await loadCharges(target.scope, db)
  return charges.some((tx) => merchantKeyOf(tx) === target.merchantKey)
}

async function stored(
  target: MerchantTarget,
  db: Db,
): Promise<SubscriptionMarkResponse> {
  const row: SubscriptionMarkRow | undefined = await db('subscription_marks')
    .where({ scope: target.scope, merchant_key: target.merchantKey })
    .first()
  return {
    scope: target.scope,
    merchantKey: target.merchantKey,
    answer: row?.answer ?? null,
    cancelledOn: row?.cancelled_on ?? null,
  }
}

/**
 * Stores Hannah's answer, keeping any cancel date. A null answer clears
 * hers and never creates a row.
 */
export async function setAnswer(
  target: MerchantTarget,
  answer: SubscriptionAnswer | null,
  now: Date = new Date(),
  db: Db = connection,
): Promise<SubscriptionMarkResponse | 'not_found'> {
  if (!(await knownMerchant(target, db))) return 'not_found'
  const at = now.toISOString()
  const where = { scope: target.scope, merchant_key: target.merchantKey }
  if (answer === null) {
    await db('subscription_marks')
      .where(where)
      .update({ answer: null, updated_at: at })
  } else {
    await db('subscription_marks')
      .insert({
        ...where,
        answer,
        cancelled_on: null,
        created_at: at,
        updated_at: at,
      })
      .onConflict(['scope', 'merchant_key'])
      .merge({ answer, updated_at: at })
  }
  return stored(target, db)
}

/**
 * Records the day Hannah cancelled, `on` or else today in NZ, keeping her
 * answer. Cancelling again moves the date. A day after today is refused:
 * cancel records, it does not schedule. Nothing is sent anywhere.
 */
export async function cancelSubscription(
  target: MerchantTarget,
  on: IsoDate | undefined,
  now: Date = new Date(),
  db: Db = connection,
): Promise<SubscriptionMarkResponse | 'not_found' | 'future_date'> {
  if (on !== undefined && !isIsoDate(on)) {
    throw new SubscriptionsDataError('subscription input invalid')
  }
  if (!(await knownMerchant(target, db))) return 'not_found'
  const today = nzCalendarDate(now)
  const day = on ?? today
  if (day > today) return 'future_date'
  const at = now.toISOString()
  await db('subscription_marks')
    .insert({
      scope: target.scope,
      merchant_key: target.merchantKey,
      answer: null,
      cancelled_on: day,
      created_at: at,
      updated_at: at,
    })
    .onConflict(['scope', 'merchant_key'])
    .merge({ cancelled_on: day, updated_at: at })
  return stored(target, db)
}

/** Clears the cancel date, keeping her answer. Never creates a row. */
export async function uncancelSubscription(
  target: MerchantTarget,
  now: Date = new Date(),
  db: Db = connection,
): Promise<SubscriptionMarkResponse | 'not_found'> {
  if (!(await knownMerchant(target, db))) return 'not_found'
  await db('subscription_marks')
    .where({ scope: target.scope, merchant_key: target.merchantKey })
    .update({ cancelled_on: null, updated_at: now.toISOString() })
  return stored(target, db)
}

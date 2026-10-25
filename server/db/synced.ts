import type { Account, TransactionStatus } from '../../models/sync.ts'
import type { CategorySource } from '../../models/transactions.ts'
import connection from './connection.ts'

// Reads of the accounts and transactions sync mirrored from Akahu (prd-01,
// issue #32), for the Dashboard's DB-backed routes in
// `server/routes/accounts.ts`. Rows come back exactly as stored: money is
// integer cents, and turning it into dollars is the route's job, at the
// envelope edge (prd-01 Ruling 3).
//
// Only `source = 'akahu'` rows: the routes answer in Akahu's envelope, and a
// Xero row (Ruling 9) has no place in it.

/**
 * A `transactions` row as the Dashboard routes read it. Nullability follows
 * the migrations, not `models/transactions.ts`: every column the original
 * table created is nullable, and a pending row (prd-01 Ruling 1) has NULL
 * `akahu_id`, `hash`, `created_at`, `balance_cents` and `category`.
 *
 * Deliberately absent: the legacy `category_id/name/group_id/group_name`
 * and Akahu's `akahu_category_*` (Ruling 4: the response carries the
 * effective `category` and its `category_source`), and the `conversion_*`
 * columns, which the envelope does not carry.
 */
export interface SyncedTransaction {
  id: number
  akahu_id: string | null
  account_id: string | null
  user_id: string | null
  connection_id: string | null
  created_at: string | null
  updated_at: string | null
  date: string | null
  description: string | null
  amount_cents: number | null
  balance_cents: number | null
  type: string | null
  hash: string | null
  particulars: string | null
  code: string | null
  reference: string | null
  other_account: string | null
  logo: string | null
  card_suffix: string | null
  merchant_id: string | null
  merchant_name: string | null
  merchant_website: string | null
  merchant_logo: string | null
  category: string | null
  category_source: CategorySource
  status: TransactionStatus
}

// The select list, typed against the row so a column named here that the
// interface lacks (or the reverse, through the test's key-set pin) is caught.
const TRANSACTION_COLUMNS = [
  'id',
  'akahu_id',
  'account_id',
  'user_id',
  'connection_id',
  'created_at',
  'updated_at',
  'date',
  'description',
  'amount_cents',
  'balance_cents',
  'type',
  'hash',
  'particulars',
  'code',
  'reference',
  'other_account',
  'logo',
  'card_suffix',
  'merchant_id',
  'merchant_name',
  'merchant_website',
  'merchant_logo',
  'category',
  'category_source',
  'status',
] as const satisfies readonly (keyof SyncedTransaction)[]

/** Every Akahu-sourced account, in `id` order. */
export async function listAccounts(db = connection): Promise<Account[]> {
  return db('accounts').where({ source: 'akahu' }).orderBy('id').select()
}

/**
 * Akahu-sourced transactions, settled and pending, newest first (`date`
 * descending, then `id` descending so rows on one date keep a stable order).
 *
 * `accountIds` are Akahu account ids (`transactions.account_id`, which joins
 * to `accounts.akahu_id`). Undefined means every account; an empty list
 * means none, and answers without a query.
 */
export async function listTransactions(
  accountIds?: readonly string[],
  db = connection,
): Promise<SyncedTransaction[]> {
  if (accountIds !== undefined && accountIds.length === 0) return []
  let query = db('transactions')
    .select([...TRANSACTION_COLUMNS])
    .where({ source: 'akahu' })
  if (accountIds !== undefined) {
    query = query.whereIn('account_id', [...accountIds])
  }
  return query.orderBy([
    { column: 'date', order: 'desc' },
    { column: 'id', order: 'desc' },
  ])
}

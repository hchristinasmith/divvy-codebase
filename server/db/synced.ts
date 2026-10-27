import type { Account } from '../../models/sync.ts'
import {
  TRANSACTION_ROW_COLUMNS,
  type TransactionRow,
} from '../../models/transactions.ts'
import connection from './connection.ts'

// Reads of the accounts and transactions sync mirrored from Akahu (prd-01,
// issue #32), for the DB-backed routes in `server/routes/accounts.ts`. Rows
// come back exactly as stored: money is integer cents, and turning it into
// dollars is the route's job, at the envelope edge (prd-01 Ruling 3).
//
// Only `source = 'akahu'` rows: the routes answer in Akahu's envelope, and a
// Xero row (Ruling 9) has no place in it.

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
): Promise<TransactionRow[]> {
  if (accountIds !== undefined && accountIds.length === 0) return []
  let query = db('transactions')
    .select([...TRANSACTION_ROW_COLUMNS])
    .where({ source: 'akahu' })
  if (accountIds !== undefined) {
    query = query.whereIn('account_id', [...accountIds])
  }
  return query.orderBy([
    { column: 'date', order: 'desc' },
    { column: 'id', order: 'desc' },
  ])
}

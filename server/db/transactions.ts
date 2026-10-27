import {
  TRANSACTION_ROW_COLUMNS,
  type Transaction,
  type TransactionRow,
} from '../../models/transactions.ts'
import type {
  CategoryCorrection,
  CorrectionSource,
  TransactionStatus,
} from '../../models/sync.ts'
import connection from './connection.ts'

// The pattern for a LIKE that finds `term` anywhere (#299). `%` and `_` in the
// term are escaped so they match themselves, and so is `\`, the escape
// character `searchTxns` declares. One replace pass, so the backslashes it adds
// are never escaped again.
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// Akahu rows only (prd-02 Ruling 4): a Xero row has no place in these answers.
export async function searchTxns(
  description?: string,
  db = connection,
): Promise<TransactionRow[]> {
  let query = db('transactions')
    .select([...TRANSACTION_ROW_COLUMNS])
    .where({ source: 'akahu' })

  if (description) {
    // The pattern is a bound parameter; the ESCAPE clause names the character
    // containsPattern escapes with.
    query = query.whereRaw("description like ? escape '\\'", [
      containsPattern(description),
    ])
  }

  return query
}

/**
 * A transaction's effective category and who set it, or undefined when no
 * transaction has that id. For the agent accept route's stale check (#51,
 * decision 70b41742): a proposal is refused once the category has moved, or
 * once the user has set it by hand, even to the same value.
 */
export async function getTransactionCategory(
  id: number,
  db = connection,
): Promise<Pick<Transaction, 'category' | 'category_source'> | undefined> {
  return db('transactions').where({ id }).first('category', 'category_source')
}

/**
 * Sets the user's category on a transaction (prd-01 Ruling 4): writes the
 * effective `category`, marks `category_source` with `source` so sync never
 * overwrites it, and appends a `category_corrections` row recording the
 * change with the same `source`. Akahu's own category_* columns are left as
 * received.
 *
 * `source` defaults to `'user'`, which is what PATCH /transactions writes by
 * passing none. `'rule'` is for the agent accept route only (prd-04 Ruling 7,
 * decision 3cb449c6 on #51): an accepted proposal is marked as the rule's
 * category, not the user's, in both columns.
 *
 * The correction's `from_category` is the row's `category` before the write:
 * the effective category, which is the user's if one was set and Akahu's
 * otherwise, or null when there was none. Every call writes a correction,
 * including one that sets the category the row already has.
 *
 * Only a `status = 'settled'` row can be recategorised (#129). Sync deletes
 * and re-inserts pending rows on every run (prd-01 Ruling 1), and the
 * correction's ON DELETE CASCADE would delete it with them, so a correction
 * on a pending row would be silently lost. The status check is part of the
 * UPDATE's WHERE, so it cannot be separated from the write.
 *
 * The category write and the correction share one database transaction: if
 * the correction cannot be written, the category is not changed either. A
 * caller may pass its own transaction as `db`; the work then runs in a
 * savepoint inside it.
 *
 * Returns the updated row, with the columns of TransactionRow and nothing
 * else; `'pending'` when the row exists but is not settled, in which case
 * nothing is written; or undefined when no transaction has that id.
 */
export async function setUserCategory(
  id: number,
  category: string,
  db = connection,
  source: Extract<CorrectionSource, 'user' | 'rule'> = 'user',
): Promise<TransactionRow | 'pending' | undefined> {
  return db.transaction(async (trx) => {
    const before: Pick<Transaction, 'category'> | undefined = await trx(
      'transactions',
    )
      .where({ id })
      .first('category')
    if (!before) return undefined

    const updated = await trx('transactions')
      .where({ id, status: 'settled' satisfies TransactionStatus })
      .update({ category, category_source: source })
    if (updated === 0) return 'pending'

    const correction: Omit<CategoryCorrection, 'id'> = {
      transaction_id: id,
      from_category: before.category ?? null,
      to_category: category,
      corrected_at: new Date().toISOString(),
      source,
    }
    await trx('category_corrections').insert(correction)

    const row: TransactionRow | undefined = await trx('transactions')
      .where({ id })
      .first([...TRANSACTION_ROW_COLUMNS])
    return row
  })
}

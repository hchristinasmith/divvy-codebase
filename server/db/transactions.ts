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
import type { RowScope, Scope } from '../../shared/contracts.ts'
import { countsAsSpending } from '../../shared/spending.ts'
import { nzCalendarDate } from '../../shared/nz-dates.ts'
import connection from './connection.ts'
import { applyDrawings, loadDrawingIds } from './drawings.ts'
import { listAccounts } from './synced.ts'

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

/** One category's spending in one scope and NZ month (#272). */
export interface SpendingTransactionsQuery {
  scope: Scope
  /** `YYYY-MM`, already checked by the caller. */
  month: string
  /** An effective category, matched exactly. */
  category: string
}

/**
 * The rows the Spending screen lists under one category (#272): exactly the
 * rows `spendingByCategory` (shared/spending.ts) adds up for that category,
 * as GET /api/v1/spending/categories reads them (./spending.ts). Akahu
 * outflows, settled and pending, on stored Akahu accounts in the scope
 * (`all` is both); whose NZ calendar date falls in the month; whose
 * effective category, drawings laid over (prd-02 Ruling 15), is the one
 * asked; and that `countsAsSpending` keeps. Newest first (`date`
 * descending, then `id` descending). Reads only.
 *
 * The aggregate refuses a row with no date or no amount; this list cannot
 * place such a row in a month, so it leaves it out.
 */
export async function listSpendingTransactions(
  query: SpendingTransactionsQuery,
  db = connection,
): Promise<TransactionRow[]> {
  const accountScopes = new Map<string, RowScope>()
  for (const account of await listAccounts(db)) {
    if (account.akahu_id === null) continue
    if (query.scope !== 'all' && account.scope !== query.scope) continue
    accountScopes.set(account.akahu_id, account.scope)
  }
  if (accountScopes.size === 0) return []

  const rows: TransactionRow[] = await db('transactions')
    .select([...TRANSACTION_ROW_COLUMNS])
    .where({ source: 'akahu' })
    .where('amount_cents', '<', 0)
    .whereIn('account_id', [...accountScopes.keys()])
    .orderBy([
      { column: 'date', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])

  return applyDrawings(rows, await loadDrawingIds(db)).filter((row) => {
    const scope =
      row.account_id === null ? undefined : accountScopes.get(row.account_id)
    if (scope === undefined || row.date === null || row.amount_cents === null)
      return false
    const at = new Date(row.date)
    if (Number.isNaN(at.getTime())) return false
    const date = nzCalendarDate(at)
    if (date.slice(0, 7) !== query.month) return false
    if (row.category !== query.category) return false
    return countsAsSpending({
      scope,
      date,
      amountCents: row.amount_cents,
      category: row.category,
    })
  })
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

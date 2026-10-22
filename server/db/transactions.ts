import type { Transaction } from '../../models/transactions.ts'
import connection from './connection.ts'

export async function getTxns(db = connection): Promise<Transaction[]> {
  return db('transactions').select().orderBy('created_at')
}

export async function searchTxns(
  description?: string,
  db = connection,
): Promise<Transaction[]> {
  let query = db('transactions')

  if (description) {
    query = query.where('description', 'like', `%${description}%`)
  }

  return query.select()
}

/**
 * Sets the user's category on a transaction (prd-01 Ruling 4): writes the
 * effective `category` and marks it `category_source = 'user'` so sync never
 * overwrites it. Akahu's own category_* columns are left as received.
 * Returns the updated row, or undefined when no transaction has that id.
 */
export async function setUserCategory(
  id: number,
  category: string,
  db = connection,
): Promise<Transaction | undefined> {
  const updated = await db('transactions')
    .where({ id })
    .update({ category, category_source: 'user' })
  if (updated === 0) return undefined
  return db('transactions').where({ id }).first()
}

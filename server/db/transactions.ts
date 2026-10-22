import type { Transaction } from '../../models/transactions'
import connection from './connection'

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

export async function updateTxnCat(
  txn_id: string,
  category_group_name: string,
  db = connection,
): Promise<number> {
  try {
    const updatedRows = await db('transactions').where({ id: txn_id }).update({
      category_group_name,
    })
    return updatedRows
  } catch (error) {
    console.error('Failed to update transaction category group name', error)
    throw error
  }
}

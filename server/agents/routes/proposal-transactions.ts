import type { Knex } from 'knex'

import connection from '../../db/connection.ts'

// The description and amount of the transactions a proposals list is about
// (#439), read for GET /api/v1/agents/proposals. It lives here, and not in
// ../db/proposals.ts or ./proposals.ts, because server/agents/db/ may name only
// the inbox tables (the guard in server/agents/db/__tests__/proposals.test.ts)
// and the accept route's file may name no table outside the inbox (the guard
// in server/agents/__tests__/no-money-writes.test.ts). A module outside both
// may read `transactions`; this one only reads, and writes nothing.

interface TransactionSummary {
  description: string | null
  amountCents: number | null
}

/**
 * The summary of each id that names a transaction. An id with no transaction
 * has no entry. Empty `ids` runs no query.
 */
export async function transactionSummaries(
  ids: number[],
  db: Knex = connection,
): Promise<Map<number, TransactionSummary>> {
  const summaries = new Map<number, TransactionSummary>()
  if (ids.length === 0) return summaries
  const rows: { id: number; description: string | null; amount_cents: number | null }[] =
    await db('transactions')
      .whereIn('id', [...new Set(ids)])
      .select('id', 'description', 'amount_cents')
  for (const row of rows) {
    summaries.set(row.id, { description: row.description, amountCents: row.amount_cents })
  }
  return summaries
}

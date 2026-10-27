import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { closeDb, freshApp } from '../../../test-utils/app.ts'
import { transactionSummaries } from '../proposal-transactions.ts'

// The read behind GET /api/v1/agents/proposals (#439): one select, by id, over
// a fresh in-memory database. Every value is invented.

beforeEach(async () => {
  await freshApp()
  await connection('accounts').insert({
    akahu_id: 'acc_fixture_everyday',
    source: 'akahu',
    name: 'Fixture everyday',
    created_at: '2026-10-25T03:00:00.000Z',
    updated_at: '2026-10-25T03:00:00.000Z',
  })
})

type Query = { sql: string; bindings: readonly unknown[] }

// The listener recordQueries adds, removed after each test so none leaks.
let listener: ((q: { sql: string; bindings?: readonly unknown[] }) => void) | undefined

afterEach(() => {
  if (listener) connection.removeListener('query', listener)
  listener = undefined
})

afterAll(closeDb)

async function seedTransaction(name: string, fields: Record<string, unknown>): Promise<number> {
  const [id] = await connection('transactions').insert({
    akahu_id: `trans_fixture_${name}`,
    account_id: 'acc_fixture_everyday',
    date: '2026-10-20T00:00:00.000Z',
    description: `EXAMPLE MERCHANT ${name.toUpperCase()}`,
    amount_cents: -1250,
    category: 'Supermarkets and grocery stores',
    category_source: 'akahu',
    ...fields,
  })
  return id
}

// Records every query the connection runs, so a test can count them.
function recordQueries(): Query[] {
  const queries: Query[] = []
  listener = (q) => {
    queries.push({ sql: q.sql, bindings: q.bindings ?? [] })
  }
  connection.on('query', listener)
  return queries
}

describe('transactionSummaries', () => {
  it('maps each transaction id to its description and integer-cent amount', async () => {
    const a = await seedTransaction('a', { amount_cents: -1250 })
    const b = await seedTransaction('b', { description: null, amount_cents: -4000 })

    const summaries = await transactionSummaries([a, b])

    expect(summaries.size).toBe(2)
    expect(summaries.get(a)).toStrictEqual({
      description: 'EXAMPLE MERCHANT A',
      amountCents: -1250,
    })
    expect(summaries.get(b)).toStrictEqual({ description: null, amountCents: -4000 })
    expect(Number.isInteger(summaries.get(a)?.amountCents)).toBe(true)
  })

  it('gives no entry for an id that names no transaction', async () => {
    const a = await seedTransaction('a', {})

    const summaries = await transactionSummaries([a, 999])

    expect(summaries.size).toBe(1)
    expect(summaries.has(999)).toBe(false)
  })

  it('runs no query for an empty id list', async () => {
    await seedTransaction('a', {})
    const queries = recordQueries()

    const summaries = await transactionSummaries([])

    expect(summaries.size).toBe(0)
    expect(queries).toEqual([])
  })

  it('runs one select for the distinct ids', async () => {
    const a = await seedTransaction('a', {})
    const b = await seedTransaction('b', {})
    const queries = recordQueries()

    const summaries = await transactionSummaries([a, b, a])

    expect(queries).toHaveLength(1)
    expect(queries[0].sql).toMatch(/^select .* from .*transactions.* where .* in \(/i)
    // Two distinct ids, so two bindings, not three.
    expect(queries[0].bindings).toHaveLength(2)
    expect(summaries.size).toBe(2)
  })
})

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import server from '../../server.ts'
import connection from '../../db/connection.ts'
import fixture from '../../db/fixtures/transactions.json'
import { TRANSACTION_COLUMNS } from '../../db/__tests__/transactionColumns.ts'
import { dollarsToCents } from '../../../shared/money.ts'

// Route tests run against the app's own connection, which is the in-memory
// SQLite `test` config under vitest (NODE_ENV=test). Each test starts from a
// freshly migrated and seeded database.

beforeEach(async () => {
  delete process.env.DIVVY_SEED_TRANSACTIONS
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  await connection.seed.run()
})

afterAll(async () => {
  await connection.destroy()
})

describe('GET /api/v1/transactions', () => {
  it('returns every transaction when no description is given', async () => {
    const res = await request(server).get('/api/v1/transactions')

    expect(res.status).toBe(200)
    expect(res.body.txns.map((t: { akahu_id: string }) => t.akahu_id).sort()).toEqual(
      fixture.items.map((t) => t._id).sort(),
    )
  })

  it('filters by a description substring', async () => {
    const res = await request(server)
      .get('/api/v1/transactions')
      .query({ description: 'Superette' })

    const expected = fixture.items
      .filter((t) => t.description.includes('Superette'))
      .map((t) => t._id)
      .sort()
    expect(expected.length).toBeGreaterThan(0)
    expect(res.status).toBe(200)
    expect(res.body.txns.map((t: { akahu_id: string }) => t.akahu_id).sort()).toEqual(
      expected,
    )
  })

  it('returns money as integer cents and no dollar fields', async () => {
    const res = await request(server)
      .get('/api/v1/transactions')
      .query({ description: 'Sample Superette' })

    const source = fixture.items.find((t) => t._id === 'trans_fixture_002')!
    const row = res.body.txns.find(
      (t: { akahu_id: string }) => t.akahu_id === source._id,
    )
    expect(row.amount_cents).toBe(dollarsToCents(source.amount))
    expect(row.balance_cents).toBe(dollarsToCents(source.balance))
    expect(Number.isInteger(row.amount_cents)).toBe(true)
    expect(Object.keys(row).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
  })
})

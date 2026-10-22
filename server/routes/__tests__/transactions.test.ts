import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import server from '../../server.ts'
import connection from '../../db/connection.ts'
import fixture from '../../db/fixtures/transactions.json'
import { TRANSACTION_COLUMNS } from '../../db/__tests__/transactionColumns.ts'
import { dollarsToCents } from '../../../shared/money.ts'
import { categories } from '../../../data/cats.js'

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

const AKAHU_CATEGORY_COLUMNS = [
  'category_id',
  'category_name',
  'category_group_id',
  'category_group_name',
] as const

async function rowFor(akahuId: string) {
  return connection('transactions').where({ akahu_id: akahuId }).first()
}

describe('PATCH /api/v1/transactions/:id', () => {
  it("sets the user's category and leaves Akahu's category untouched", async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category).toBe('Supermarkets and grocery stores')
    expect(before.category_source).toBe('akahu')

    const res = await request(server)
      .patch(`/api/v1/transactions/${before.id}`)
      .send({ category: 'Convenience stores' })

    expect(res.status).toBe(200)
    expect(res.body.transaction).toMatchObject({
      id: before.id,
      category: 'Convenience stores',
      category_source: 'user',
    })
    expect(Object.keys(res.body.transaction).sort()).toEqual(
      [...TRANSACTION_COLUMNS].sort(),
    )

    const after = await rowFor('trans_fixture_002')
    expect(after.category).toBe('Convenience stores')
    expect(after.category_source).toBe('user')
    for (const column of AKAHU_CATEGORY_COLUMNS) {
      expect(after[column]).toBe(before[column])
    }
    // Nothing else on the row moved either.
    expect({ ...after, category: null, category_source: null }).toEqual({
      ...before,
      category: null,
      category_source: null,
    })
  })

  it('persists: a fresh read returns the user category', async () => {
    const { id } = await rowFor('trans_fixture_003')
    await request(server)
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    const res = await request(server)
      .get('/api/v1/transactions')
      .query({ description: 'Fixture Flat White' })
    const row = res.body.txns.find((t: { id: number }) => t.id === id)
    expect(row).toMatchObject({ category: 'Bakeries', category_source: 'user' })
  })

  it('accepts a category on a transaction Akahu never categorised', async () => {
    const before = await rowFor('trans_fixture_001')
    expect(before.category).toBeNull()

    await request(server)
      .patch(`/api/v1/transactions/${before.id}`)
      .send({ category: 'Financial services (not elsewhere classified)' })
      .expect(200)

    const after = await rowFor('trans_fixture_001')
    expect(after.category).toBe('Financial services (not elsewhere classified)')
    expect(after.category_source).toBe('user')
    expect(after.category_name).toBeNull()
  })

  it.each([
    ['a name not in the category list', { category: 'Groceries' }],
    ['a group name rather than a category', { category: 'Food' }],
    ['the old payload shape', { category_group_name: 'Food' }],
    ['the old client payload shape', { categoryId: 'nzfcc_ckouvvy98001a08ml3l180boh' }],
    ['a non-string category', { category: 42 }],
    ['an empty body', {}],
  ])('refuses %s with 400 and writes nothing', async (_, body) => {
    const before = await rowFor('trans_fixture_002')

    const res = await request(server)
      .patch(`/api/v1/transactions/${before.id}`)
      .send(body)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('category must be one of GET /api/v1/categories')
    expect(await rowFor('trans_fixture_002')).toEqual(before)
  })

  it('returns 404 for a transaction that does not exist', async () => {
    const res = await request(server)
      .patch('/api/v1/transactions/999999')
      .send({ category: 'Bakeries' })

    // The body, not just the status: an unrouted PATCH is also a 404.
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Transaction not found')
  })

  it.each(['abc', '0', '-1', '1.5', '1e3', '0x10', '%207', '007', '9007199254740993'])(
    'returns 400 for the id "%s", which is not a plain positive integer',
    async (id) => {
      const before = await connection('transactions').select().orderBy('id')

      const res = await request(server)
        .patch(`/api/v1/transactions/${id}`)
        .send({ category: 'Bakeries' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('id must be a positive integer')
      expect(await connection('transactions').select().orderBy('id')).toEqual(before)
    },
  )

  it('no longer answers PUT, the old half of the contract', async () => {
    const { id } = await rowFor('trans_fixture_002')
    const res = await request(server)
      .put(`/api/v1/transactions/${id}`)
      .send({ category_group_name: 'Other' })

    expect(res.status).toBe(404)
    expect((await rowFor('trans_fixture_002')).category_group_name).toBe('Food')
  })
})

describe('GET /api/v1/categories', () => {
  it('serves data/cats.js, the list the Category dropdown reads', async () => {
    const res = await request(server).get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: Object.entries(categories).map(([name, names]) => ({
        name,
        categories: names,
      })),
    })
  })

  it('lists only names the PATCH route accepts', async () => {
    const res = await request(server).get('/api/v1/categories')
    const { id } = await rowFor('trans_fixture_002')

    for (const group of res.body.items) {
      for (const category of group.categories) {
        await request(server)
          .patch(`/api/v1/transactions/${id}`)
          .send({ category })
          .expect(200)
      }
    }
  })
})


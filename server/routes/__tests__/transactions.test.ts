import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import server from '../../server.ts'
import connection from '../../db/connection.ts'
import { serveOnLoopback, type LoopbackApi } from '../../test-utils/app.ts'
import fixture from '../../db/fixtures/transactions.json'
import { TRANSACTION_COLUMNS } from '../../db/__tests__/transactionColumns.ts'
import { dollarsToCents } from '../../../shared/money.ts'
import { categories } from '../../../data/cats.js'

// Route tests run against the app's own connection, which is the in-memory
// SQLite `test` config under vitest (NODE_ENV=test). Each test starts from a
// freshly migrated and seeded database, and its own HTTP server on 127.0.0.1
// (`serveOnLoopback` says why).
let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  delete process.env.DIVVY_SEED_TRANSACTIONS
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  await connection.seed.run()
  served = await serveOnLoopback(server)
  api = served.api
})

// beforeEach can fail before this test's server is listening.
afterEach(async () => {
  await served?.close()
  served = undefined
})

afterAll(async () => {
  await connection.destroy()
})

describe('GET /api/v1/transactions', () => {
  it('returns every transaction when no description is given', async () => {
    const res = await api.get('/api/v1/transactions')

    expect(res.status).toBe(200)
    expect(res.body.txns.map((t: { akahu_id: string }) => t.akahu_id).sort()).toEqual(
      fixture.items.map((t) => t._id).sort(),
    )
  })

  it('filters by a description substring', async () => {
    const res = await api
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
    const res = await api
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

    const res = await api
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
    await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    const res = await api
      .get('/api/v1/transactions')
      .query({ description: 'Fixture Flat White' })
    const row = res.body.txns.find((t: { id: number }) => t.id === id)
    expect(row).toMatchObject({ category: 'Bakeries', category_source: 'user' })
  })

  it('accepts a category on a transaction Akahu never categorised', async () => {
    const before = await rowFor('trans_fixture_001')
    expect(before.category).toBeNull()

    await api
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

    const res = await api
      .patch(`/api/v1/transactions/${before.id}`)
      .send(body)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('category must be one of GET /api/v1/categories')
    expect(await rowFor('trans_fixture_002')).toEqual(before)
  })

  it('returns 404 for a transaction that does not exist', async () => {
    const res = await api
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

      const res = await api
        .patch(`/api/v1/transactions/${id}`)
        .send({ category: 'Bakeries' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('id must be a positive integer')
      expect(await connection('transactions').select().orderBy('id')).toEqual(before)
    },
  )

  it('answers with exactly the row that is now stored', async () => {
    const { id } = await rowFor('trans_fixture_002')

    const res = await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    expect(Object.keys(res.body).sort()).toEqual(['transaction'])
    expect(res.body.transaction).toEqual(await rowFor('trans_fixture_002'))
  })

  it('overwrites an earlier PATCH on the same row', async () => {
    const { id } = await rowFor('trans_fixture_002')

    await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })
      .expect(200)
    const second = await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Convenience stores' })

    expect(second.status).toBe(200)
    expect(second.body.transaction).toMatchObject({
      category: 'Convenience stores',
      category_source: 'user',
    })
    expect(await rowFor('trans_fixture_002')).toMatchObject({
      category: 'Convenience stores',
      category_source: 'user',
    })
  })

  it('takes ownership of the row even when the category is the one Akahu gave', async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category_source).toBe('akahu')

    const res = await api
      .patch(`/api/v1/transactions/${before.id}`)
      .send({ category: before.category })

    expect(res.status).toBe(200)
    expect((await rowFor('trans_fixture_002')).category_source).toBe('user')
  })

  it('leaves status, source and the Akahu-category copies as they were, and touches no other row', async () => {
    const target = await rowFor('trans_fixture_002')
    await connection('transactions').where({ id: target.id }).update({
      source: 'xero',
      akahu_category_name: 'Invented category',
      akahu_category_group_name: 'Invented group',
    })
    const before = await connection('transactions').select().orderBy('id')

    await api
      .patch(`/api/v1/transactions/${target.id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    const after = await connection('transactions').select().orderBy('id')
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    const changed = after.find((r) => r.id === target.id)
    expect(changed).toMatchObject({
      status: 'settled',
      source: 'xero',
      akahu_category_name: 'Invented category',
      akahu_category_group_name: 'Invented group',
    })
    for (const [i, row] of after.entries()) {
      if (row.id === target.id) continue
      expect(row).toEqual(before[i])
    }
  })

  it('no longer answers PUT, the old half of the contract', async () => {
    const { id } = await rowFor('trans_fixture_002')
    const res = await api
      .put(`/api/v1/transactions/${id}`)
      .send({ category_group_name: 'Other' })

    expect(res.status).toBe(404)
    expect((await rowFor('trans_fixture_002')).category_group_name).toBe('Food')
  })
})

async function correctionsFor(transactionId: number) {
  return connection('category_corrections')
    .where({ transaction_id: transactionId })
    .orderBy('id')
}

// prd-01 Rulings 1 and 4, #129.
describe('PATCH /api/v1/transactions/:id corrections', () => {
  it('writes exactly one correction with from, to, source and an ISO-8601 UTC time', async () => {
    const before = await rowFor('trans_fixture_002')
    const startedAt = new Date().toISOString()

    await api
      .patch(`/api/v1/transactions/${before.id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    const all = await connection('category_corrections').select()
    expect(all).toHaveLength(1)
    const [correction] = all
    expect(Object.keys(correction).sort()).toEqual(
      ['id', 'transaction_id', 'from_category', 'to_category', 'corrected_at', 'source'].sort(),
    )
    expect(correction).toMatchObject({
      transaction_id: before.id,
      from_category: 'Supermarkets and grocery stores',
      to_category: 'Bakeries',
      source: 'user',
    })
    expect(correction.corrected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(correction.corrected_at).toISOString()).toBe(correction.corrected_at)
    expect(correction.corrected_at >= startedAt).toBe(true)
  })

  it("records the first PATCH's category as the second correction's from", async () => {
    const { id } = await rowFor('trans_fixture_002')

    await api.patch(`/api/v1/transactions/${id}`).send({ category: 'Bakeries' }).expect(200)
    await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Convenience stores' })
      .expect(200)

    const corrections = await correctionsFor(id)
    expect(
      corrections.map((c) => [c.from_category, c.to_category]),
    ).toEqual([
      ['Supermarkets and grocery stores', 'Bakeries'],
      ['Bakeries', 'Convenience stores'],
    ])
  })

  it('records a null from for a row that had no category', async () => {
    const before = await rowFor('trans_fixture_001')
    expect(before.category).toBeNull()

    await api
      .patch(`/api/v1/transactions/${before.id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    const corrections = await correctionsFor(before.id)
    expect(corrections).toHaveLength(1)
    expect(corrections[0].from_category).toBeNull()
    expect(corrections[0].to_category).toBe('Bakeries')
  })

  it('refuses a pending row with 409, leaves it unchanged and writes no correction', async () => {
    const { id } = await rowFor('trans_fixture_002')
    await connection('transactions').where({ id }).update({ status: 'pending' })
    const before = await connection('transactions').select().orderBy('id')

    const res = await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'Transaction is still pending; its category can be changed once it settles',
    })
    expect(await connection('transactions').select().orderBy('id')).toEqual(before)
    expect(await connection('category_corrections').select()).toEqual([])
  })

  it('writes no correction when the transaction does not exist', async () => {
    await api
      .patch('/api/v1/transactions/999999')
      .send({ category: 'Bakeries' })
      .expect(404)

    expect(await connection('category_corrections').select()).toEqual([])
  })
})

describe('GET /api/v1/categories', () => {
  it('serves data/cats.js, the list the Category dropdown reads', async () => {
    const res = await api.get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: Object.entries(categories).map(([name, names]) => ({
        name,
        categories: names,
      })),
    })
  })

  // One PATCH per category, sent in sequence, so the time this takes grows
  // with the category list; it gets more than the default timeout under load.
  it('lists only names the PATCH route accepts', async () => {
    const res = await api.get('/api/v1/categories')
    const { id } = await rowFor('trans_fixture_002')
    const rejected: string[] = []

    for (const group of res.body.items) {
      for (const category of group.categories) {
        const patch = await api
          .patch(`/api/v1/transactions/${id}`)
          .send({ category })
        if (patch.status !== 200) rejected.push(category)
      }
    }

    expect(rejected).toEqual([])
  }, 20_000)
})


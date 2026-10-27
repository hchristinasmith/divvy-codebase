import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import server from '../../server.ts'
import connection from '../../db/connection.ts'
import { serveOnLoopback, type LoopbackApi } from '../../test-utils/app.ts'
import fixture from '../../db/fixtures/transactions.json'
import { dollarsToCents } from '../../../shared/money.ts'
import { categories } from '../../../data/cats.js'

// The key set GET and PATCH /api/v1/transactions answer (#212), written out
// here rather than imported from production, so a column added to the
// table or to the list in server/db/transactions.ts fails a test.
const ROW_KEYS = [
  'id',
  'akahu_id',
  'account_id',
  'user_id',
  'connection_id',
  'created_at',
  'updated_at',
  'date',
  'description',
  'amount_cents',
  'balance_cents',
  'type',
  'hash',
  'particulars',
  'code',
  'reference',
  'other_account',
  'logo',
  'card_suffix',
  'merchant_id',
  'merchant_name',
  'merchant_website',
  'merchant_logo',
  'category',
  'category_source',
  'status',
] as const

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
    expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort())
  })

  it('leaves a xero-sourced row out of the answer and keeps every Akahu row', async () => {
    await connection('transactions')
      .where({ akahu_id: 'trans_fixture_002' })
      .update({ source: 'xero' })

    const res = await api.get('/api/v1/transactions')

    expect(res.status).toBe(200)
    expect(res.body.txns.map((t: { akahu_id: string }) => t.akahu_id).sort()).toEqual(
      fixture.items
        .map((t) => t._id)
        .filter((id) => id !== 'trans_fixture_002')
        .sort(),
    )
  })

  it.each([
    ['a repeated', '/api/v1/transactions?description=Sample&description=Superette'],
    ['a nested', '/api/v1/transactions?description[a]=Sample'],
  ])(
    'refuses %s ?description= with 400 before any read',
    async (_, url) => {
      // Renamed away: a read that got past the check would answer 500, not 400.
      await connection.schema.renameTable('transactions', 'transactions_aside')
      try {
        const res = await api.get(url)

        expect(res.status).toBe(400)
        expect(res.body).toStrictEqual({
          error: 'description must be a single string',
        })
      } finally {
        await connection.schema.renameTable('transactions_aside', 'transactions')
      }
    },
  )

  it("answers 500 with a fixed text and logs the error's class, never the search string", async () => {
    const SEARCH = 'Sample Superette'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.schema.renameTable('transactions', 'transactions_aside')
    try {
      const res = await api
        .get('/api/v1/transactions')
        .query({ description: SEARCH })

      expect(res.status).toBe(500)
      expect(res.text).toBe("Couldn't search transactions")
      // The error's class only: knex's message, and so its stack, carries the
      // SQL and its bound values, and the search string is one of them.
      expect(logged.mock.calls).toStrictEqual([
        ['Error searching transactions:', 'Error'],
      ])
      // String(), not JSON.stringify: an Error object stringifies to `{}`.
      expect(logged.mock.calls.flat().map(String).join('\n')).not.toContain(SEARCH)
    } finally {
      await connection.schema.renameTable('transactions_aside', 'transactions')
      logged.mockRestore()
    }
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
    expect(Object.keys(res.body.transaction).sort()).toEqual([...ROW_KEYS].sort())

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

  it('answers with exactly the row that is now stored, projected to the list', async () => {
    const { id } = await rowFor('trans_fixture_002')

    const res = await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })
      .expect(200)

    expect(Object.keys(res.body).sort()).toEqual(['transaction'])
    const stored = await rowFor('trans_fixture_002')
    expect(Object.keys(res.body.transaction).sort()).toEqual([...ROW_KEYS].sort())
    expect(res.body.transaction).toEqual(
      Object.fromEntries(ROW_KEYS.map((key) => [key, stored[key]])),
    )
  })

  it('answers a xero-sourced row with exactly the explicit column list', async () => {
    await connection('transactions')
      .where({ akahu_id: 'trans_fixture_002' })
      .update({ source: 'xero' })
    const { id } = await rowFor('trans_fixture_002')

    const res = await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })

    expect(res.status).toBe(200)
    expect(Object.keys(res.body.transaction).sort()).toEqual([...ROW_KEYS].sort())
  })

  it('never answers a column outside the list, in GET or PATCH, even when the row holds one', async () => {
    // Set on the row, not only in the schema: a select() without a column
    // list would answer every one of these.
    await connection('transactions').where({ akahu_id: 'trans_fixture_002' }).update({
      merchant_nzbn: 'invented-nzbn',
      posted_date: '2026-10-01',
      akahu_category_name: 'Invented category',
      source: 'akahu',
    })
    const { id } = await rowFor('trans_fixture_002')

    const listed = await api.get('/api/v1/transactions').query({ description: 'Sample Superette' })
    const shown = listed.body.txns.find((t: { id: number }) => t.id === id)
    expect(Object.keys(shown).sort()).toEqual([...ROW_KEYS].sort())

    const patched = await api
      .patch(`/api/v1/transactions/${id}`)
      .send({ category: 'Bakeries' })
      .expect(200)
    expect(Object.keys(patched.body.transaction).sort()).toEqual([...ROW_KEYS].sort())
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

  it("answers 500 with a fixed error and logs the error's class under its label", async () => {
    const { id } = await rowFor('trans_fixture_002')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.schema.renameTable('transactions', 'transactions_aside')
    try {
      const res = await api
        .patch(`/api/v1/transactions/${id}`)
        .send({ category: 'Bakeries' })

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Internal server error' })
      // The error's class only: never the error object, its message or stack.
      expect(logged.mock.calls).toStrictEqual([
        ['Error setting transaction category:', 'Error'],
      ])
    } finally {
      await connection.schema.renameTable('transactions_aside', 'transactions')
      logged.mockRestore()
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
  it('serves data/cats.js, then the Divvy group holding Drawings (prd-02 Ruling 15)', async () => {
    const res = await api.get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      items: [
        ...Object.entries(categories).map(([name, names]) => ({
          name,
          categories: names,
        })),
        { name: 'Divvy', categories: ['Drawings'] },
      ],
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


// GET /api/v1/transactions?scope=&month=&category= (#272): the Spending
// screen's list under one category. Accounts and rows are inserted per test
// beside the seeded fixture, whose rows sit on no stored account and so are
// never listed. NZ is UTC+13 throughout October 2026. Every value is
// invented.
describe('GET /api/v1/transactions?scope=&month=&category=', () => {
  const EVERYDAY = 'acc_272_everyday'
  const TRADING = 'acc_272_trading'
  const UNSTORED = 'acc_272_unstored'
  const GROCER = 'Groceries Invented 272'
  const CAFE = 'Cafes Invented 272'
  const STAMP = '2026-10-20T00:00:00.000Z'

  type Row = Record<string, unknown>

  // A copy of the builders in ./spending.test.ts.
  function tx(accountId: string, date: string | null, amountCents: number, fields: Row = {}): Row {
    return {
      account_id: accountId,
      date,
      amount_cents: amountCents,
      description: 'Invented shop',
      status: 'settled',
      source: 'akahu',
      category: null,
      category_source: 'akahu',
      ...fields,
    }
  }

  async function insertAll(table: string, rows: Row[]) {
    // One insert per row, so a column a row leaves out keeps its default.
    for (const row of rows) await connection(table).insert(row)
  }

  async function seedAccounts() {
    await insertAll('accounts', [
      { id: 2721, akahu_id: EVERYDAY, source: 'akahu', scope: 'personal', name: 'Everyday Invented', created_at: STAMP, updated_at: STAMP },
      { id: 2722, akahu_id: TRADING, source: 'akahu', scope: 'strawb', name: 'Trading Invented', created_at: STAMP, updated_at: STAMP },
    ])
  }

  // Groceries in October: personal 1205 (pending) + 2310 + 999 (NZ 1 Oct),
  // strawb 1100. Everything else is a reason a row is not listed.
  async function seed() {
    await seedAccounts()
    await insertAll('transactions', [
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -2310, { category: GROCER }),
      tx(EVERYDAY, '2026-10-06T00:00:00.000Z', -1205, { category: GROCER, status: 'pending' }),
      // 12:30 UTC on 30 September is 01:30 on 1 October in NZ.
      tx(EVERYDAY, '2026-09-30T12:30:00.000Z', -999, { category: GROCER }),
      // 11:30 UTC on 31 October is 00:30 on 1 November in NZ.
      tx(EVERYDAY, '2026-10-31T11:30:00.000Z', -444, { category: GROCER }),
      tx(EVERYDAY, '2026-10-07T00:00:00.000Z', -450, { category: CAFE }),
      tx(EVERYDAY, '2026-10-08T00:00:00.000Z', -615),
      // A refund is money in, never spending.
      tx(EVERYDAY, '2026-10-09T00:00:00.000Z', 300, { category: GROCER }),
      tx(TRADING, '2026-10-12T00:00:00.000Z', -1100, { category: GROCER }),
      tx(UNSTORED, '2026-10-14T00:00:00.000Z', -88888, { category: GROCER }),
      tx(EVERYDAY, '2026-10-14T00:00:00.000Z', -77777, { category: GROCER, source: 'xero' }),
      tx(EVERYDAY, '2026-09-15T00:00:00.000Z', -55555, { category: GROCER }),
    ])
  }

  const list = (query: Record<string, string>) =>
    api.get('/api/v1/transactions').query(query)

  const amounts = (res: { body: { txns: { amount_cents: number }[] } }) =>
    res.body.txns.map((t) => t.amount_cents)

  it('lists one scope’s outflows in the category and NZ month, newest first', async () => {
    await seed()

    const personal = await list({ scope: 'personal', month: '2026-10', category: GROCER })
    expect(personal.status).toBe(200)
    expect(Object.keys(personal.body)).toEqual(['txns'])
    expect(amounts(personal)).toEqual([-1205, -2310, -999])
    for (const row of personal.body.txns) {
      expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort())
      expect(row.category).toBe(GROCER)
      expect(row.account_id).toBe(EVERYDAY)
    }

    const strawb = await list({ scope: 'strawb', month: '2026-10', category: GROCER })
    expect(amounts(strawb)).toEqual([-1100])

    const all = await list({ scope: 'all', month: '2026-10', category: GROCER })
    expect(amounts(all)).toEqual([-1100, -1205, -2310, -999])
  })

  it('places a row by its NZ date, not its UTC one', async () => {
    await seed()

    const september = await list({ scope: 'personal', month: '2026-09', category: GROCER })
    // The 30 September 12:30 UTC row is October in NZ, so it is not here.
    expect(amounts(september)).toEqual([-55555])

    const november = await list({ scope: 'personal', month: '2026-11', category: GROCER })
    expect(amounts(november)).toEqual([-444])
  })

  it('matches the category exactly and lists another category apart', async () => {
    await seed()

    expect(amounts(await list({ scope: 'all', month: '2026-10', category: CAFE }))).toEqual([-450])
    expect(
      amounts(await list({ scope: 'all', month: '2026-10', category: GROCER.toLowerCase() })),
    ).toEqual([])
  })

  it('lists nothing for a scope with no stored account', async () => {
    await insertAll('accounts', [
      { id: 2721, akahu_id: EVERYDAY, source: 'akahu', scope: 'personal', name: 'Everyday Invented', created_at: STAMP, updated_at: STAMP },
    ])
    await insertAll('transactions', [
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -2310, { category: GROCER }),
    ])

    const res = await list({ scope: 'strawb', month: '2026-10', category: GROCER })
    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ txns: [] })
  })

  describe('drawings are not spending (prd-02 Ruling 15)', () => {
    // A strawb out-half on the 15th and its personal in-half on the 16th.
    async function seedDrawing(outFields: Row = {}) {
      await seedAccounts()
      await insertAll('transactions', [
        tx(TRADING, '2026-10-15T00:00:00.000Z', -25000, { category: GROCER, ...outFields }),
        tx(EVERYDAY, '2026-10-16T00:00:00.000Z', 25000),
        tx(TRADING, '2026-10-17T00:00:00.000Z', -1100, { category: GROCER }),
      ])
    }

    it('leaves the drawn half out of its Akahu category and lists nothing under Drawings', async () => {
      await seedDrawing()

      expect(amounts(await list({ scope: 'strawb', month: '2026-10', category: GROCER }))).toEqual([-1100])
      expect(amounts(await list({ scope: 'all', month: '2026-10', category: 'Drawings' }))).toEqual([])
    })

    it('lists the half under the category Hannah set by hand', async () => {
      await seedDrawing({ category_source: 'user' })

      expect(amounts(await list({ scope: 'strawb', month: '2026-10', category: GROCER }))).toEqual([
        -1100, -25000,
      ])
    })
  })

  it('lists, for every category the aggregate reports, rows that add up to its figure', async () => {
    await seed()
    await insertAll('transactions', [
      tx(TRADING, '2026-10-15T00:00:00.000Z', -25000, { category: CAFE }),
      tx(EVERYDAY, '2026-10-16T00:00:00.000Z', 25000),
    ])

    for (const scope of ['all', 'personal', 'strawb']) {
      const aggregate = await api
        .get('/api/v1/spending/categories')
        .query({ scope, month: '2026-10' })
      expect(aggregate.status).toBe(200)
      expect(aggregate.body.categories.length, scope).toBeGreaterThan(0)
      for (const line of aggregate.body.categories as { category: string; spentCents: number }[]) {
        const res = await list({ scope, month: '2026-10', category: line.category })
        expect(res.body.txns.map((t: { category: string }) => t.category)).toEqual(
          res.body.txns.map(() => line.category),
        )
        const listed = res.body.txns.reduce(
          (sum: number, t: { amount_cents: number }) => sum - t.amount_cents,
          0,
        )
        expect(listed, `${scope} ${line.category}`).toBe(line.spentCents)
      }
    }
  })

  it('leaves the answer without the filters exactly as before: every Akahu row, money in included', async () => {
    await seed()

    const res = await api.get('/api/v1/transactions')
    expect(res.status).toBe(200)
    const shown: number[] = res.body.txns.map((t: { amount_cents: number }) => t.amount_cents)
    expect(shown).toEqual(expect.arrayContaining([300, -88888, -55555, -444, -615]))
    expect(shown).not.toContain(-77777)
    expect(res.body.txns).toHaveLength(fixture.items.length + 10)
  })

  // Each refusal is checked with the table renamed away: a read that got past
  // the check would answer 500, not 400.
  async function refusedBeforeRead(url: string, error: string) {
    await connection.schema.renameTable('transactions', 'transactions_aside')
    try {
      const res = await api.get(url)
      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error })
    } finally {
      await connection.schema.renameTable('transactions_aside', 'transactions')
    }
  }

  it.each([
    ['scope alone', '?scope=all'],
    ['month alone', '?month=2026-10'],
    ['category alone', '?category=Bakeries'],
    ['no category', '?scope=all&month=2026-10'],
    ['no month', '?scope=all&category=Bakeries'],
    ['no scope', '?month=2026-10&category=Bakeries'],
    ['a misspelt category', '?scope=all&month=2026-10&categry=Bakeries'],
  ])('refuses %s with 400', async (_, query) => {
    await refusedBeforeRead(
      `/api/v1/transactions${query}`,
      'scope, month and category must be sent together',
    )
  })

  it.each([
    ['a repeated scope', '?scope=all&scope=personal&month=2026-10&category=Bakeries'],
    ['a repeated month', '?scope=all&month=2026-10&month=2026-11&category=Bakeries'],
    ['a repeated category', '?scope=all&month=2026-10&category=Bakeries&category=Cafes'],
    ['a nested category', '?scope=all&month=2026-10&category[a]=Bakeries'],
    ['a repeated scope alone', '?scope=all&scope=strawb'],
  ])('refuses %s with 400', async (_, query) => {
    await refusedBeforeRead(
      `/api/v1/transactions${query}`,
      'scope, month and category must each be sent once',
    )
  })

  it.each([
    ['an unknown scope', { scope: 'both', month: '2026-10', category: 'Bakeries' }, 'scope must be all, personal or strawb'],
    ['a month that is not YYYY-MM', { scope: 'all', month: '2026-13', category: 'Bakeries' }, 'month must be YYYY-MM'],
    ['a date for a month', { scope: 'all', month: '2026-10-01', category: 'Bakeries' }, 'month must be YYYY-MM'],
    ['an empty category', { scope: 'all', month: '2026-10', category: '' }, 'category must be 1 to 200 characters'],
    ['a category over 200 characters', { scope: 'all', month: '2026-10', category: 'x'.repeat(201) }, 'category must be 1 to 200 characters'],
    ['a description beside the filters', { scope: 'all', month: '2026-10', category: 'Bakeries', description: 'Shop' }, 'description cannot be sent with scope, month and category'],
  ])('refuses %s with 400', async (_, query, error) => {
    await refusedBeforeRead(`/api/v1/transactions?${new URLSearchParams(query)}`, error)
  })

  it('accepts a category of exactly 200 characters', async () => {
    await seed()
    const res = await list({ scope: 'all', month: '2026-10', category: 'x'.repeat(200) })
    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ txns: [] })
  })

  it("answers 500 with a fixed text and logs the error's class, never the category", async () => {
    const CATEGORY = 'Invented secret category'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedAccounts()
    await connection.schema.renameTable('transactions', 'transactions_aside')
    try {
      const res = await list({ scope: 'all', month: '2026-10', category: CATEGORY })

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: "Couldn't list transactions" })
      expect(logged.mock.calls).toStrictEqual([
        ['Error listing spending transactions:', 'Error'],
      ])
      expect(logged.mock.calls.flat().map(String).join('\n')).not.toContain(CATEGORY)
    } finally {
      await connection.schema.renameTable('transactions_aside', 'transactions')
      logged.mockRestore()
    }
  })
})

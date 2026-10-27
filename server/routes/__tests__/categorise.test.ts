import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import connection from '../../db/connection.ts'
import * as drawings from '../../db/drawings.ts'
import { upsertSettled } from '../../sync/upsert.ts'
import type { SettledTransaction } from '../../sync/types.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import type {
  CategoriseGroupResponse,
  CategoriseGroupsResponse,
} from '../../../shared/contracts.ts'

// The real drawing loader, behind a spy, so a test can make it throw what
// the shared matcher throws.
vi.mock('../../db/drawings.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/drawings.ts')>()
  return { ...real, loadDrawingIds: vi.fn(real.loadDrawingIds) }
})

// The Sort screen's routes (prd-02 Ruling 17, issue #259), over HTTP
// against the real app and a fresh in-memory database migrated in
// `beforeEach` (Done-when 7). Every account, merchant, description and
// amount below is invented.
//
// Each describe names the issue's Done-when bullet it proves (DW1 to DW5;
// DW6 is the screen's tests, DW8 the PRD text).

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.restoreAllMocks()
})

afterAll(closeDb)

const STAMP = '2026-10-20T00:00:00.000Z'
const EVERYDAY = 'acc_fixture_everyday'
const TRADING = 'acc_fixture_trading'

const CAFES = 'Cafes and restaurants'
const BAKERIES = 'Bakeries'

const CAFE_ID = 'merchant_fixture_cafe'
const CAFE_KEY = `m:${CAFE_ID}`

const APPLY = '/api/v1/categorise/groups/apply'

const GROUP_KEYS = [
  'merchantKey',
  'name',
  'count',
  'totalCents',
  'receivedCents',
  'latestDate',
  'latestAmountCents',
]

type Row = Record<string, unknown>

async function insertAll(table: string, rows: Row[]) {
  // One insert per row: a multi-row insert binds NULL for a key a row
  // leaves out, which would skip the column defaults.
  for (const row of rows) await connection(table).insert(row)
}

async function seedAccounts() {
  await insertAll('accounts', [
    {
      id: 1,
      akahu_id: EVERYDAY,
      source: 'akahu',
      scope: 'personal',
      name: 'Invented Everyday',
      balance_cents: 250000,
      created_at: STAMP,
      updated_at: STAMP,
    },
    {
      id: 2,
      akahu_id: TRADING,
      source: 'akahu',
      scope: 'strawb',
      name: 'Invented Trading',
      balance_cents: 600000,
      created_at: STAMP,
      updated_at: STAMP,
    },
  ])
}

function tx(
  id: number,
  accountId: string,
  date: string,
  amountCents: number,
  fields: Row = {},
): Row {
  return {
    id,
    akahu_id: `trans_fixture_${id}`,
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: `EXAMPLE ROW ${id}`,
    type: 'EFTPOS',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

function cafe(id: number, date: string, cents: number, fields: Row = {}): Row {
  return tx(id, EVERYDAY, date, cents, {
    merchant_id: CAFE_ID,
    merchant_name: 'EXAMPLE CAFE',
    description: `EXAMPLE CAFE ${id}`,
    ...fields,
  })
}

async function groups(scope: string): Promise<CategoriseGroupResponse[]> {
  const res = await api.get(`/api/v1/categorise/groups?scope=${scope}`)
  expect(res.status).toBe(200)
  return (res.body as CategoriseGroupsResponse).groups
}

function apply(body: unknown) {
  return api.post(APPLY).send(body as object)
}

async function rowsById(ids: number[]) {
  return connection('transactions')
    .whereIn('id', ids)
    .orderBy('id')
    .select('id', 'category', 'category_source')
}

async function corrections() {
  return connection('category_corrections')
    .orderBy('transaction_id')
    .select('transaction_id', 'from_category', 'to_category', 'source')
}

// Five uncategorised settled rows of one merchant, one pending, one that
// Akahu already categorised.
const FIVE = [10, 11, 12, 13, 14]
const PENDING_ID = 15
const CATEGORISED_ID = 16

async function seedCafe() {
  await seedAccounts()
  await insertAll('transactions', [
    cafe(10, '2026-10-01T01:00:00.000Z', -450),
    cafe(11, '2026-10-02T01:00:00.000Z', -520),
    cafe(12, '2026-10-03T01:00:00.000Z', -480),
    cafe(13, '2026-10-04T01:00:00.000Z', -610),
    cafe(14, '2026-10-05T01:00:00.000Z', -390),
    cafe(PENDING_ID, '2026-10-06T01:00:00.000Z', -700, {
      akahu_id: null,
      status: 'pending',
    }),
    cafe(CATEGORISED_ID, '2026-10-07T01:00:00.000Z', -800, {
      category: BAKERIES,
    }),
  ])
}

describe('apply changes exactly the uncategorised settled rows (DW1)', () => {
  it('lists the five, not the pending or the categorised row', async () => {
    await seedCafe()

    // Fails if the loader drops the status or the category filter: the
    // count would be six or seven.
    const [group, ...rest] = await groups('personal')
    expect(rest).toEqual([])
    expect(group).toStrictEqual({
      merchantKey: CAFE_KEY,
      name: 'EXAMPLE CAFE',
      count: 5,
      totalCents: 450 + 520 + 480 + 610 + 390,
      receivedCents: 0,
      latestDate: '2026-10-05',
      latestAmountCents: -390,
    })
  })

  it('changes the five, writes five user corrections, and leaves the other two alone', async () => {
    await seedCafe()

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: CAFES,
    })

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ changed: 5 })
    expect(Object.keys(res.body).sort()).toEqual(['changed'])
    // Fails if the apply overwrites the categorised row or touches the
    // pending one.
    expect(await rowsById([...FIVE, PENDING_ID, CATEGORISED_ID])).toEqual([
      ...FIVE.map((id) => ({ id, category: CAFES, category_source: 'user' })),
      { id: PENDING_ID, category: null, category_source: 'akahu' },
      { id: CATEGORISED_ID, category: BAKERIES, category_source: 'akahu' },
    ])
    // Fails if the apply writes the category without `setUserCategory`'s
    // correction, or with a source other than `user`.
    expect(await corrections()).toEqual(
      FIVE.map((id) => ({
        transaction_id: id,
        from_category: null,
        to_category: CAFES,
        source: 'user',
      })),
    )
    expect(await groups('personal')).toEqual([])
  })

  it('answers 0 for a second submit and writes nothing more', async () => {
    await seedCafe()
    const body = { scope: 'personal', merchant_key: CAFE_KEY, category: CAFES }
    await apply(body)

    const again = await apply(body)

    expect(again.status).toBe(200)
    expect(again.body).toStrictEqual({ changed: 0 })
    expect(await corrections()).toHaveLength(5)
  })

  it('never overwrites a row categorised between the list and the apply', async () => {
    await seedCafe()
    expect((await groups('personal'))[0].count).toBe(5)
    // Hannah categorises one by hand in Transactions after the list loaded.
    const patched = await api
      .patch('/api/v1/transactions/12')
      .send({ category: BAKERIES })
    expect(patched.status).toBe(200)

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: CAFES,
    })

    // Fails if the apply writes the ids the list showed instead of
    // re-deriving the group.
    expect(res.body).toStrictEqual({ changed: 4 })
    expect(await rowsById([12])).toEqual([
      { id: 12, category: BAKERIES, category_source: 'user' },
    ])
    expect(
      (await corrections()).filter((c) => c.transaction_id === 12),
    ).toEqual([
      {
        transaction_id: 12,
        from_category: null,
        to_category: BAKERIES,
        source: 'user',
      },
    ])
  })

  it('accepts Drawings, as PATCH /transactions does', async () => {
    await seedCafe()

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: 'Drawings',
    })

    expect(res.body).toStrictEqual({ changed: 5 })
  })
})

describe('a category not in the taxonomy is refused (DW2)', () => {
  it('answers 400 with the guard text and writes nothing', async () => {
    await seedCafe()

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: 'Invented Category',
    })

    // With the category guard disabled this is a 200 that writes five rows.
    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'category is not in the category list',
    })
    expect(
      (await rowsById(FIVE)).every((row) => row.category === null),
    ).toBe(true)
    expect(await corrections()).toEqual([])
  })

  it('refuses a category that is not a string', async () => {
    await seedCafe()

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: ['Cafes and restaurants'],
    })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'category is not in the category list',
    })
    expect(await corrections()).toEqual([])
  })
})

describe('sync after an apply keeps the user category (DW3)', () => {
  it('upserting the same rows from Akahu, now with its own category, changes nothing', async () => {
    await seedCafe()
    await apply({ scope: 'personal', merchant_key: CAFE_KEY, category: CAFES })

    // The same five rows as Akahu would send them again, this time with a
    // category of Akahu's own. Sync follows Akahu only while
    // category_source is 'akahu', so an apply that wrote the category
    // without marking it the user's would revert here.
    const settled = (id: number, date: string, cents: number) =>
      ({
        status: 'settled',
        id: `trans_fixture_${id}`,
        account_id: EVERYDAY,
        connection_id: null,
        date,
        posted_date: null,
        created_at: date,
        updated_at: date,
        hash: `hash_${id}`,
        amount_cents: cents,
        balance_cents: null,
        description: `EXAMPLE CAFE ${id}`,
        type: 'EFTPOS',
        merchant: {
          id: CAFE_ID,
          name: 'EXAMPLE CAFE',
          nzbn: null,
          website: null,
          logo: null,
        },
        meta: null,
        akahu_category: {
          id: 'nzfcc_fixture_bakeries',
          name: BAKERIES,
          group_id: null,
          group_name: null,
        },
      }) satisfies SettledTransaction
    await connection.transaction((trx) =>
      upsertSettled(trx, [
        settled(10, '2026-10-01T01:00:00.000Z', -450),
        settled(11, '2026-10-02T01:00:00.000Z', -520),
        settled(12, '2026-10-03T01:00:00.000Z', -480),
        settled(13, '2026-10-04T01:00:00.000Z', -610),
        settled(14, '2026-10-05T01:00:00.000Z', -390),
      ]),
    )

    expect(await rowsById(FIVE)).toEqual(
      FIVE.map((id) => ({ id, category: CAFES, category_source: 'user' })),
    )
    // The sync did reach these rows: Akahu's own column took its category.
    const akahu = await connection('transactions')
      .whereIn('id', FIVE)
      .pluck('akahu_category_name')
    expect(akahu).toEqual(FIVE.map(() => BAKERIES))
  })
})

describe('groups are scoped (DW4)', () => {
  async function seedBothScopes() {
    await seedAccounts()
    await insertAll('transactions', [
      cafe(30, '2026-10-01T01:00:00.000Z', -1000),
      cafe(31, '2026-10-02T01:00:00.000Z', -2000, { account_id: TRADING }),
    ])
  }

  it('lists a strawb row only under strawb and all', async () => {
    await seedBothScopes()

    expect((await groups('personal')).map((g) => [g.count, g.totalCents])).toEqual([[1, 1000]])
    expect((await groups('strawb')).map((g) => [g.count, g.totalCents])).toEqual([[1, 2000]])
    expect((await groups('all')).map((g) => [g.count, g.totalCents])).toEqual([[2, 3000]])
  })

  it('a personal apply never changes the strawb row, nor a strawb apply the personal one', async () => {
    await seedBothScopes()

    const personal = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: CAFES,
    })
    expect(personal.body).toStrictEqual({ changed: 1 })
    expect(await rowsById([30, 31])).toEqual([
      { id: 30, category: CAFES, category_source: 'user' },
      { id: 31, category: null, category_source: 'akahu' },
    ])

    const strawb = await apply({
      scope: 'strawb',
      merchant_key: CAFE_KEY,
      category: BAKERIES,
    })
    expect(strawb.body).toStrictEqual({ changed: 1 })
    expect(await rowsById([30, 31])).toEqual([
      { id: 30, category: CAFES, category_source: 'user' },
      { id: 31, category: BAKERIES, category_source: 'user' },
    ])
  })

  it('an all apply changes both scopes', async () => {
    await seedBothScopes()

    const res = await apply({
      scope: 'all',
      merchant_key: CAFE_KEY,
      category: CAFES,
    })

    expect(res.body).toStrictEqual({ changed: 2 })
  })
})

describe('groups total to the cent, largest first (DW5)', () => {
  // The hand sums, merchant by merchant (money out positive, money in
  // apart):
  //   a: 1250 + 399 + 10001 = 11650 out
  //   h: 5000 out, 1999 in (a refund)
  //   f: 2500 + 2500 = 5000 out
  //   c: 5000 out; g: 5000 out (one row each)
  //   d: 3000 in only
  // Order: a; then the 5000s by received (h), by count (f), by key (c, g);
  // then d. The keys run against the rules above them (h after f, c after
  // f), so dropping any one rule reorders the list.
  async function seedTotals() {
    await seedAccounts()
    const m = (id: number, merchant: string, date: string, cents: number, fields: Row = {}) =>
      tx(id, EVERYDAY, date, cents, {
        merchant_id: `merchant_fixture_${merchant}`,
        merchant_name: `EXAMPLE ${merchant.toUpperCase()}`,
        ...fields,
      })
    await insertAll('transactions', [
      m(40, 'a', '2026-10-01T01:00:00.000Z', -1250),
      m(41, 'a', '2026-10-02T01:00:00.000Z', -399),
      // 22:00 UTC is the next calendar day in NZ.
      m(42, 'a', '2026-10-20T22:00:00.000Z', -10001),
      m(43, 'h', '2026-10-01T01:00:00.000Z', -5000),
      // The latest row has no merchant name; the card keeps the last one.
      m(44, 'h', '2026-10-09T01:00:00.000Z', 1999, { merchant_name: null }),
      m(45, 'f', '2026-10-01T01:00:00.000Z', -2500),
      m(46, 'f', '2026-10-02T01:00:00.000Z', -2500),
      m(47, 'g', '2026-10-03T01:00:00.000Z', -5000),
      m(48, 'c', '2026-10-04T01:00:00.000Z', -5000),
      m(49, 'd', '2026-10-05T01:00:00.000Z', 3000),
    ])
  }

  it('answers each merchant against the hand sum, in order', async () => {
    await seedTotals()

    const listed = await groups('personal')

    expect(listed).toStrictEqual([
      {
        merchantKey: 'm:merchant_fixture_a',
        name: 'EXAMPLE A',
        count: 3,
        totalCents: 11650,
        receivedCents: 0,
        latestDate: '2026-10-21',
        latestAmountCents: -10001,
      },
      {
        merchantKey: 'm:merchant_fixture_h',
        name: 'EXAMPLE H',
        count: 2,
        totalCents: 5000,
        receivedCents: 1999,
        latestDate: '2026-10-09',
        latestAmountCents: 1999,
      },
      {
        merchantKey: 'm:merchant_fixture_f',
        name: 'EXAMPLE F',
        count: 2,
        totalCents: 5000,
        receivedCents: 0,
        latestDate: '2026-10-02',
        latestAmountCents: -2500,
      },
      {
        merchantKey: 'm:merchant_fixture_c',
        name: 'EXAMPLE C',
        count: 1,
        totalCents: 5000,
        receivedCents: 0,
        latestDate: '2026-10-04',
        latestAmountCents: -5000,
      },
      {
        merchantKey: 'm:merchant_fixture_g',
        name: 'EXAMPLE G',
        count: 1,
        totalCents: 5000,
        receivedCents: 0,
        latestDate: '2026-10-03',
        latestAmountCents: -5000,
      },
      {
        merchantKey: 'm:merchant_fixture_d',
        name: 'EXAMPLE D',
        count: 1,
        totalCents: 0,
        receivedCents: 3000,
        latestDate: '2026-10-05',
        latestAmountCents: 3000,
      },
    ])
    for (const group of listed) {
      expect(Object.keys(group).sort()).toEqual([...GROUP_KEYS].sort())
    }
    const res = await api.get('/api/v1/categorise/groups?scope=personal')
    expect(Object.keys(res.body)).toEqual(['groups'])
  })
})

describe('what makes a merchant', () => {
  it('groups descriptions that differ only in per-charge digits into one card', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(50, EVERYDAY, '2026-10-01T01:00:00.000Z', -300, {
        description: 'EXAMPLE PARKING 00123 AKL',
      }),
      tx(51, EVERYDAY, '2026-10-02T01:00:00.000Z', -450, {
        description: '  EXAMPLE PARKING 00987 AKL  ',
      }),
    ])

    expect(await groups('personal')).toStrictEqual([
      {
        merchantKey: 'd:example parking akl',
        name: 'EXAMPLE PARKING 00987 AKL',
        count: 2,
        totalCents: 750,
        receivedCents: 0,
        latestDate: '2026-10-02',
        latestAmountCents: -450,
      },
    ])
    const res = await apply({
      scope: 'personal',
      merchant_key: 'd:example parking akl',
      category: 'Parking services',
    })
    expect(res.body).toStrictEqual({ changed: 2 })
  })

  it('keys by the Akahu merchant id when there is one, else by the description', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      cafe(52, '2026-10-01T01:00:00.000Z', -300, {
        description: 'EXAMPLE CAFE NORTH END',
      }),
      cafe(53, '2026-10-02T01:00:00.000Z', -400, {
        description: 'EXAMPLE CAFE SOUTH END',
      }),
      tx(54, EVERYDAY, '2026-10-03T01:00:00.000Z', -500, {
        description: 'EXAMPLE CAFE NORTH END',
      }),
    ])

    const listed = await groups('personal')

    expect(listed.map((g) => [g.merchantKey, g.count])).toEqual([
      [CAFE_KEY, 2],
      ['d:example cafe north end', 1],
    ])
    const res = await apply({
      scope: 'personal',
      merchant_key: 'd:example cafe north end',
      category: CAFES,
    })
    expect(res.body).toStrictEqual({ changed: 1 })
    expect(await rowsById([52, 53, 54])).toEqual([
      { id: 52, category: null, category_source: 'akahu' },
      { id: 53, category: null, category_source: 'akahu' },
      { id: 54, category: CAFES, category_source: 'user' },
    ])
  })

  it('leaves out a row with no merchant id and no letter in its description', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(55, EVERYDAY, '2026-10-01T01:00:00.000Z', -300, {
        description: '0042 1234-5678',
      }),
      tx(56, EVERYDAY, '2026-10-02T01:00:00.000Z', -300, {
        description: null,
        merchant_id: '   ',
      }),
    ])

    expect(await groups('all')).toEqual([])
  })

  it('names a card by its description when no row has a merchant name', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      cafe(57, '2026-10-01T01:00:00.000Z', -300, {
        merchant_name: '   ',
        description: '  EXAMPLE CAFE KIOSK  ',
      }),
    ])

    expect((await groups('personal')).map((g) => g.name)).toEqual([
      'EXAMPLE CAFE KIOSK',
    ])
  })
})

describe('drawings are never a group (prd-02 Ruling 15)', () => {
  it('leaves both halves of a drawing out of the list and untouched by an apply', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(60, TRADING, '2026-10-27T01:00:00.000Z', -30000, {
        type: 'TRANSFER',
        description: 'EXAMPLE OWN TRANSFER OUT',
      }),
      tx(61, EVERYDAY, '2026-10-27T22:00:00.000Z', 30000, {
        type: 'TRANSFER',
        description: 'EXAMPLE OWN TRANSFER IN',
      }),
      cafe(62, '2026-10-27T03:00:00.000Z', -450),
    ])
    // Not vacuous: the matcher does see these two as a drawing.
    expect(await drawings.loadDrawingIds()).toStrictEqual(new Set([60, 61]))

    expect((await groups('all')).map((g) => g.merchantKey)).toEqual([CAFE_KEY])

    const res = await apply({
      scope: 'all',
      merchant_key: 'd:example own transfer in',
      category: CAFES,
    })
    expect(res.body).toStrictEqual({ changed: 0 })
    expect(await rowsById([60, 61])).toEqual([
      { id: 60, category: null, category_source: 'akahu' },
      { id: 61, category: null, category_source: 'akahu' },
    ])
    expect(await corrections()).toEqual([])
  })
})

describe('a write from another site is refused', () => {
  it.each([
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['a foreign Origin', { Origin: 'https://example.invalid' }],
  ])('%s is a 403 and writes nothing', async (_name, headers) => {
    await seedCafe()

    const res = await api
      .post(APPLY)
      .set(headers)
      .send({ scope: 'personal', merchant_key: CAFE_KEY, category: CAFES })

    // With the guard disabled this is a 200 that writes five rows.
    expect(res.status).toBe(403)
    expect(res.body).toStrictEqual({ error: 'Forbidden' })
    expect(await corrections()).toEqual([])
  })

  it('checks the site before the body', async () => {
    const res = await api
      .post(APPLY)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ nope: true })

    expect(res.status).toBe(403)
  })
})

describe('bad requests', () => {
  it.each(['everyone', ''])('GET with scope %j is a 400', async (scope) => {
    const res = await api.get(`/api/v1/categorise/groups?scope=${scope}`)

    // With `parseScope` disabled this is a 200 with no groups.
    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
  })

  it('GET with a repeated scope is a 400', async () => {
    const res = await api.get(
      '/api/v1/categorise/groups?scope=personal&scope=strawb',
    )

    expect(res.status).toBe(400)
  })

  it('an extra key is refused, and nothing is written', async () => {
    await seedCafe()

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: CAFES,
      ids: [10],
    })

    // Every other field is valid: with the key-set guard disabled this is a
    // 200 that writes five rows.
    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Invalid body' })
    expect(await corrections()).toEqual([])
  })

  it('a missing key is refused', async () => {
    const res = await apply({ scope: 'personal', merchant_key: CAFE_KEY })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Invalid body' })
  })

  it('an array body is refused', async () => {
    const res = await apply([
      { scope: 'personal', merchant_key: CAFE_KEY, category: CAFES },
    ])

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Invalid body' })
  })

  it('a scope that is not a view is refused, and nothing is written', async () => {
    await seedCafe()

    const res = await apply({
      scope: 'everyone',
      merchant_key: CAFE_KEY,
      category: CAFES,
    })

    // With the scope guard disabled this is a 200 that changes nothing.
    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
  })

  it.each(['x:merchant_fixture_cafe', 'm:', 42])(
    'merchant_key %j is refused',
    async (key) => {
      await seedCafe()

      const res = await apply({
        scope: 'personal',
        merchant_key: key,
        category: CAFES,
      })

      // With the key guard disabled this is a 200 that changes nothing.
      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'merchant_key is not valid' })
    },
  )
})

describe('a failure is fixed text', () => {
  it('the drawing matcher throwing a value-naming error answers the constant text', async () => {
    await seedCafe()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(drawings.loadDrawingIds).mockRejectedValueOnce(
      new RangeError('amount 12.5 on row trans_fixture_10 is not cents'),
    )

    const res = await api.get('/api/v1/categorise/groups?scope=all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'categorise input invalid' })
    expect(log.mock.calls).toEqual([
      ['categorise: could not list groups', 'CategoriseDataError'],
    ])
  })

  it('anything else answers the generic text and logs only its class', async () => {
    await seedCafe()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(drawings.loadDrawingIds).mockRejectedValueOnce(
      new Error('SQLITE_ERROR near trans_fixture_10'),
    )

    const res = await apply({
      scope: 'personal',
      merchant_key: CAFE_KEY,
      category: CAFES,
    })

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not apply the category' })
    expect(log.mock.calls).toEqual([
      ['categorise: could not apply category', 'Error'],
    ])
    expect(await corrections()).toEqual([])
  })
})

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
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import type {
  SpendingByCategoryResponse,
  SpendingCategoryLine,
} from '../../../shared/contracts.ts'

// The real drawing loader, behind a spy, so a test can make it throw what
// the shared matcher throws.
vi.mock('../../db/drawings.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/drawings.ts')>()
  return { ...real, loadDrawingIds: vi.fn(real.loadDrawingIds) }
})

// /api/v1/spending/categories (#271), over HTTP against the real app and a
// fresh in-memory database. The clock is fixed at 23:30 UTC on 27 October
// 2026, which is 12:30 NZDT on the 28th, so this month in NZ is 2026-10.
// Every value below is invented.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

const NOW_ISO = '2026-10-27T23:30:00.000Z'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_ISO)
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(closeDb)

const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

// A copy of the account/transaction builders in ./subscriptions.test.ts and
// its siblings.
function account(fields: Row): Row {
  return {
    source: 'akahu',
    name: 'Invented account',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

function tx(
  accountId: string,
  date: string | null,
  amountCents: number,
  fields: Row = {},
): Row {
  return {
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: 'SENTINEL SHOP 4829',
    merchant_name: 'Sentinel Merchant',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

// Account numbers, Akahu ids, connection ids, names and descriptions: never
// in a payload.
const SECRET_TOKENS = [
  'acc_sentinel_',
  '00-SENT-',
  'Sentinel Bank 91c2',
  'conn_sentinel_',
  'Sentinel Everyday',
  'Sentinel Trading',
  'SENTINEL SHOP',
  'Sentinel Merchant',
]

const EVERYDAY = 'acc_sentinel_everyday'
const TRADING = 'acc_sentinel_trading'
const UNSTORED = 'acc_sentinel_unstored'

const GROCER = 'Groceries Invented'
const CAFE = 'Cafes Invented'
const SOFTWARE = 'Software Invented'

async function insertAll(table: string, rows: Row[]) {
  // One insert per row: a multi-row insert binds NULL for a key a row
  // leaves out, which would skip the column defaults.
  for (const row of rows) await connection(table).insert(row)
}

async function seedAccounts() {
  const sentinel = (n: number, akahuId: string) => ({
    akahu_id: akahuId,
    formatted_account: `00-SENT-000000${n}-00`,
    connection_id: `conn_sentinel_${n}`,
    connection_name: 'Sentinel Bank 91c2',
  })
  await insertAll('accounts', [
    account({
      id: 1,
      ...sentinel(1, EVERYDAY),
      name: 'Sentinel Everyday',
      scope: 'personal',
      balance_cents: 250000,
    }),
    account({
      id: 2,
      ...sentinel(2, TRADING),
      name: 'Sentinel Trading',
      scope: 'strawb',
      balance_cents: 600000,
    }),
  ])
}

// Noon NZ or later on each October day: the NZ date is the UTC date.
//
// personal: Groceries 2310 + 1205 (pending) = 3515, Cafes 450,
//   uncategorised 615; income and a refund are not spending. Total 4580.
// strawb: Software 4400, Groceries 1100. Total 5500.
// all: Groceries 4615, Software 4400, Cafes 450, uncategorised 615.
//   Total 10080.
async function seed() {
  await seedAccounts()
  await insertAll('transactions', [
    tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -2310, { category: GROCER }),
    tx(EVERYDAY, '2026-10-06T00:00:00.000Z', -1205, {
      category: GROCER,
      status: 'pending',
    }),
    tx(EVERYDAY, '2026-10-07T00:00:00.000Z', -450, { category: CAFE }),
    tx(EVERYDAY, '2026-10-08T00:00:00.000Z', -615),
    tx(EVERYDAY, '2026-10-09T00:00:00.000Z', 90000),
    tx(EVERYDAY, '2026-10-10T00:00:00.000Z', 300, { category: CAFE }),
    tx(TRADING, '2026-10-12T00:00:00.000Z', -4400, { category: SOFTWARE }),
    tx(TRADING, '2026-10-13T00:00:00.000Z', -1100, { category: GROCER }),
    // Not read: a Xero row, a row on an unstored account, last month.
    tx(EVERYDAY, '2026-10-14T00:00:00.000Z', -77777, {
      category: GROCER,
      source: 'xero',
    }),
    tx(UNSTORED, '2026-10-14T00:00:00.000Z', -88888, { category: GROCER }),
    tx(EVERYDAY, '2026-09-15T00:00:00.000Z', -55555, { category: GROCER }),
  ])
}

const get = (query: string) =>
  api.get(`/api/v1/spending/categories${query}`)

const body = (res: { body: unknown }) =>
  res.body as SpendingByCategoryResponse

const RESPONSE_KEYS: Record<keyof SpendingByCategoryResponse, true> = {
  scope: true,
  month: true,
  totalCents: true,
  categories: true,
  otherCents: true,
  uncategorisedCents: true,
}
const LINE_KEYS: Record<keyof SpendingCategoryLine, true> = {
  category: true,
  spentCents: true,
}

describe('GET /api/v1/spending/categories', () => {
  it('defaults to this NZ month and answers the contract', async () => {
    await seed()

    const res = await get('?scope=all')

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(
      Object.keys(RESPONSE_KEYS).sort(),
    )
    for (const line of body(res).categories) {
      expect(Object.keys(line).sort()).toEqual(Object.keys(LINE_KEYS).sort())
    }
    expect(res.body).toStrictEqual({
      scope: 'all',
      month: '2026-10',
      totalCents: 10080,
      categories: [
        { category: GROCER, spentCents: 4615 },
        { category: SOFTWARE, spentCents: 4400 },
        { category: CAFE, spentCents: 450 },
      ],
      otherCents: 0,
      uncategorisedCents: 615,
    })
  })

  it('defaults to November once it is 1 November in NZ, still 31 October in UTC', async () => {
    vi.setSystemTime('2026-10-31T11:30:00.000Z')
    await seedAccounts()
    await insertAll('transactions', [
      // 00:15 NZDT on 1 November.
      tx(EVERYDAY, '2026-10-31T11:15:00.000Z', -777, { category: CAFE }),
    ])

    const res = await get('?scope=personal')

    expect(body(res).month).toBe('2026-11')
    expect(body(res).totalCents).toBe(777)
  })

  it('personal and strawb keep to their own accounts; all is both', async () => {
    await seed()

    const personal = body(await get('?scope=personal'))
    const strawb = body(await get('?scope=strawb'))

    expect(personal).toStrictEqual({
      scope: 'personal',
      month: '2026-10',
      totalCents: 4580,
      categories: [
        { category: GROCER, spentCents: 3515 },
        { category: CAFE, spentCents: 450 },
      ],
      otherCents: 0,
      uncategorisedCents: 615,
    })
    expect(strawb).toStrictEqual({
      scope: 'strawb',
      month: '2026-10',
      totalCents: 5500,
      categories: [
        { category: SOFTWARE, spentCents: 4400 },
        { category: GROCER, spentCents: 1100 },
      ],
      otherCents: 0,
      uncategorisedCents: 0,
    })
  })

  it('counts the category the user set, not the one Akahu sent', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -1234, {
        category: GROCER,
        category_source: 'user',
        akahu_category_name: CAFE,
      }),
    ])

    expect(body(await get('?scope=personal')).categories).toStrictEqual([
      { category: GROCER, spentCents: 1234 },
    ])
  })

  it('a future month answers zeros', async () => {
    await seed()

    expect(body(await get('?scope=all&month=2027-03'))).toStrictEqual({
      scope: 'all',
      month: '2027-03',
      totalCents: 0,
      categories: [],
      otherCents: 0,
      uncategorisedCents: 0,
    })
  })
})

describe('drawings are not spending (prd-02 Ruling 15)', () => {
  // A strawb out-half on the 15th and its personal in-half on the 16th:
  // inside the matcher's window, so both halves are a drawing.
  async function seedDrawing(outFields: Row = {}) {
    await seedAccounts()
    await insertAll('transactions', [
      tx(TRADING, '2026-10-15T00:00:00.000Z', -25000, {
        category: 'Transfers Invented',
        ...outFields,
      }),
      tx(EVERYDAY, '2026-10-16T00:00:00.000Z', 25000),
      tx(TRADING, '2026-10-17T00:00:00.000Z', -4400, { category: SOFTWARE }),
    ])
  }

  it('leaves the strawb half out of strawb and all', async () => {
    await seedDrawing()

    for (const scope of ['all', 'strawb']) {
      const r = body(await get(`?scope=${scope}`))
      expect(r.categories, scope).toStrictEqual([
        { category: SOFTWARE, spentCents: 4400 },
      ])
      expect(r.totalCents, scope).toBe(4400)
    }
  })

  it('counts the same half under the category the user set by hand', async () => {
    await seedDrawing({ category: SOFTWARE, category_source: 'user' })

    // 25000 + 4400.
    expect(body(await get('?scope=strawb')).categories).toStrictEqual([
      { category: SOFTWARE, spentCents: 29400 },
    ])
  })

  it('leaves out a row the user tagged Drawings that matched nothing', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -3333, {
        category: 'Drawings',
        category_source: 'user',
      }),
      tx(EVERYDAY, '2026-10-06T00:00:00.000Z', -100, { category: CAFE }),
    ])

    expect(body(await get('?scope=personal')).totalCents).toBe(100)
  })
})

describe('the NZ month decides, at both edges', () => {
  // NZDT (UTC+13) from 27 September 2026; NZST (UTC+12) in June.
  async function seedEdges() {
    await seedAccounts()
    await insertAll('transactions', [
      tx(EVERYDAY, '2026-09-30T10:59:59.000Z', -1, { category: CAFE }),
      tx(EVERYDAY, '2026-09-30T11:00:00.000Z', -20, { category: CAFE }),
      tx(EVERYDAY, '2026-10-31T10:59:59.000Z', -300, { category: CAFE }),
      tx(EVERYDAY, '2026-10-31T11:00:00.000Z', -4000, { category: CAFE }),
      tx(EVERYDAY, '2026-06-30T11:59:59.000Z', -5, { category: CAFE }),
      tx(EVERYDAY, '2026-06-30T12:00:00.000Z', -60000, { category: CAFE }),
    ])
  }

  it.each([
    ['2026-09', 1],
    // 20 + 300.
    ['2026-10', 320],
    ['2026-11', 4000],
    ['2026-06', 5],
    ['2026-07', 60000],
  ])('%s holds %d', async (month, cents) => {
    await seedEdges()

    expect(body(await get(`?scope=personal&month=${month}`)).totalCents).toBe(
      cents,
    )
  })
})

describe('top', () => {
  async function seedSeven() {
    await seedAccounts()
    await insertAll(
      'transactions',
      [700, 600, 500, 400, 300, 200, 100].map((cents, i) =>
        tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -cents, {
          category: `${'ABCDEFG'[i]} Invented`,
        }),
      ),
    )
  }

  it('top=5 of seven lists five and folds two into other', async () => {
    await seedSeven()

    const r = body(await get('?scope=personal&top=5'))

    expect(r.categories.map((l) => l.category)).toEqual([
      'A Invented',
      'B Invented',
      'C Invented',
      'D Invented',
      'E Invented',
    ])
    // F 200 + G 100.
    expect(r.otherCents).toBe(300)
    expect(r.totalCents).toBe(2800)
  })

  it('without top lists all seven and other is 0', async () => {
    await seedSeven()

    const r = body(await get('?scope=personal'))

    expect(r.categories).toHaveLength(7)
    expect(r.otherCents).toBe(0)
  })

  it('orders equal amounts by code point, not by insertion', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -500, { category: 'b Invented' }),
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -500, { category: 'B Invented' }),
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -500, { category: 'a Invented' }),
    ])

    expect(
      body(await get('?scope=personal')).categories.map((l) => l.category),
    ).toEqual(['B Invented', 'a Invented', 'b Invented'])
  })
})

describe('refusals are fixed text', () => {
  const SCOPE = 'scope must be all, personal or strawb'
  const MONTH = 'month must be YYYY-MM'
  const TOP = 'top must be a whole number from 1 to 50'

  it.each([
    ['scope missing', '', SCOPE],
    ['scope unknown', '?scope=x', SCOPE],
    ['scope repeated', '?scope=all&scope=all', SCOPE],
    ['month 13', '?scope=all&month=2026-13', MONTH],
    ['month one digit', '?scope=all&month=2026-1', MONTH],
    ['month not a month', '?scope=all&month=abc', MONTH],
    ['month empty', '?scope=all&month=', MONTH],
    ['month repeated', '?scope=all&month=2026-10&month=2026-10', MONTH],
    ['top 0', '?scope=all&top=0', TOP],
    ['top 51', '?scope=all&top=51', TOP],
    ['top 1.5', '?scope=all&top=1.5', TOP],
    ['top not a number', '?scope=all&top=abc', TOP],
    ['top repeated', '?scope=all&top=5&top=5', TOP],
  ])('%s is a 400', async (_why, query, error) => {
    const res = await get(query)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
  })

  it('top=50 and top=1 are accepted', async () => {
    expect((await get('?scope=all&top=50')).status).toBe(200)
    expect((await get('?scope=all&top=1')).status).toBe(200)
  })
})

describe('the payload', () => {
  it('holds no account id, account number, connection, account name or description', async () => {
    await seed()

    for (const scope of ['all', 'personal', 'strawb']) {
      const res = await get(`?scope=${scope}`)
      expect(res.status).toBe(200)
      for (const token of SECRET_TOKENS)
        expect(res.text, `${scope}: ${token}`).not.toContain(token)
    }
    // The categories are there, so the check above is not vacuous.
    expect((await get('?scope=all')).text).toContain(GROCER)
  })
})

describe('errors', () => {
  it('a matcher failure is a 500 spending input invalid, logging only the class', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    vi.mocked(drawings.loadDrawingIds).mockRejectedValueOnce(
      new RangeError('candidate 42 appears twice'),
    )

    const res = await get('?scope=all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'spending input invalid' })
    expect(res.text).not.toContain('42')
    expect(error.mock.calls).toStrictEqual([
      ['spending: could not read spending by category', 'SpendingDataError'],
    ])
  })

  it('a row with no date is a 500 a transaction is incomplete', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedAccounts()
    await insertAll('transactions', [
      tx(EVERYDAY, null, -100, { category: CAFE }),
    ])

    const res = await get('?scope=all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
    expect(error.mock.calls).toStrictEqual([
      ['spending: could not read spending by category', 'SpendingDataError'],
    ])
  })

  it('POST is the app’s 404', async () => {
    const res = await api.post('/api/v1/spending/categories').send({})

    expect(res.status).toBe(404)
  })
})

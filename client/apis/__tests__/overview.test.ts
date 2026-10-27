import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import connection from '../../../server/db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../server/test-utils/app.ts'

// Contract test (issue 45): the Overview's real request functions against
// the real Express app over an in-memory database, so the method, path and
// payload the client sends are the ones the server accepts, and a refusal
// reaches the screen as the server's own message. Every value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../overview.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // overview.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../overview.ts')
})

beforeEach(async () => {
  await freshApp()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await served?.close()
  await closeDb()
  delete (globalThis as { document?: unknown }).document
})

const STAMP = '2026-10-20T00:00:00.000Z'

// A settled transaction on an invented personal account, as sync stores
// them: the transaction's account_id is the account's Akahu id.
async function seedTransaction(): Promise<string> {
  await connection('accounts').insert({
    source: 'akahu',
    akahu_id: 'acc_invented_1',
    scope: 'personal',
    name: 'Everyday Invented',
    balance_cents: 10000,
    created_at: STAMP,
    updated_at: STAMP,
  })
  const [id] = await connection('transactions').insert({
    account_id: 'acc_invented_1',
    date: STAMP,
    amount_cents: -940,
    description: 'Cafe Invented',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
  })
  return String(id)
}

const OVERVIEW_KEYS = [
  'safeToSpend',
  'accounts',
  'alerts',
  'recentActivity',
  'dataAsOf',
]

describe('grabOverview', () => {
  it('answers the overview contract for the scope asked', async () => {
    const body = await api.grabOverview('all')

    expect(Object.keys(body).sort()).toEqual([...OVERVIEW_KEYS].sort())
    expect(body.safeToSpend.scope).toBe('all')
    expect(body.accounts).toEqual([])
    expect(body.alerts).toEqual([])
    expect(body.recentActivity).toEqual([])
    expect((await api.grabOverview('strawb')).safeToSpend.scope).toBe('strawb')
  })
})

describe('grabCategoryGroups', () => {
  it('answers the groups the update route accepts', async () => {
    const groups = await api.grabCategoryGroups()

    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect(Object.keys(group).sort()).toEqual(['categories', 'name'])
      expect(typeof group.name).toBe('string')
      expect(Array.isArray(group.categories)).toBe(true)
    }
  })
})

describe('setTransactionCategory', () => {
  it('persists the user category, which the next overview read shows', async () => {
    const id = await seedTransaction()
    const groups = await api.grabCategoryGroups()
    const category = groups[0].categories[0]

    const answer = await api.setTransactionCategory(id, category)

    expect(answer.transaction.category).toBe(category)
    const [row] = (await api.grabOverview('all')).recentActivity
    expect(row.id).toBe(id)
    expect(row.category).toBe(category)
    expect(row.categorySource).toBe('user')
  })

  it('rejects an unknown transaction with the server message', async () => {
    await expect(
      api.setTransactionCategory('999999', 'Supermarkets and grocery stores'),
    ).rejects.toThrow(new Error('Transaction not found'))
  })

  it('rejects a category that is not listed with the server message', async () => {
    const id = await seedTransaction()

    await expect(
      api.setTransactionCategory(id, 'Not A Category Invented'),
    ).rejects.toThrow(
      new Error('category must be one of GET /api/v1/categories'),
    )
  })
})

describe('dismissOverviewAlert', () => {
  it('sends the colon id encoded, and the route reaches its lookup', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')

    // 404 "Alert not found" is the lookup's answer: an id the route refused
    // by shape would be 400 "Invalid alert id". Express decodes the path
    // either way, so only the URL assertion below guards the encoding.
    await expect(
      api.dismissOverviewAlert('bill_overdue:1:2026-10-20'),
    ).rejects.toThrow(new Error('Alert not found'))
    expect(String(spy.mock.calls[0][0])).toContain(
      '/api/v1/overview/alerts/bill_overdue%3A1%3A2026-10-20/dismiss',
    )
    expect(spy.mock.calls[0][1]?.method).toBe('POST')
  })
})

describe('grabSpendingByCategory', () => {
  const SPENDING_KEYS = [
    'scope',
    'month',
    'totalCents',
    'categories',
    'otherCents',
    'uncategorisedCents',
  ]

  it('asks for the scope and the card’s top, and the route answers the contract', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')

    const body = await api.grabSpendingByCategory('personal')

    const url = new URL(String(spy.mock.calls[0][0]))
    expect(url.pathname).toBe('/api/v1/spending/categories')
    expect([...url.searchParams]).toEqual([
      ['scope', 'personal'],
      ['top', String(api.SPENDING_CARD_TOP)],
    ])
    expect(api.SPENDING_CARD_TOP).toBe(5)
    expect(Object.keys(body).sort()).toEqual([...SPENDING_KEYS].sort())
    expect(body.scope).toBe('personal')
    // An empty database: zeros for whatever this month is. The route test
    // pins the arithmetic against a fixed clock.
    expect(body.month).toMatch(/^\d{4}-\d{2}$/)
    expect([
      body.totalCents,
      body.categories,
      body.otherCents,
      body.uncategorisedCents,
    ]).toStrictEqual([0, [], 0, 0])
  })

  it('is keyed under the overview’s scoped key, so invalidateOverview reaches it', () => {
    expect(api.spendingByCategoryQuery('strawb').queryKey).toEqual([
      'overview',
      'strawb',
      'spending',
    ])
  })
})

describe('when the server cannot answer', () => {
  it('says the server could not be reached when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )

    await expect(api.grabOverview('all')).rejects.toThrow(
      new Error('The server could not be reached'),
    )
  })

  it('gives the status when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('<html>oops</html>', { status: 500 })),
      ),
    )

    await expect(api.grabOverview('all')).rejects.toThrow(
      new Error('Server error (500)'),
    )
  })

  it('gives the status when the error body has no error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 42 }), { status: 502 }),
        ),
      ),
    )

    await expect(api.grabOverview('all')).rejects.toThrow(
      new Error('Server error (502)'),
    )
  })
})

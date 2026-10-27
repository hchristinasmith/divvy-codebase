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
import { QueryClient } from '@tanstack/react-query'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../../server/test-utils/app.ts'
import type { CreateBudgetRequest } from '../../../../shared/contracts.ts'

// Tests client/apis/budgets.ts; it lives here, not in client/apis/__tests__,
// because issue 53's fence is client/screens/Budgets and that one file.
//
// Contract test: the Budgets screen's real request functions against the
// real Express app over an in-memory database, so the method, path and
// payload the client sends are the ones the server accepts, and a refusal
// reaches the screen as the server's own message. Setup copied from
// ../../Bills/__tests__/billsApi.test.ts. The clock is fixed, as in
// server/routes/__tests__/budgets.test.ts: 23:30 UTC on Tuesday 27 October
// 2026 is Wednesday the 28th in NZ, so the period is 10-27 to 11-03. Every
// value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../../../apis/budgets.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // budgets.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../../../apis/budgets.ts')
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2026-10-27T23:30:00.000Z')
  await freshApp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await served?.close()
  await closeDb()
  delete (globalThis as { document?: unknown }).document
})

const BUDGET_KEYS = [
  'category',
  'id',
  'limitCents',
  'note',
  'overCents',
  'remainingCents',
  'scope',
  'spentCents',
]

const LIST_KEYS = ['items', 'periodEnd', 'periodStart']

// Known NZFCC categories (data/cats.js), since a budget must name one.
const GROCERIES = 'Supermarkets and grocery stores'
const BAKERIES = 'Bakeries'

function newBudget(fields: Partial<CreateBudgetRequest> = {}): CreateBudgetRequest {
  return { scope: 'personal', category: GROCERIES, limitCents: 15000, ...fields }
}

describe('createBudget and grabBudgets', () => {
  it('creates a budget and answers its line in the budget shape', async () => {
    const created = await api.createBudget(newBudget({ note: 'Invented: the shop' }))

    expect(Object.keys(created).sort()).toEqual(BUDGET_KEYS)
    expect(created).toMatchObject({
      scope: 'personal',
      category: GROCERIES,
      limitCents: 15000,
      spentCents: 0,
      remainingCents: 15000,
      overCents: 0,
      note: 'Invented: the shop',
    })
  })

  it('lists the budgets for a scope in the list shape, with the period', async () => {
    const created = await api.createBudget(newBudget())
    await api.createBudget(newBudget({ scope: 'strawb', category: BAKERIES }))

    const body = await api.grabBudgets('personal')

    expect(Object.keys(body).sort()).toEqual(LIST_KEYS)
    expect(body.items).toEqual([created])
    expect(body.periodStart).toBe('2026-10-27')
    expect(body.periodEnd).toBe('2026-11-03')
    expect((await api.grabBudgets('all')).items).toHaveLength(2)
  })

  it('rejects a second budget for the category in that scope with the server message', async () => {
    await api.createBudget(newBudget())

    await expect(api.createBudget(newBudget({ limitCents: 999 }))).rejects.toThrow(
      new Error('A budget for that category already exists in this scope'),
    )
  })
})

describe('updateBudget', () => {
  it('sets the new absolute limit the step sends', async () => {
    const created = await api.createBudget(newBudget())

    const updated = await api.updateBudget(created.id, { limitCents: 16000 })

    expect(updated).toEqual({ ...created, limitCents: 16000, remainingCents: 16000 })
  })

  it('rejects a budget that is gone with the server message', async () => {
    await expect(api.updateBudget('999', { limitCents: 1000 })).rejects.toThrow(
      new Error('Budget not found'),
    )
  })
})

describe('removeBudget', () => {
  it('deletes a budget, answering nothing', async () => {
    const created = await api.createBudget(newBudget())

    await expect(api.removeBudget(created.id)).resolves.toBeUndefined()

    expect((await api.grabBudgets('all')).items).toEqual([])
    await expect(api.removeBudget(created.id)).rejects.toThrow(
      new Error('Budget not found'),
    )
  })
})

describe('failures with no server message', () => {
  it('says the server could not be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))

    await expect(api.grabBudgets('all')).rejects.toThrow(
      new Error('The server could not be reached'),
    )
  })

  it('gives the status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('upstream broke', { status: 500 })),
    )

    await expect(api.removeBudget('1')).rejects.toThrow(new Error('Server error (500)'))
  })
})

describe('the budget path', () => {
  it('escapes the id in every request that names a budget', async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : new Response('{}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    )
    vi.stubGlobal('fetch', fetch)

    await api.updateBudget('a/b', { limitCents: 1000 })
    await api.removeBudget('a/b')

    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/budgets/a%2Fb',
      '/api/v1/budgets/a%2Fb',
    ])
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['PATCH', 'DELETE'])
  })
})

describe('the budgets query', () => {
  it('is keyed by domain then scope', () => {
    expect(api.budgetsQuery('strawb').queryKey).toEqual(['budgets', 'strawb'])
  })

  it('invalidateBudgets reaches every cached budgets scope and the overview in every scope', async () => {
    const client = new QueryClient()
    const empty = { items: [], periodStart: '2026-10-27', periodEnd: '2026-11-03' }
    const personal = api.budgetsQuery('personal').queryKey
    const strawb = api.budgetsQuery('strawb').queryKey
    client.setQueryData(personal, empty)
    client.setQueryData(strawb, empty)
    client.setQueryData(['overview', 'all'], {})
    client.setQueryData(['overview', 'strawb'], {})
    client.setQueryData(['bills', 'all'], {})

    await api.invalidateBudgets(client)

    expect(client.getQueryState(personal)?.isInvalidated).toBe(true)
    expect(client.getQueryState(strawb)?.isInvalidated).toBe(true)
    expect(client.getQueryState(['overview', 'all'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['overview', 'strawb'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['bills', 'all'])?.isInvalidated).toBe(false)
    client.clear()
  })
})

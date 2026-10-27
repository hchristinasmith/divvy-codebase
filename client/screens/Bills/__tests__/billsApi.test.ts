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
import connection from '../../../../server/db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../../server/test-utils/app.ts'
import type { CreateBillRequest } from '../../../../shared/contracts.ts'

// Tests client/apis/bills.ts; it lives here, not in client/apis/__tests__,
// because issue 54's fence is client/screens/Bills and that one file.
//
// Contract test: the Bills screen's real request functions against the real
// Express app over an in-memory database, so the method, path and payload
// the client sends are the ones the server accepts, and a refusal reaches
// the screen as the server's own message. Setup copied from
// client/apis/__tests__/subscriptions.test.ts. The clock is fixed, as in
// server/routes/__tests__/bills.test.ts: 23:30 UTC on Tuesday 27 October
// 2026 is Wednesday the 28th in NZ. Every value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../../../apis/bills.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // bills.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../../../apis/bills.ts')
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

const STAMP = '2026-10-20T00:00:00.000Z'

const BILL_KEYS = [
  'accountName',
  'amountCents',
  'dueDate',
  'firstDueDate',
  'id',
  'name',
  'paid',
  'paidAt',
  'repeat',
  'scope',
]

const LIST_KEYS = ['dueBeforePaydayCents', 'items', 'nextBill', 'paidThisMonthCents']

async function seedAccounts(): Promise<void> {
  await connection('accounts').insert([
    {
      id: 1,
      source: 'akahu',
      akahu_id: 'acc_invented_everyday',
      scope: 'personal',
      name: 'Test Everyday',
      balance_cents: 10000,
      created_at: STAMP,
      updated_at: STAMP,
    },
    {
      id: 2,
      source: 'akahu',
      akahu_id: 'acc_invented_trading',
      scope: 'strawb',
      name: 'Test Trading',
      balance_cents: 20000,
      created_at: STAMP,
      updated_at: STAMP,
    },
  ])
}

function newBill(fields: Partial<CreateBillRequest> = {}): CreateBillRequest {
  return {
    scope: 'personal',
    name: 'Invented Power Co',
    amountCents: 12345,
    firstDueDate: '2026-11-01',
    repeat: 'monthly',
    ...fields,
  }
}

describe('createBill and grabBills', () => {
  it.each(['none', 'weekly', 'monthly', 'yearly'] as const)(
    'creates a %s bill and answers it in the bill shape',
    async (repeat) => {
      const created = await api.createBill(newBill({ repeat }))

      expect(Object.keys(created).sort()).toEqual(BILL_KEYS)
      expect(created).toMatchObject({
        scope: 'personal',
        name: 'Invented Power Co',
        amountCents: 12345,
        firstDueDate: '2026-11-01',
        dueDate: '2026-11-01',
        repeat,
        paid: false,
        paidAt: null,
        accountName: null,
      })
    },
  )

  it('lists the bills for a scope in the list shape', async () => {
    const created = await api.createBill(newBill())
    await api.createBill(newBill({ scope: 'strawb', name: 'Invented Hosting' }))

    const body = await api.grabBills('personal')

    expect(Object.keys(body).sort()).toEqual(LIST_KEYS)
    expect(body.items).toHaveLength(1)
    expect(Object.keys(body.items[0]).sort()).toEqual(BILL_KEYS)
    expect(body.items[0]).toEqual(created)
    expect(body.nextBill).toEqual(created)
    expect(Number.isInteger(body.dueBeforePaydayCents)).toBe(true)
    expect(body.paidThisMonthCents).toBe(0)
    expect((await api.grabBills('all')).items).toHaveLength(2)
  })

  it('names the account an in-scope account id points at', async () => {
    await seedAccounts()

    const created = await api.createBill(newBill({ accountId: '1' }))

    expect(created.accountName).toBe('Test Everyday')
  })

  it('rejects an account of the other scope, or none at all, with the server message', async () => {
    await seedAccounts()

    await expect(api.createBill(newBill({ accountId: '2' }))).rejects.toThrow(
      new Error('accountId must be an account in the same scope as the bill'),
    )
    await expect(api.createBill(newBill({ accountId: '99' }))).rejects.toThrow(
      new Error('accountId does not match an account'),
    )
  })
})

describe('updateBill', () => {
  it('changes only the amount when only the amount is sent', async () => {
    const created = await api.createBill(newBill())

    const updated = await api.updateBill(created.id, { amountCents: 54321 })

    expect(updated).toEqual({ ...created, amountCents: 54321 })
  })

  it('detaches the account with null', async () => {
    await seedAccounts()
    const created = await api.createBill(newBill({ accountId: '1' }))

    const updated = await api.updateBill(created.id, { accountId: null })

    expect(updated.accountName).toBeNull()
  })

  it('rejects a new repeat once the bill has payments', async () => {
    const created = await api.createBill(newBill())
    await api.markBillPaid(created.id)

    await expect(api.updateBill(created.id, { repeat: 'weekly' })).rejects.toThrow(
      new Error('Bill has payments, so its first due date and repeat cannot be changed'),
    )
  })
})

describe('markBillPaid', () => {
  it('pays a one-off, then refuses to pay it again', async () => {
    const created = await api.createBill(newBill({ repeat: 'none' }))

    const { bill } = await api.markBillPaid(created.id)

    expect(Object.keys(bill).sort()).toEqual(BILL_KEYS)
    expect(bill.paid).toBe(true)
    expect(bill.paidAt).not.toBeNull()
    await expect(api.markBillPaid(created.id)).rejects.toThrow(
      new Error('This bill is already paid'),
    )
  })

  it('moves a monthly bill on to its next due date, still unpaid', async () => {
    const created = await api.createBill(newBill({ repeat: 'monthly' }))

    const { bill } = await api.markBillPaid(created.id)

    expect(bill.paid).toBe(false)
    expect(bill.dueDate).toBe('2026-12-01')
  })

  it('sends no body', async () => {
    const created = await api.createBill(newBill())
    const spy = vi.spyOn(globalThis, 'fetch')

    await api.markBillPaid(created.id)

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toMatch(new RegExp(`/api/v1/bills/${created.id}/payments$`))
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
  })
})

describe('removeBill', () => {
  it('deletes a bill with no payments, answering nothing', async () => {
    const created = await api.createBill(newBill())

    await expect(api.removeBill(created.id)).resolves.toBeUndefined()

    expect((await api.grabBills('all')).items).toEqual([])
  })

  it('rejects once the bill has payments', async () => {
    const created = await api.createBill(newBill())
    await api.markBillPaid(created.id)

    await expect(api.removeBill(created.id)).rejects.toThrow(
      new Error('Bill has payments, so it cannot be deleted'),
    )
  })
})

describe('failures with no server message', () => {
  it('says the server could not be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))

    await expect(api.grabBills('all')).rejects.toThrow(
      new Error('The server could not be reached'),
    )
  })

  it('gives the status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('upstream broke', { status: 500 })),
    )

    await expect(api.removeBill('1')).rejects.toThrow(new Error('Server error (500)'))
  })
})

describe('the bill path', () => {
  // A stubbed fetch, so the id never reaches the server: only the path the
  // client builds is under test.
  function stubFetch() {
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
    return fetch
  }

  function requested(fetch: ReturnType<typeof stubFetch>): string[] {
    return fetch.mock.calls.map(([url]) => new URL(url).pathname)
  }

  it('escapes the id in every request that names a bill', async () => {
    const fetch = stubFetch()

    await api.updateBill('a/b', { name: 'Invented' })
    await api.removeBill('a/b')
    await api.markBillPaid('a/b')

    expect(requested(fetch)).toEqual([
      '/api/v1/bills/a%2Fb',
      '/api/v1/bills/a%2Fb',
      '/api/v1/bills/a%2Fb/payments',
    ])
  })
})

describe('the bills query', () => {
  it('is keyed by domain then scope', () => {
    expect(api.billsQuery('strawb').queryKey).toEqual(['bills', 'strawb'])
    expect(api.billAccountsQuery.queryKey).toEqual(['settings', 'accounts'])
  })

  it('invalidateBills reaches every cached bills scope and the overview', async () => {
    const client = new QueryClient()
    const personal = api.billsQuery('personal').queryKey
    const strawb = api.billsQuery('strawb').queryKey
    client.setQueryData(personal, {
      items: [],
      dueBeforePaydayCents: 0,
      nextBill: null,
      paidThisMonthCents: 0,
    })
    client.setQueryData(strawb, {
      items: [],
      dueBeforePaydayCents: 0,
      nextBill: null,
      paidThisMonthCents: 0,
    })
    client.setQueryData(['overview', 'all'], {})
    client.setQueryData(['subscriptions', 'all'], {})

    await api.invalidateBills(client)

    expect(client.getQueryState(personal)?.isInvalidated).toBe(true)
    expect(client.getQueryState(strawb)?.isInvalidated).toBe(true)
    expect(client.getQueryState(['overview', 'all'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['subscriptions', 'all'])?.isInvalidated).toBe(false)
    client.clear()
  })
})

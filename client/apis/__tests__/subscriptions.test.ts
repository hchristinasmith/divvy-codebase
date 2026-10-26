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
import connection from '../../../server/db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../server/test-utils/app.ts'

// Contract test (issue 230): the Subscriptions screen's real request
// functions against the real Express app over an in-memory database, so the
// method, path and payload the client sends are the ones the server
// accepts, and a refusal reaches the screen as the server's own message.
// The clock is fixed, as in server/routes/__tests__/subscriptions.test.ts,
// so detection does not drift with the real date. Every value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../subscriptions.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // subscriptions.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../subscriptions.ts')
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
const ACCOUNT = 'acc_invented_everyday'
const STREAM = 'm:merchant_invented_stream'
const CLOUD = 'm:merchant_invented_cloud'

// The transaction shape of `tx` in server/routes/__tests__/subscriptions.test.ts.
function tx(date: string, amountCents: number, fields: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    date,
    amount_cents: amountCents,
    description: 'EXAMPLE STREAM 0000',
    merchant_id: 'merchant_invented_stream',
    merchant_name: 'Example Stream',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

// One personal account: Example Stream, three monthly charges (detected),
// and Example Cloud Storage, one charge with a hint name (a question).
async function seed(): Promise<void> {
  await connection('accounts').insert({
    id: 1,
    source: 'akahu',
    akahu_id: ACCOUNT,
    scope: 'personal',
    name: 'Everyday Invented',
    balance_cents: 10000,
    created_at: STAMP,
    updated_at: STAMP,
  })
  for (const row of [
    tx('2026-07-01T00:00:00.000Z', -1599),
    tx('2026-07-31T00:00:00.000Z', -1599),
    tx('2026-08-30T00:00:00.000Z', -1599),
    tx('2026-10-01T00:00:00.000Z', -299, {
      merchant_id: 'merchant_invented_cloud',
      merchant_name: 'Example Cloud Storage',
      description: 'EXAMPLE CLOUD',
    }),
  ]) {
    // One insert per row, so a row's missing keys take the column defaults.
    await connection('transactions').insert(row)
  }
}

const STREAM_TARGET = { scope: 'personal', merchantKey: STREAM } as const

describe('grabSubscriptions', () => {
  it('answers the subscriptions contract for the scope asked', async () => {
    await seed()

    const body = await api.grabSubscriptions('personal')

    expect(Object.keys(body).sort()).toEqual(
      ['notSubscriptions', 'questions', 'subscriptions', 'totals'].sort(),
    )
    expect(Object.keys(body.totals).sort()).toEqual(
      [
        'countedCount',
        'perMonthCents',
        'perYearCents',
        'possiblyStoppedCount',
        'uncountedCount',
      ].sort(),
    )
    expect(body.subscriptions.map((r) => [r.merchantKey, r.status])).toEqual([
      [STREAM, 'active'],
    ])
    expect(body.questions.map((q) => q.merchantKey)).toEqual([CLOUD])
    expect(body.notSubscriptions).toEqual([])
    expect((await api.grabSubscriptions('strawb')).subscriptions).toEqual([])
  })
})

describe('markSubscription', () => {
  it('not_subscription moves the merchant out of the list; null brings it back', async () => {
    await seed()

    await api.markSubscription(STREAM_TARGET, 'not_subscription')
    const marked = await api.grabSubscriptions('personal')
    expect(marked.subscriptions).toEqual([])
    expect(marked.notSubscriptions.map((m) => m.merchantKey)).toEqual([STREAM])

    const cleared = await api.markSubscription(STREAM_TARGET, null)
    expect(cleared.answer).toBeNull()
    const back = await api.grabSubscriptions('personal')
    expect(back.subscriptions.map((r) => r.merchantKey)).toEqual([STREAM])
    expect(back.notSubscriptions).toEqual([])
  })

  it('subscription moves a question into the list', async () => {
    await seed()

    await api.markSubscription({ scope: 'personal', merchantKey: CLOUD }, 'subscription')

    const body = await api.grabSubscriptions('personal')
    expect(body.questions).toEqual([])
    expect(body.subscriptions.map((r) => r.merchantKey).sort()).toEqual(
      [CLOUD, STREAM].sort(),
    )
  })

  it('rejects an unknown merchant with the server message', async () => {
    await seed()

    await expect(
      api.markSubscription(
        { scope: 'personal', merchantKey: 'm:merchant_invented_nobody' },
        'subscription',
      ),
    ).rejects.toThrow(new Error('Merchant not found'))
  })
})

describe('cancelSubscription and uncancelSubscription', () => {
  it('cancel records a date the server chose; uncancel clears it', async () => {
    await seed()

    const stored = await api.cancelSubscription(STREAM_TARGET)
    expect(stored.cancelledOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const [cancelled] = (await api.grabSubscriptions('personal')).subscriptions
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledOn).toBe(stored.cancelledOn)

    const cleared = await api.uncancelSubscription(STREAM_TARGET)
    expect(cleared.cancelledOn).toBeNull()
    const [active] = (await api.grabSubscriptions('personal')).subscriptions
    expect(active.status).toBe('active')
    expect(active.cancelledOn).toBeNull()
  })

  it('cancel sends only the scope and merchant', async () => {
    await seed()
    const spy = vi.spyOn(globalThis, 'fetch')

    await api.cancelSubscription(STREAM_TARGET)

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/v1\/subscriptions\/cancel$/)
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['merchantKey', 'scope'])
  })

  it('rejects an unknown merchant with the server message', async () => {
    await seed()

    await expect(
      api.cancelSubscription({ scope: 'personal', merchantKey: 'm:merchant_invented_nobody' }),
    ).rejects.toThrow(new Error('Merchant not found'))
    await expect(
      api.uncancelSubscription({
        scope: 'personal',
        merchantKey: 'm:merchant_invented_nobody',
      }),
    ).rejects.toThrow(new Error('Merchant not found'))
  })
})

describe('the subscriptions query', () => {
  it('is keyed by domain then scope', () => {
    expect(api.subscriptionsQuery('strawb').queryKey).toEqual([
      'subscriptions',
      'strawb',
    ])
    expect(api.SUBSCRIPTIONS_KEY).toEqual(['subscriptions'])
  })

  it('invalidateSubscriptions reaches every cached scope', async () => {
    const client = new QueryClient()
    const personal = api.subscriptionsQuery('personal').queryKey
    const strawb = api.subscriptionsQuery('strawb').queryKey
    const empty = {
      subscriptions: [],
      questions: [],
      notSubscriptions: [],
      totals: {
        perMonthCents: 0,
        perYearCents: 0,
        countedCount: 0,
        uncountedCount: 0,
        possiblyStoppedCount: 0,
      },
    }
    client.setQueryData(personal, empty)
    client.setQueryData(strawb, empty)
    client.setQueryData(['overview', 'all'], {})

    await api.invalidateSubscriptions(client)

    expect(client.getQueryState(personal)?.isInvalidated).toBe(true)
    expect(client.getQueryState(strawb)?.isInvalidated).toBe(true)
    expect(client.getQueryState(['overview', 'all'])?.isInvalidated).toBe(false)
    client.clear()
  })
})

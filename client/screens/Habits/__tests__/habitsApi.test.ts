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
import type { Scope } from '../../../../shared/contracts.ts'

// Tests client/apis/habits.ts; it lives here, not in client/apis/__tests__,
// because issue 57's fence is client/screens/Habits and that one file.
//
// Contract test: the Habits screen's real request functions against the
// real Express app over an in-memory database, so the method, path and
// payload the client sends are the ones the server accepts, and a refusal
// reaches the screen as the server's own message. Setup copied from
// ../../Goals/__tests__/goalsApi.test.ts; the seed is a subset of
// server/routes/__tests__/habits.test.ts's, whose figures are hand-worked
// there. The clock is fixed: 23:30 UTC on Tuesday 27 October 2026 is
// Wednesday the 28th in NZ. Every value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../../../apis/habits.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // habits.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../../../apis/habits.ts')
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

const STAMP = '2026-08-01T00:00:00.000Z'
const EVERYDAY = 'acc_sentinel_everyday'
const TRADING = 'acc_sentinel_trading'

type Row = Record<string, unknown>

// The transaction shape of `tx` in server/routes/__tests__/habits.test.ts.
function tx(
  id: number,
  accountId: string,
  day: string,
  amountCents: number,
  balanceCents: number | null,
  fields: Row = {},
): Row {
  return {
    id,
    account_id: accountId,
    date: `${day}T00:00:00.000Z`,
    amount_cents: amountCents,
    balance_cents: balanceCents,
    description: 'EXAMPLE SHOP 4821',
    merchant_name: 'Example Shop',
    status: 'settled',
    source: 'akahu',
    category: 'Shopping',
    category_source: 'akahu',
    ...fields,
  }
}

// Personal: a current account holding 1,000,000 with history from
// 2026-09-01, a grocery spend, a pending spend and an inflow. Strawb: a
// current account holding 500,000, history from 2026-09-01, one supplier
// spend.
async function seed(): Promise<void> {
  for (const row of [
    { id: 1, akahu_id: EVERYDAY, name: 'Sentinel Everyday', scope: 'personal', balance_cents: 1_000_000 },
    { id: 2, akahu_id: TRADING, name: 'Sentinel Trading', scope: 'strawb', balance_cents: 500_000 },
  ]) {
    await connection('accounts').insert({
      source: 'akahu',
      created_at: STAMP,
      updated_at: STAMP,
      ...row,
    })
  }
  await connection('account_settings').insert([
    { account_id: 1, role: 'current', updated_at: STAMP },
    { account_id: 2, role: 'current', updated_at: STAMP },
  ])
  for (const row of [
    tx(102, EVERYDAY, '2026-09-01', 5_000, 900_000),
    tx(101, EVERYDAY, '2026-10-20', -128_000, 872_000, {
      merchant_name: 'Example Grocer',
      description: 'EXAMPLE GROCER 0042',
      category: 'Groceries',
    }),
    tx(103, EVERYDAY, '2026-10-28', -500, null, { status: 'pending' }),
    tx(202, TRADING, '2026-09-01', 1_000, 500_000),
    tx(201, TRADING, '2026-10-21', -64_000, 436_000, {
      merchant_name: null,
      description: 'EXAMPLE SUPPLIER',
      category: null,
    }),
  ]) {
    // One insert per row, so a row's missing keys take the column defaults.
    await connection('transactions').insert(row)
  }
}

const RESPONSE_KEYS = ['runwayTenths', 'streaks', 'verdicts']
const STREAK_KEYS = ['days', 'key', 'label']
const VERDICT_KEYS = [
  'amountCents',
  'category',
  'date',
  'merchant',
  'transactionId',
  'verdict',
]

const GROCER = {
  transactionId: '101',
  date: '2026-10-20',
  merchant: 'Example Grocer',
  category: 'Groceries',
  amountCents: -128_000,
  verdict: null,
}
const SUPPLIER = {
  transactionId: '201',
  date: '2026-10-21',
  merchant: 'EXAMPLE SUPPLIER',
  category: null,
  amountCents: -64_000,
  verdict: null,
}
// 2026-09-01 to 2026-10-28, both counted.
const STREAK_58 = { key: 'no_overdraft', label: 'No overdraft', days: 58 }

const verdictPath = (id: string) => `/api/v1/habits/verdicts/${id}`

describe('grabHabits', () => {
  it('answers the habits contract for the scope asked', async () => {
    await seed()

    const all = await api.grabHabits('all')

    expect(Object.keys(all).sort()).toEqual(RESPONSE_KEYS)
    for (const s of all.streaks) expect(Object.keys(s).sort()).toEqual(STREAK_KEYS)
    for (const v of all.verdicts) expect(Object.keys(v).sort()).toEqual(VERDICT_KEYS)
    expect(all).toStrictEqual({
      runwayTenths: 77,
      streaks: [STREAK_58],
      verdicts: [SUPPLIER, GROCER],
    })
    expect(await api.grabHabits('personal')).toStrictEqual({
      runwayTenths: 77,
      streaks: [STREAK_58],
      verdicts: [GROCER],
    })
    expect(await api.grabHabits('strawb')).toStrictEqual({
      runwayTenths: 78,
      streaks: [STREAK_58],
      verdicts: [SUPPLIER],
    })
  })

  it('sends the scope as a query parameter', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')

    await api.grabHabits('strawb')

    const [url, init] = spy.mock.calls[0]
    const sent = new URL(String(url))
    expect(sent.pathname).toBe('/api/v1/habits')
    expect([...sent.searchParams.entries()]).toEqual([['scope', 'strawb']])
    expect(init).toBeUndefined()
  })

  it('rejects a refused scope with the server message', async () => {
    await expect(api.grabHabits('bogus' as Scope)).rejects.toThrow(
      new Error('scope must be all, personal or strawb'),
    )
  })

  it('names the status when a refusal carries no JSON message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<html>Bad gateway page</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      ),
    )

    await expect(api.grabHabits('all')).rejects.toThrow(new Error('Server error (502)'))
  })
})

describe('setVerdict', () => {
  it('stores the verdict, answers the row, and a later read lists it', async () => {
    await seed()

    const row = await api.setVerdict('101', 'not_really')

    expect(Object.keys(row).sort()).toEqual(VERDICT_KEYS)
    expect(row).toStrictEqual({ ...GROCER, verdict: 'not_really' })
    expect((await api.grabHabits('personal')).verdicts).toStrictEqual([
      { ...GROCER, verdict: 'not_really' },
    ])
    // The same spend is listed under All, with the same verdict.
    expect((await api.grabHabits('all')).verdicts).toStrictEqual([
      SUPPLIER,
      { ...GROCER, verdict: 'not_really' },
    ])
  })

  it('null clears it', async () => {
    await seed()
    await api.setVerdict('101', 'worth_it')

    const row = await api.setVerdict('101', null)

    expect(row).toStrictEqual(GROCER)
    expect((await api.grabHabits('personal')).verdicts).toStrictEqual([GROCER])
  })

  it('sends only the verdict, as JSON, by PUT to the row it names', async () => {
    await seed()
    const spy = vi.spyOn(globalThis, 'fetch')

    await api.setVerdict('201', null)

    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0]
    expect(new URL(String(url)).pathname).toBe(verdictPath('201'))
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['verdict'])
    expect(sent.verdict).toBeNull()
  })

  it('escapes the id into one path segment', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')

    await expect(api.setVerdict('1/../2', 'worth_it')).rejects.toThrow(
      new Error('transactionId must be a positive integer'),
    )

    const [url] = spy.mock.calls[0]
    expect(new URL(String(url)).pathname).toBe(verdictPath('1%2F..%2F2'))
  })

  it("rejects each refusal with the server's message", async () => {
    await seed()

    await expect(api.setVerdict('999', 'worth_it')).rejects.toThrow(
      new Error('Transaction not found'),
    )
    await expect(api.setVerdict('103', 'worth_it')).rejects.toThrow(
      new Error('Transaction is still pending; it can be tagged once it settles'),
    )
    await expect(api.setVerdict('102', 'worth_it')).rejects.toThrow(
      new Error('Only spending can be tagged'),
    )
  })

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )

    await expect(api.setVerdict('101', 'worth_it')).rejects.toThrow(
      new Error('The server could not be reached'),
    )
  })
})

describe('the habits query', () => {
  it('is keyed by the domain, then the scope', () => {
    expect(api.habitsQuery('all').queryKey).toEqual(['habits', 'all'])
    expect(api.habitsQuery('personal').queryKey).toEqual(['habits', 'personal'])
    expect(api.habitsQuery('strawb').queryKey).toEqual(['habits', 'strawb'])
  })

  it('invalidateHabits reaches every scope and never the overview', async () => {
    const client = new QueryClient()
    for (const scope of ['all', 'personal', 'strawb'] as const) {
      client.setQueryData(api.habitsQuery(scope).queryKey, {
        runwayTenths: null,
        streaks: [],
        verdicts: [],
      })
    }
    client.setQueryData(['overview', 'all'], {})
    client.setQueryData(['overview', 'personal'], {})

    await api.invalidateHabits(client)

    expect(client.getQueryState(['habits', 'all'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['habits', 'personal'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['habits', 'strawb'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['overview', 'all'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['overview', 'personal'])?.isInvalidated).toBe(false)
    client.clear()
  })
})

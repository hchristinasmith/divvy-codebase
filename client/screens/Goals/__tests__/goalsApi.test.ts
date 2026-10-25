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

// Tests client/apis/goals.ts; it lives here, not in client/apis/__tests__,
// because issue 56's fence is client/screens/Goals and that one file.
//
// Contract test: the Goals screen's real request functions against the real
// Express app over an in-memory database, so the method, path and payload
// the client sends are the ones the server accepts, and a refusal reaches
// the screen as the server's own message. Setup copied from
// client/apis/__tests__/subscriptions.test.ts. The clock is fixed, as in
// server/routes/__tests__/goals.test.ts: 23:30 UTC on Tuesday 27 October
// 2026 is Wednesday the 28th in NZ. Every value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../../../apis/goals.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // goals.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../../../apis/goals.ts')
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

const GOAL_KEYS = [
  'id',
  'monthsToGo',
  'name',
  'paceCents',
  'savedCents',
  'targetCents',
  'targetDate',
]

// Five whole months from 2026-10-28 to 2027-03-15 (shared/goals.ts
// `monthsUntil`): 150050 over 5 is 30010 a month.
const CAR = { name: 'Sample Car', targetCents: 150050, targetDate: '2027-03-15' }

describe('createGoal', () => {
  it('answers the new goal, with nothing saved', async () => {
    const created = await api.createGoal(CAR)

    expect(Object.keys(created).sort()).toEqual(GOAL_KEYS)
    expect(created).toEqual({
      id: created.id,
      name: 'Sample Car',
      targetCents: 150050,
      savedCents: 0,
      targetDate: '2027-03-15',
      paceCents: 30010,
      monthsToGo: 5,
    })
    expect(created.id).toMatch(/^[1-9]\d*$/)
  })

  it('takes a null by-date: no pace', async () => {
    const created = await api.createGoal({
      name: 'Sample Rainy Day',
      targetCents: 100000,
      targetDate: null,
    })

    expect(created.targetDate).toBeNull()
    expect(created.paceCents).toBeNull()
    expect(created.monthsToGo).toBeNull()
  })

  it('rejects a refused goal with the server message', async () => {
    await expect(
      api.createGoal({ name: '   ', targetCents: 100000, targetDate: null }),
    ).rejects.toThrow(new Error('name must be 1 to 255 characters'))
    await expect(
      api.createGoal({ name: 'Sample Car', targetCents: 0, targetDate: null }),
    ).rejects.toThrow(
      new Error('targetCents must be a whole number of cents from 1 to 1000000000'),
    )
    expect((await api.grabGoals()).items).toEqual([])
  })
})

describe('grabGoals', () => {
  it('answers every goal, by id', async () => {
    expect(await api.grabGoals()).toEqual({ items: [] })
    const car = await api.createGoal(CAR)
    const rainy = await api.createGoal({
      name: 'Sample Rainy Day',
      targetCents: 100000,
      targetDate: null,
    })

    const body = await api.grabGoals()

    expect(Object.keys(body)).toEqual(['items'])
    expect(body.items).toEqual([car, rainy])
  })

  it('names the status when a refusal carries no JSON message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<html>Bad gateway page</html>', {
            status: 500,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      ),
    )

    await expect(api.grabGoals()).rejects.toThrow(new Error('Server error (500)'))
  })
})

describe('addContribution', () => {
  it('records the amount sent and answers the goal afterwards', async () => {
    const car = await api.createGoal(CAR)

    const body = await api.addContribution(car.id, 5000)

    expect(Object.keys(body)).toEqual(['goal'])
    expect(Object.keys(body.goal).sort()).toEqual(GOAL_KEYS)
    // 145050 left over 5 months is 29010.
    expect(body.goal).toEqual({ ...car, savedCents: 5000, paceCents: 29010 })
    await api.addContribution(car.id, 20000)
    const [listed] = (await api.grabGoals()).items
    expect(listed.savedCents).toBe(25000)
  })

  it('sends only the amount, as JSON, to the goal it names', async () => {
    const car = await api.createGoal(CAR)
    const spy = vi.spyOn(globalThis, 'fetch')

    await api.addContribution(car.id, 20000)

    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0]
    expect(new URL(String(url)).pathname).toBe(
      `/api/v1/goals/${car.id}/contributions`,
    )
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['amountCents'])
    expect(sent.amountCents).toBe(20000)
  })

  it('escapes the id into one path segment', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')

    await expect(api.addContribution('1/../2', 5000)).rejects.toThrow(
      new Error('id must be a positive integer'),
    )

    const [url] = spy.mock.calls[0]
    expect(new URL(String(url)).pathname).toBe(
      '/api/v1/goals/1%2F..%2F2/contributions',
    )
  })

  it('rejects a goal that does not exist with the server message', async () => {
    await expect(api.addContribution('999', 5000)).rejects.toThrow(
      new Error('Goal not found'),
    )
  })

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )

    await expect(api.addContribution('1', 5000)).rejects.toThrow(
      new Error('The server could not be reached'),
    )
  })
})

describe('the goals query', () => {
  it('is keyed by the domain alone', () => {
    expect(api.goalsQuery().queryKey).toEqual(['goals'])
  })

  it('invalidateGoals reaches the goals list and never the overview', async () => {
    const client = new QueryClient()
    client.setQueryData(api.goalsQuery().queryKey, { items: [] })
    client.setQueryData(['overview', 'all'], {})
    client.setQueryData(['overview', 'personal'], {})

    await api.invalidateGoals(client)

    expect(client.getQueryState(['goals'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['overview', 'all'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['overview', 'personal'])?.isInvalidated).toBe(false)
    client.clear()
  })

  it('no request in the module reads or writes the overview', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')

    const car = await api.createGoal(CAR)
    await api.addContribution(car.id, 5000)
    await api.grabGoals()

    const paths = spy.mock.calls.map(([url]) => new URL(String(url)).pathname)
    expect(paths).toEqual([
      '/api/v1/goals',
      `/api/v1/goals/${car.id}/contributions`,
      '/api/v1/goals',
    ])
  })
})

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
import { queryKeys } from '../queryKeys.ts'

// The Sync screen's requests (issue 59). The two reads run against the real
// Express app over an in-memory database, so the path the client asks and
// the shape it parses are the ones the server sends. "Sync now" is tested
// against a stubbed fetch only: the real POST /sync/run calls the
// scheduler's trigger, which reads the AKAHU_* environment and could start a
// real sync. Every value is invented.

let served: LoopbackApi | undefined
let api: typeof import('../sync.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // sync.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../sync.ts')
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

const STATUS_KEYS = ['running', 'lastRun', 'lastSuccessAt']
// No `error`: the run's machine code is dropped before the screen sees it.
const RUN_KEYS = ['startedAt', 'finishedAt', 'outcome']

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    return impl()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const reply = (status: number, body: string) => () =>
  Promise.resolve(new Response(body, { status }))

describe('syncStatusQuery against the real app', () => {
  it('reads a never-synced server as idle with no run and no success', async () => {
    const qc = client()
    const status = await qc.fetchQuery(api.syncStatusQuery())

    // Fails if a key the screen reads stops being produced, or the run's
    // machine error starts being kept.
    expect(Object.keys(status).sort()).toEqual([...STATUS_KEYS].sort())
    expect(status).toEqual({ running: false, lastRun: null, lastSuccessAt: null })
    // The pill's entry is written too, as "no believable success".
    expect(qc.getQueryData(queryKeys.syncStatus.all)).toBeNull()
  })

  it('reads the last run and last success, keeps no error, and writes the pill entry', async () => {
    await connection('sync_runs').insert([
      {
        started_at: '2026-10-25T00:00:00.000Z',
        finished_at: '2026-10-25T00:01:00.000Z',
        outcome: 'success',
        inserted_count: 0,
        updated_count: 0,
        pending_mirrored_count: 0,
        error_message: null,
      },
      {
        started_at: '2026-10-25T00:15:00.000Z',
        finished_at: '2026-10-25T00:15:30.000Z',
        outcome: 'failed',
        inserted_count: 0,
        updated_count: 0,
        pending_mirrored_count: 0,
        error_message: 'akahu_unauthorized (HTTP 401)',
      },
    ])
    const qc = client()
    const status = await qc.fetchQuery(api.syncStatusQuery())

    expect(status.lastRun).not.toBeNull()
    expect(Object.keys(status.lastRun ?? {}).sort()).toEqual([...RUN_KEYS].sort())
    expect(status.lastRun).toEqual({
      startedAt: '2026-10-25T00:15:00.000Z',
      finishedAt: '2026-10-25T00:15:30.000Z',
      outcome: 'failed',
    })
    expect(status.lastSuccessAt).toBe('2026-10-25T00:01:00.000Z')
    expect(JSON.stringify(status)).not.toContain('akahu_unauthorized')
    // Fails if the screen's read stops feeding the header pill.
    expect(qc.getQueryData(queryKeys.syncStatus.all)).toBe(
      Date.parse('2026-10-25T00:01:00.000Z'),
    )
  })

  it('caches under the sync-status prefix but never at the pill key itself', () => {
    // Fails if the screen's object would overwrite the pill's number, or if
    // invalidating the prefix would miss the screen.
    const { queryKey } = api.syncStatusQuery()
    expect(queryKey.slice(0, 1)).toEqual([...queryKeys.syncStatus.all])
    expect(queryKey).not.toEqual(queryKeys.syncStatus.all)
  })
})

describe('syncStatusQuery refusals', () => {
  it('rejects a 200 HTML page with a fixed message that does not quote it', async () => {
    stubFetch(reply(200, '<html>SENTINEL</html>'))
    const qc = client()
    // Fails if JSON's SyntaxError, which quotes the body, reaches the screen.
    await expect(qc.fetchQuery(api.syncStatusQuery())).rejects.toThrow(
      new Error('The server sent a reply Divvy could not read'),
    )
    expect(qc.getQueryData(queryKeys.syncStatus.all)).toBeUndefined()
  })

  it.each([
    ['an empty object', '{}'],
    ['running that is not a boolean', '{"running":"no","lastRun":null,"lastSuccessAt":null}'],
    ['a lastSuccessAt that is not a time', '{"running":false,"lastRun":null,"lastSuccessAt":"yesterday"}'],
    [
      'an unknown outcome',
      '{"running":false,"lastSuccessAt":null,"lastRun":{"startedAt":"2026-10-25T00:00:00.000Z","finishedAt":null,"outcome":"abandoned"}}',
    ],
    [
      'a run with no start time',
      '{"running":false,"lastSuccessAt":null,"lastRun":{"finishedAt":null,"outcome":"failed"}}',
    ],
  ])('rejects %s rather than guessing "Not synced yet"', async (_why, body) => {
    stubFetch(reply(200, body))
    const qc = client()
    // Fails if a malformed body is read as a never-synced server.
    await expect(qc.fetchQuery(api.syncStatusQuery())).rejects.toThrow(
      new Error('Unexpected sync status'),
    )
    // Fails if a body the screen refused still reaches the pill.
    expect(qc.getQueryData(queryKeys.syncStatus.all)).toBeUndefined()
  })

  it('rejects a server failure with the server message', async () => {
    stubFetch(reply(500, '{"error":"Could not read sync status"}'))
    await expect(client().fetchQuery(api.syncStatusQuery())).rejects.toThrow(
      new Error('Could not read sync status'),
    )
  })
})

describe('syncAccountsQuery against the real app', () => {
  it('keeps only each account name and its connection name', async () => {
    const STAMP = '2026-10-20T00:00:00.000Z'
    await connection('accounts').insert([
      {
        source: 'akahu',
        akahu_id: 'acc_invented_1',
        scope: 'personal',
        name: 'Sample Everyday',
        formatted_account: '00-0000-0000000-00',
        connection_id: 'conn_invented_1',
        connection_name: 'Test Bank',
        connection_logo: 'https://logo.invalid/test.png',
        balance_cents: 123456,
        created_at: STAMP,
        updated_at: STAMP,
      },
      {
        source: 'akahu',
        akahu_id: 'acc_invented_2',
        scope: 'strawb',
        name: 'Sample Business',
        balance_cents: 654321,
        created_at: STAMP,
        updated_at: STAMP,
      },
    ])
    const accounts = await client().fetchQuery(api.syncAccountsQuery)

    // Fails if an id, account number, balance or logo is kept.
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual(['connectionName', 'name'])
    }
    expect(accounts).toEqual([
      { name: 'Sample Everyday', connectionName: 'Test Bank' },
      { name: 'Sample Business', connectionName: null },
    ])
  })

  it('reads an empty database as no accounts', async () => {
    expect(await client().fetchQuery(api.syncAccountsQuery)).toEqual([])
  })

  it('caches under the sync-status prefix, so "Sync now" re-reads it', () => {
    // Fails if the key moves to the legacy Dashboard's ['accounts'], whose
    // entry holds a different shape.
    expect(api.syncAccountsQuery.queryKey.slice(0, 1)).toEqual([
      ...queryKeys.syncStatus.all,
    ])
  })

  it('rejects a body that is not the accounts envelope', async () => {
    stubFetch(reply(200, '{"items":[{"_id":"x"}]}'))
    await expect(client().fetchQuery(api.syncAccountsQuery)).rejects.toThrow(
      new Error('Unexpected accounts list'),
    )
  })
})

describe('startSync (stubbed fetch only)', () => {
  it('POSTs /api/v1/sync/run with no body', async () => {
    const fetchMock = stubFetch(reply(202, '{"started":true}'))
    await api.startSync()

    // Fails if the method, path or a request body changes.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(String(url)).pathname).toBe('/api/v1/sync/run')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
  })

  it('reads 202 as started without reading the body', async () => {
    // A body that is not JSON: fails if startSync starts parsing it.
    stubFetch(reply(202, 'not json'))
    expect(await api.startSync()).toBe('started')
  })

  it('reads 409 as already running, not as an error', async () => {
    stubFetch(reply(409, '{"started":false,"reason":"already running"}'))
    expect(await api.startSync()).toBe('already running')
  })

  it.each([
    ['a 200 the route never sends', reply(200, '{"started":true}')],
    ['a 403', reply(403, '{"error":"Forbidden SENTINEL"}')],
    ['a 500', reply(500, '{"error":"boom SENTINEL"}')],
    ['an unreachable server', () => Promise.reject(new TypeError('offline'))],
  ])('rejects %s with the fixed message, never the server text', async (_why, impl) => {
    stubFetch(impl)
    // Fails if the server's text, or a raw TypeError, reaches the screen.
    await expect(api.startSync()).rejects.toThrow(new Error(api.SYNC_NOW_ERROR))
  })
})

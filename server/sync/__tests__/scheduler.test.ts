import { inspect } from 'node:util'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSyncScheduler,
  DEFAULT_SYNC_INTERVAL_MS,
  MAX_SYNC_INTERVAL_MS,
  MIN_SYNC_INTERVAL_MS,
  parseSyncIntervalMs,
} from '../scheduler.ts'
import type { SchedulerDeps } from '../scheduler.ts'
import type { AkahuClient } from '../akahu-client.ts'
import type { SyncOptions, SyncResult } from '../run.ts'
import {
  closeDb,
  db,
  freshDb,
  NOW,
  SENTINEL_APP_ID,
  SENTINEL_TOKEN,
  syncRuns,
} from './harness.ts'

// Issue #27 (prd-01 Ruling 6): the scheduler calls `runSync` every interval
// and on demand, never two at once, starts nothing on import, and survives
// every failure with the next tick retrying. The app is never imported
// here: `server.ts` loads `dotenv/config`, which would read `.env`.
//
// Only `setInterval`, `clearInterval` and `Date` are faked. Faking every
// timer would also stop the timeouts knex's pool and the Akahu client use.

const INTERVAL = DEFAULT_SYNC_INTERVAL_MS
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

const SUCCESS: SyncResult = {
  outcome: 'success',
  runId: 1,
  insertedCount: 0,
  updatedCount: 0,
  pendingMirroredCount: 0,
}

/** A client the fake `runSync` never calls. */
const UNUSED_CLIENT: AkahuClient = {
  listAccounts: () => Promise.reject(new Error('not called')),
  listTransactions: () => Promise.reject(new Error('not called')),
  listPendingTransactions: () => Promise.reject(new Error('not called')),
}

interface Pending {
  resolve(result: SyncResult): void
  reject(err: unknown): void
}

/** A fake `runSync` whose every call waits until the test settles it. */
function heldRunSync() {
  const pending: Pending[] = []
  const runSync = vi.fn<[SyncOptions], Promise<SyncResult>>(
    () =>
      new Promise<SyncResult>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )
  return { runSync, pending }
}

/** A fake `runSync` that succeeds at once. */
function succeeding() {
  return vi.fn<[SyncOptions], Promise<SyncResult>>(async () => SUCCESS)
}

function scheduler(deps: SchedulerDeps) {
  return createSyncScheduler({ createClient: () => UNUSED_CLIENT, ...deps })
}

function consoleCalls(): number {
  return CONSOLE_METHODS.reduce(
    (sum, method) => sum + vi.mocked(console[method]).mock.calls.length,
    0,
  )
}

/** Every argument passed to `console.*` in this test, fully inspected. */
function consoleText(): string {
  return CONSOLE_METHODS.flatMap((method) =>
    vi.mocked(console[method]).mock.calls.map((args) =>
      inspect(args, { depth: null, showHidden: true }),
    ),
  ).join('\n')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  // The shell's own value must not decide the interval.
  vi.stubEnv('SYNC_INTERVAL_MS', '')
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation(() => {})
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
afterAll(closeDb)

describe('nothing runs until start()', () => {
  it('importing the module starts no timer and leaves the scheduler unstarted', async () => {
    vi.resetModules()
    const mod = await import('../scheduler.ts')

    expect(vi.getTimerCount()).toBe(0)
    expect(mod.syncScheduler.getState()).toStrictEqual({
      started: false,
      running: false,
      nextRunAt: null,
    })
  })

  it('creating a scheduler starts no timer and calls nothing', async () => {
    const { runSync } = heldRunSync()
    scheduler({ runSync })

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)

    expect(vi.getTimerCount()).toBe(0)
    expect(runSync).not.toHaveBeenCalled()
  })
})

describe('the interval', () => {
  it('runs once per interval, and not at start', async () => {
    const runSync = succeeding()
    scheduler({ runSync }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(runSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(runSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runSync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(2)
  })

  it('passes the client, the database and the clock to runSync', async () => {
    const runSync = succeeding()
    const now = () => new Date()
    scheduler({ runSync, db, now }).start()

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(runSync).toHaveBeenCalledTimes(1)
    const options = runSync.mock.calls[0][0]
    expect(options.client).toBe(UNUSED_CLIENT)
    expect(options.db).toBe(db)
    expect(options.now).toBe(now)
  })

  it('honours SYNC_INTERVAL_MS', async () => {
    vi.stubEnv('SYNC_INTERVAL_MS', '60000')
    const runSync = succeeding()
    scheduler({ runSync }).start()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(runSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('uses the default, silently, when SYNC_INTERVAL_MS is unset', async () => {
    delete process.env.SYNC_INTERVAL_MS
    const runSync = succeeding()
    scheduler({ runSync }).start()

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(runSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(consoleCalls()).toBe(0)
  })

  it('uses the default, silently, when SYNC_INTERVAL_MS is empty', async () => {
    vi.stubEnv('SYNC_INTERVAL_MS', '')
    const runSync = succeeding()
    scheduler({ runSync }).start()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(consoleCalls()).toBe(0)
  })

  const INVALID = [
    'abc',
    '0',
    '-5',
    '1.5',
    '59999',
    '2147483648',
    '900000ms',
    ' 900000 ',
    '1e6',
  ]

  it.each(INVALID)(
    'falls back to the default for %j, with one warning that does not echo it',
    async (raw) => {
      vi.stubEnv('SYNC_INTERVAL_MS', raw)
      const runSync = succeeding()
      scheduler({ runSync }).start()

      await vi.advanceTimersByTimeAsync(INTERVAL - 1)
      expect(runSync).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(runSync).toHaveBeenCalledTimes(1)

      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(consoleCalls()).toBe(1)
      expect(consoleText()).not.toContain(raw)
      expect(consoleText()).toContain('SYNC_INTERVAL_MS')
    },
  )
})

describe('parseSyncIntervalMs', () => {
  it.each([
    [undefined, { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: true }],
    ['', { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: true }],
    ['900000', { intervalMs: 900_000, valid: true }],
    [String(MIN_SYNC_INTERVAL_MS), { intervalMs: MIN_SYNC_INTERVAL_MS, valid: true }],
    [String(MAX_SYNC_INTERVAL_MS), { intervalMs: MAX_SYNC_INTERVAL_MS, valid: true }],
    ['0060000', { intervalMs: 60_000, valid: true }],
    [String(MIN_SYNC_INTERVAL_MS - 1), { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
    [String(MAX_SYNC_INTERVAL_MS + 1), { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
    ['abc', { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
    ['-60000', { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
    ['60000.0', { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
    ['0x10000', { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
    [' 900000', { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }],
  ])('%j → %j', (raw, expected) => {
    const result = parseSyncIntervalMs(raw)
    expect(result).toStrictEqual(expected)
  })
})

describe('one run at a time', () => {
  it('skips a tick that fires during a run, and runs at the next one', async () => {
    const { runSync, pending } = heldRunSync()
    const s = scheduler({ runSync })
    s.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(1)
    vi.mocked(console.error).mockClear()

    // A tick during the run: nothing called, nothing logged.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(consoleCalls()).toBe(0)
    expect(s.getState().running).toBe(true)

    pending[0].resolve(SUCCESS)
    await s.whenIdle()
    expect(s.getState().running).toBe(false)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(2)
  })

  it('a second trigger() during a run is refused synchronously', () => {
    const { runSync } = heldRunSync()
    const s = scheduler({ runSync })

    expect(s.trigger()).toStrictEqual({ started: true })
    expect(s.trigger()).toStrictEqual({
      started: false,
      reason: 'already_running',
    })
    expect(runSync).toHaveBeenCalledTimes(1)
  })

  it('a tick during a run started by trigger() is skipped', async () => {
    const { runSync, pending } = heldRunSync()
    const s = scheduler({ runSync })
    s.start()

    expect(s.trigger()).toStrictEqual({ started: true })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(1)

    pending[0].resolve(SUCCESS)
    await s.whenIdle()
  })

  it('trigger() during a run started by a tick is refused', async () => {
    const { runSync, pending } = heldRunSync()
    const s = scheduler({ runSync })
    s.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(s.trigger()).toStrictEqual({
      started: false,
      reason: 'already_running',
    })
    expect(runSync).toHaveBeenCalledTimes(1)

    pending[0].resolve(SUCCESS)
    await s.whenIdle()
  })

  const SETTLEMENTS: [string, (p: Pending) => void][] = [
    ['success', (p) => p.resolve(SUCCESS)],
    [
      'failed',
      (p) =>
        p.resolve({ outcome: 'failed', runId: 1, errorMessage: 'akahu_network' }),
    ],
    [
      'skipped',
      (p) =>
        p.resolve({
          outcome: 'skipped',
          reason: 'already_running',
          runningRunId: 7,
        }),
    ],
    ['a rejection', (p) => p.reject(new Error('sync_runs unreadable'))],
  ]

  it.each(SETTLEMENTS)(
    'is running during a run and idle after %s, and the next tick runs',
    async (_label, settle) => {
      const { runSync, pending } = heldRunSync()
      const s = scheduler({ runSync })
      s.start()
      expect(s.getState().running).toBe(false)

      await vi.advanceTimersByTimeAsync(INTERVAL)
      expect(s.getState().running).toBe(true)

      settle(pending[0])
      await s.whenIdle()
      expect(s.getState().running).toBe(false)

      await vi.advanceTimersByTimeAsync(INTERVAL)
      expect(runSync).toHaveBeenCalledTimes(2)
      pending[1].resolve(SUCCESS)
      await s.whenIdle()
    },
  )
})

describe('a rejected run', () => {
  it('logs fixed text without the error message, never rejects, and the next tick retries', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const runSync = vi
        .fn<[SyncOptions], Promise<SyncResult>>()
        .mockRejectedValueOnce(
          new Error(`SQLITE_BUSY Authorization: Bearer ${SENTINEL_TOKEN}`),
        )
        .mockResolvedValue(SUCCESS)
      const s = scheduler({ runSync })
      s.start()

      await vi.advanceTimersByTimeAsync(INTERVAL)
      await expect(s.whenIdle()).resolves.toBeUndefined()
      // Give an unhandled rejection the turn it needs to be reported.
      await new Promise((resolve) => setImmediate(resolve))

      expect(unhandled).not.toHaveBeenCalled()
      expect(vi.mocked(console.error).mock.calls).toStrictEqual([
        ['sync scheduler: runSync rejected', 'Error'],
      ])
      expect(consoleText()).not.toContain(SENTINEL_TOKEN)
      expect(consoleText()).not.toContain('SQLITE_BUSY')

      await vi.advanceTimersByTimeAsync(INTERVAL)
      expect(runSync).toHaveBeenCalledTimes(2)
      await s.whenIdle()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('survives a client factory that throws', async () => {
    const runSync = succeeding()
    const s = createSyncScheduler({
      runSync,
      createClient: () => {
        throw new TypeError(`bad token ${SENTINEL_TOKEN}`)
      },
    })

    expect(s.trigger()).toStrictEqual({ started: true })
    await s.whenIdle()

    expect(runSync).not.toHaveBeenCalled()
    expect(s.getState().running).toBe(false)
    expect(vi.mocked(console.error).mock.calls).toStrictEqual([
      ['sync scheduler: runSync rejected', 'TypeError'],
    ])
    expect(consoleText()).not.toContain(SENTINEL_TOKEN)
    expect(s.trigger()).toStrictEqual({ started: true })
    await s.whenIdle()
  })
})

describe('nextRunAt', () => {
  it('is null until start, the next tick after, unmoved by a manual run, and null after stop', async () => {
    const runSync = succeeding()
    const s = scheduler({ runSync })
    expect(s.getState()).toStrictEqual({
      started: false,
      running: false,
      nextRunAt: null,
    })

    s.start()
    const first = new Date(NOW.getTime() + INTERVAL).toISOString()
    expect(s.getState()).toStrictEqual({
      started: true,
      running: false,
      nextRunAt: first,
    })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    await s.whenIdle()
    const second = new Date(NOW.getTime() + 2 * INTERVAL).toISOString()
    expect(s.getState().nextRunAt).toBe(second)

    s.trigger()
    await s.whenIdle()
    expect(s.getState().nextRunAt).toBe(second)

    s.stop()
    expect(s.getState()).toStrictEqual({
      started: false,
      running: false,
      nextRunAt: null,
    })
  })
})

describe('start and stop', () => {
  it('start() twice throws, and leaves one timer', () => {
    const s = scheduler({ runSync: succeeding() })
    s.start()

    expect(() => s.start()).toThrow('sync scheduler already started')
    expect(vi.getTimerCount()).toBe(1)
    s.stop()
  })

  it('start() unrefs its timer, so the timer alone does not keep the process alive', () => {
    // Restored inside the test: `afterEach` restores mocks after
    // `useRealTimers()`, which would reinstall the fake `setInterval`.
    const spy = vi.spyOn(globalThis, 'setInterval')
    const s = scheduler({ runSync: succeeding() })
    let results: { value: unknown }[]
    try {
      s.start()
      // `mockRestore()` clears the recorded results, so copy them first.
      results = [...spy.mock.results]
    } finally {
      spy.mockRestore()
    }

    expect(results).toHaveLength(1)
    const handle = results[0].value as NodeJS.Timeout
    expect(handle.hasRef()).toBe(false)
    s.stop()
  })

  it('stop() clears the timer, is safe twice, and lets a run in flight finish', async () => {
    const { runSync, pending } = heldRunSync()
    const s = scheduler({ runSync })
    s.start()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runSync).toHaveBeenCalledTimes(1)

    s.stop()
    s.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(s.getState().running).toBe(true)

    pending[0].resolve(SUCCESS)
    await s.whenIdle()
    expect(s.getState().running).toBe(false)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(runSync).toHaveBeenCalledTimes(1)
  })
})

describe('with the real runSync and Akahu client', () => {
  beforeEach(async () => {
    await freshDb()
  })

  /** Every fetch the client sends, answered with `reply`. */
  function stubFetch(reply: () => Response) {
    const fetch = vi.fn<[URL, RequestInit], Promise<Response>>(async () =>
      reply(),
    )
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  async function tick(s: ReturnType<typeof createSyncScheduler>) {
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await s.whenIdle()
  }

  it('records missing credentials as a failed run, and the next tick retries', async () => {
    vi.stubEnv('AKAHU_USER_TOKEN', '')
    vi.stubEnv('AKAHU_APP_ID', '')
    const fetch = stubFetch(() => new Response('{}', { status: 500 }))
    const s = createSyncScheduler()
    s.start()

    await tick(s)
    await tick(s)
    s.stop()

    const runs = await syncRuns()
    expect(runs.map((r) => [r.id, r.outcome, r.error_message])).toStrictEqual([
      [1, 'failed', 'akahu_missing_credentials'],
      [2, 'failed', 'akahu_missing_credentials'],
    ])
    expect(runs[0].started_at).toBe(new Date(NOW.getTime() + INTERVAL).toISOString())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('records a 401 by code and status, with no credential in a row or a log line', async () => {
    vi.stubEnv('AKAHU_USER_TOKEN', SENTINEL_TOKEN)
    vi.stubEnv('AKAHU_APP_ID', SENTINEL_APP_ID)
    stubFetch(
      () =>
        new Response(
          `{"success":false,"message":"bad token ${SENTINEL_TOKEN} for ${SENTINEL_APP_ID}"}`,
          {
            status: 401,
            headers: { 'www-authenticate': `Bearer ${SENTINEL_TOKEN}` },
          },
        ),
    )
    const s = createSyncScheduler()
    s.start()

    await tick(s)
    s.stop()

    const runs = await syncRuns()
    expect(runs.map((r) => [r.outcome, r.error_message])).toStrictEqual([
      ['failed', 'akahu_unauthorized (HTTP 401)'],
    ])
    for (const text of [JSON.stringify(runs), consoleText()]) {
      expect(text).not.toContain(SENTINEL_TOKEN)
      expect(text).not.toContain(SENTINEL_APP_ID)
    }
  })

  it('reads the credentials when each run starts, not when it is created', async () => {
    vi.stubEnv('AKAHU_USER_TOKEN', '')
    vi.stubEnv('AKAHU_APP_ID', '')
    const fetch = stubFetch(() => new Response('{}', { status: 401 }))
    const s = createSyncScheduler()

    vi.stubEnv('AKAHU_USER_TOKEN', SENTINEL_TOKEN)
    vi.stubEnv('AKAHU_APP_ID', SENTINEL_APP_ID)
    s.trigger()
    await s.whenIdle()

    expect(fetch).toHaveBeenCalledTimes(1)
    const headers = fetch.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${SENTINEL_TOKEN}`)
    expect(headers['X-Akahu-Id']).toBe(SENTINEL_APP_ID)

    vi.stubEnv('AKAHU_USER_TOKEN', '')
    s.trigger()
    await s.whenIdle()
    const runs = await syncRuns()
    expect(runs.map((r) => r.error_message)).toStrictEqual([
      'akahu_unauthorized (HTTP 401)',
      'akahu_missing_credentials',
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import connection from '../../db/connection.ts'
import { syncScheduler } from '../../sync/scheduler.ts'
import type { SyncRun } from '../../../models/sync.ts'

// /api/v1/sync (issue #27, prd-01 Ruling 6): the status shape prd-02 reads,
// and "sync now", which answers at once and never starts a second run.
//
// The real app and its one scheduler, which is never started here, so no
// timer runs. `server.ts` loads `dotenv/config`, so a developer's `.env`
// could hold real Akahu credentials: every test sets both to invented
// values (empty unless the test says otherwise) and replaces `fetch`, so
// nothing reaches the network. A run a test starts is awaited before the
// next test re-migrates the database.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']
let fetchMock: Mock<[URL, RequestInit], Promise<Response>>

const STATUS_KEYS = ['running', 'lastRun', 'lastSuccessAt', 'nextRunAt']
const RUN_KEYS = ['id', 'startedAt', 'finishedAt', 'outcome', 'counts', 'error']
const COUNT_KEYS = ['inserted', 'updated', 'pendingMirrored']

const SENTINEL_TOKEN = 'sentinel-route-akahu-token-5be0a3'
const SENTINEL_APP_ID = 'sentinel-route-akahu-app-id-71c9d4'

const EMPTY_PAGE = '{"success":true,"items":[],"cursor":{"next":null}}'

beforeEach(async () => {
  vi.stubEnv('AKAHU_USER_TOKEN', '')
  vi.stubEnv('AKAHU_APP_ID', '')
  fetchMock = vi.fn<[URL, RequestInit], Promise<Response>>(() =>
    Promise.reject(new Error('fetch must not be called')),
  )
  vi.stubGlobal('fetch', fetchMock)
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  // A run still in flight would write into the next test's database.
  await syncScheduler.whenIdle()
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(closeDb)

type RunRow = Omit<SyncRun, 'id'> & { id?: number }

function insertRuns(...rows: RunRow[]) {
  return connection('sync_runs').insert(rows)
}

const BASE = Date.parse('2026-10-25T00:00:00.000Z')
const iso = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString()

function success(started: number, counts = [0, 0, 0]): RunRow {
  return {
    started_at: iso(started),
    finished_at: iso(started + 1),
    outcome: 'success',
    inserted_count: counts[0],
    updated_count: counts[1],
    pending_mirrored_count: counts[2],
    error_message: null,
  }
}

function failed(started: number, error: string): RunRow {
  return {
    started_at: iso(started),
    finished_at: iso(started + 1),
    outcome: 'failed',
    inserted_count: 0,
    updated_count: 0,
    pending_mirrored_count: 0,
    error_message: error,
  }
}

/** A promise with its resolve exposed. */
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve
  })
  return { promise, resolve }
}

describe('GET /api/v1/sync/status', () => {
  it('with no runs, and the scheduler unstarted, is all empty', async () => {
    const res = await api.get('/api/v1/sync/status')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Object.keys(res.body).sort()).toEqual([...STATUS_KEYS].sort())
    expect(res.body).toStrictEqual({
      running: false,
      lastRun: null,
      lastSuccessAt: null,
      nextRunAt: null,
    })
  })

  it('maps the newest run, and the last success even when a failure followed it', async () => {
    await insertRuns(
      success(0, [3, 2, 1]),
      failed(15, 'akahu_unauthorized (HTTP 401)'),
    )

    const res = await api.get('/api/v1/sync/status')

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual([...STATUS_KEYS].sort())
    expect(Object.keys(res.body.lastRun).sort()).toEqual([...RUN_KEYS].sort())
    expect(Object.keys(res.body.lastRun.counts).sort()).toEqual(
      [...COUNT_KEYS].sort(),
    )
    expect(res.body).toStrictEqual({
      running: false,
      lastRun: {
        id: 2,
        startedAt: iso(15),
        finishedAt: iso(16),
        outcome: 'failed',
        counts: { inserted: 0, updated: 0, pendingMirrored: 0 },
        error: 'akahu_unauthorized (HTTP 401)',
      },
      lastSuccessAt: iso(1),
      nextRunAt: null,
    })
  })

  it('maps a success’s counts', async () => {
    await insertRuns(success(0, [3, 2, 1]))

    const res = await api.get('/api/v1/sync/status')

    expect(res.body.lastRun).toStrictEqual({
      id: 1,
      startedAt: iso(0),
      finishedAt: iso(1),
      outcome: 'success',
      counts: { inserted: 3, updated: 2, pendingMirrored: 1 },
      error: null,
    })
    expect(res.body.lastSuccessAt).toBe(iso(1))
  })

  it('orders by start time, then by id, not by insertion', async () => {
    await insertRuns(
      { id: 5, ...failed(30, 'akahu_network') },
      { id: 3, ...success(60) },
      { id: 4, ...success(0) },
      { id: 2, ...failed(60, 'akahu_server (HTTP 500)') },
    )

    const res = await api.get('/api/v1/sync/status')

    // Two runs started at 60; the higher id is the newer.
    expect(res.body.lastRun.id).toBe(3)
    expect(res.body.lastSuccessAt).toBe(iso(61))
  })

  // The last value is an ISO form julianday() reads but toISOString() never
  // writes (no milliseconds): only the strftime filter keeps it out of lastRun.
  it.each(['not-a-timestamp', 'now', '2999-01-01T00:00:00Z'])(
    'ranks a success whose started_at is %s below a valid one, as the claim step does (#188)',
    async (badStart) => {
      await insertRuns(success(0))
      await insertRuns({
        ...success(30),
        started_at: badStart,
      })

      const res = await api.get('/api/v1/sync/status')

      expect(res.status).toBe(200)
      expect(res.body.lastRun).toMatchObject({ id: 1, startedAt: iso(0) })
      expect(res.body.lastSuccessAt).toBe(iso(1))
    },
  )

  it('shows a leftover running row as running in the database, not in this process', async () => {
    await insertRuns(success(0), {
      started_at: iso(15),
      finished_at: null,
      outcome: 'running',
      inserted_count: 0,
      updated_count: 0,
      pending_mirrored_count: 0,
      error_message: null,
    })

    const res = await api.get('/api/v1/sync/status')

    expect(res.body.running).toBe(false)
    expect(res.body.lastRun).toStrictEqual({
      id: 2,
      startedAt: iso(15),
      finishedAt: null,
      outcome: 'running',
      counts: { inserted: 0, updated: 0, pendingMirrored: 0 },
      error: null,
    })
  })

  it('answers an unreadable sync_runs with a fixed 500, logging the error class only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.schema.renameTable('sync_runs', 'sync_runs_away')
    try {
      const res = await api.get('/api/v1/sync/status')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not read sync status' })
      expect(error.mock.calls).toStrictEqual([
        ['sync status: could not read sync_runs', 'Error'],
      ])
    } finally {
      await connection.schema.renameTable('sync_runs_away', 'sync_runs')
      error.mockRestore()
    }
  })
})

describe('POST /api/v1/sync/run', () => {
  it('answers 202 at once, refuses a second press with 409, and the run finishes in the background', async () => {
    vi.stubEnv('AKAHU_USER_TOKEN', 'invented-token')
    vi.stubEnv('AKAHU_APP_ID', 'invented-app-id')
    const reached = deferred()
    const release = deferred()
    fetchMock.mockImplementation(async () => {
      reached.resolve()
      await release.promise
      return new Response(EMPTY_PAGE, { status: 200 })
    })

    // A failed assertion must still release the run: the scheduler is
    // shared, and a run held forever would hang `afterEach` and turn every
    // later press into a 409.
    try {
      const first = await api.post('/api/v1/sync/run')
      expect(first.status).toBe(202)
      expect(Object.keys(first.body)).toEqual(['started'])
      expect(first.body).toStrictEqual({ started: true })

      // The run is held inside its first Akahu request.
      await reached.promise

      const second = await api.post('/api/v1/sync/run')
      expect(second.status).toBe(409)
      expect(Object.keys(second.body).sort()).toEqual(['reason', 'started'])
      expect(second.body).toStrictEqual({
        started: false,
        reason: 'already running',
      })

      const during = await api.get('/api/v1/sync/status')
      expect(during.body.running).toBe(true)
      expect(during.body.lastRun).toMatchObject({
        id: 1,
        outcome: 'running',
        finishedAt: null,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
    }
    await syncScheduler.whenIdle()

    const after = await api.get('/api/v1/sync/status')
    expect(after.body.running).toBe(false)
    expect(after.body.lastRun).toMatchObject({
      id: 1,
      outcome: 'success',
      error: null,
    })
    expect(after.body.lastSuccessAt).toBe(after.body.lastRun.finishedAt)
    expect(await connection('sync_runs').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('records missing credentials as a failed run, and the next press starts again', async () => {
    const first = await api.post('/api/v1/sync/run')
    expect(first.status).toBe(202)
    await syncScheduler.whenIdle()

    const status = await api.get('/api/v1/sync/status')
    expect(status.body.running).toBe(false)
    expect(status.body.lastRun).toMatchObject({
      id: 1,
      outcome: 'failed',
      error: 'akahu_missing_credentials',
    })
    expect(status.body.lastSuccessAt).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    const again = await api.post('/api/v1/sync/run')
    expect(again.status).toBe(202)
    await syncScheduler.whenIdle()
    const later = await api.get('/api/v1/sync/status')
    expect(later.body.lastRun).toMatchObject({
      id: 2,
      outcome: 'failed',
      error: 'akahu_missing_credentials',
    })
  })

  it('never puts an AKAHU_ value in a response, even when Akahu echoes it', async () => {
    vi.stubEnv('AKAHU_USER_TOKEN', SENTINEL_TOKEN)
    vi.stubEnv('AKAHU_APP_ID', SENTINEL_APP_ID)
    fetchMock.mockImplementation(
      async () =>
        new Response(
          `{"success":false,"message":"bad token ${SENTINEL_TOKEN} for ${SENTINEL_APP_ID}"}`,
          {
            status: 401,
            headers: { 'www-authenticate': `Bearer ${SENTINEL_TOKEN}` },
          },
        ),
    )

    const run = await api.post('/api/v1/sync/run')
    await syncScheduler.whenIdle()
    const status = await api.get('/api/v1/sync/status')

    expect(fetchMock).toHaveBeenCalled()
    expect(status.body.lastRun.error).toBe('akahu_unauthorized (HTTP 401)')
    const secrets = Object.entries(process.env)
      .filter(([name, value]) => name.startsWith('AKAHU_') && value)
      .map(([, value]) => value as string)
    expect(secrets).toEqual(
      expect.arrayContaining([SENTINEL_TOKEN, SENTINEL_APP_ID]),
    )
    for (const text of [run.text, status.text]) {
      for (const secret of secrets) expect(text).not.toContain(secret)
    }
  })

  it('answers 503 while the scheduler is stopped for the shutdown drain, and starts no run (#462)', async () => {
    vi.stubEnv('AKAHU_USER_TOKEN', 'invented-token')
    vi.stubEnv('AKAHU_APP_ID', 'invented-app-id')
    const trigger = vi
      .spyOn(syncScheduler, 'trigger')
      .mockReturnValue({ started: false, reason: 'stopped' })

    try {
      const res = await api.post('/api/v1/sync/run')

      expect(res.status).toBe(503)
      expect(Object.keys(res.body).sort()).toEqual(['reason', 'started'])
      expect(res.body).toStrictEqual({ started: false, reason: 'shutting down' })
      expect(trigger).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await connection('sync_runs').count({ n: '*' })).toEqual([{ n: 0 }])
    } finally {
      trigger.mockRestore()
    }
  })

  it('without Sec-Fetch-Site, refuses a request from another origin before starting anything', async () => {
    for (const origin of ['http://evil.example', 'null', 'not a url']) {
      const res = await api.post('/api/v1/sync/run').set('Origin', origin)

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
    }
    expect(syncScheduler.getState().running).toBe(false)
    expect(await connection('sync_runs').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('without Sec-Fetch-Site, accepts a request from this host’s own origin, and one with no Origin', async () => {
    const own = await api
      .post('/api/v1/sync/run')
      .set('Origin', `http://127.0.0.1:${served?.address.port}`)
    expect(own.status).toBe(202)
    await syncScheduler.whenIdle()

    const none = await api.post('/api/v1/sync/run')
    expect(none.status).toBe(202)
  })

  it('Sec-Fetch-Site same-origin starts a run though Origin names another host, as behind the dev proxy', async () => {
    // Vite's proxy rewrites `Host` to the server's own; `Origin` keeps the
    // page's port.
    const proxied = await api
      .post('/api/v1/sync/run')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Origin', 'http://localhost:5173')
    expect(proxied.status).toBe(202)
    expect(proxied.body).toStrictEqual({ started: true })
    await syncScheduler.whenIdle()

    const typed = await api
      .post('/api/v1/sync/run')
      .set('Sec-Fetch-Site', 'none')
    expect(typed.status).toBe(202)
  })

  it.each(['cross-site', 'same-site', 'not-a-value'])(
    'Sec-Fetch-Site %s is refused even with this host’s own Origin, and nothing starts',
    async (site) => {
      vi.stubEnv('AKAHU_USER_TOKEN', 'invented-token')
      vi.stubEnv('AKAHU_APP_ID', 'invented-app-id')

      const res = await api
        .post('/api/v1/sync/run')
        .set('Sec-Fetch-Site', site)
        .set('Origin', `http://127.0.0.1:${served?.address.port}`)

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
      expect(syncScheduler.getState().running).toBe(false)
      await syncScheduler.whenIdle()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await connection('sync_runs').count({ n: '*' })).toEqual([
        { n: 0 },
      ])
    },
  )
})

describe('only the two routes exist', () => {
  it.each([
    ['get', '/api/v1/sync/run'],
    ['post', '/api/v1/sync/status'],
    ['get', '/api/v1/sync'],
  ] as const)('%s %s is a JSON 404', async (method, path) => {
    const res = await api[method](path)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
    expect(syncScheduler.getState().running).toBe(false)
  })
})

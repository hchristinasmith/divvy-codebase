import { inspect } from 'node:util'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSync } from '../run.ts'
import { AkahuError } from '../akahu-client.ts'
import type { AkahuClient, AkahuErrorCode } from '../akahu-client.ts'
import {
  at,
  closeDb,
  db,
  deferred,
  fakeAkahu,
  fixture,
  freshDb,
  MINUTE_MS,
  NOW,
  page,
  replaceOnce,
  SENTINEL_APP_ID,
  SENTINEL_TOKEN,
  snapshot,
  syncRuns,
  withSettledItem,
} from './harness.ts'
import type { Reply, Routes, Snapshot } from './harness.ts'

// Issue #21, Done-when 4 (prd-01 Done-when 4) and the #19 contract,
// point 4: a run that fails, at any of its requests or while
// writing, leaves every table but `sync_runs` exactly as it was, writes one
// `failed` row whose text is a fixed code and status, and never lets a
// token reach that text or a console line. A run declared stale and
// superseded cannot commit over its successor.

const fixed = (date: Date) => () => date
const LATER = at(15 * MINUTE_MS)

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

beforeEach(async () => {
  await freshDb()
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation(() => {})
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(closeDb)

/** Every argument passed to `console.*` in this test, fully inspected. */
function consoleText(): string {
  return CONSOLE_METHODS.flatMap((method) =>
    vi.mocked(console[method]).mock.calls.map((args) =>
      inspect(args, { depth: null, showHidden: true }),
    ),
  ).join('\n')
}

function expectNoSecret(text: string) {
  expect(text).not.toContain(SENTINEL_TOKEN)
  expect(text).not.toContain(SENTINEL_APP_ID)
}

/** Run 1 succeeds over the fixtures, then a user corrects one category. */
async function establish(): Promise<{ before: Snapshot; runsBefore: unknown[] }> {
  const first = await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })
  expect(first.outcome).toBe('success')
  const { id } = await db('transactions')
    .where({ akahu_id: 'trans_fixture0001' })
    .first('id')
  await db('transactions')
    .where({ id })
    .update({ category: 'Bakeries', category_source: 'user' })
  await db('category_corrections').insert({
    transaction_id: id,
    from_category: 'Cafes and restaurants',
    to_category: 'Bakeries',
    corrected_at: at(5 * MINUTE_MS).toISOString(),
    source: 'user',
  })
  return { before: await snapshot(), runsBefore: await syncRuns() }
}

const NEW_CREDIT_ITEM = `{"_id":"trans_fixture_new_credit","_account":"acc_fixture0003credit","_connection":"conn_fixture0001","amount":-3.5,"date":"2026-10-24T00:00:00.000Z","description":"EXAMPLE NEW CREDIT","hash":"hash_fixture_new","type":"EFTPOS","created_at":"2026-10-25T01:00:00.000Z","updated_at":"2026-10-25T01:00:00.000Z"}`

/**
 * Akahu's data for run 2, different from run 1 in every table: an account
 * renamed, a transaction amended, a new one on the second account, and one
 * pending item gone. A run that wrote any of it is visible in a snapshot.
 */
function changedRoutes(): Required<Routes> {
  const transactions = withSettledItem(
    replaceOnce(
      fixture('akahu-transactions.json'),
      '"description": "EXAMPLE CAFE 12 HIGH ST"',
      '"description": "EXAMPLE CAFE 12 HIGH ST AMENDED"',
    ),
    NEW_CREDIT_ITEM,
  )
  return {
    accounts: replaceOnce(
      fixture('akahu-accounts.json'),
      '"Fixture Everyday"',
      '"Fixture Everyday Renamed"',
    ),
    transactions: (url) =>
      url.searchParams.has('cursor') ? page([]) : transactions,
    pending: page([
      '{"_account":"acc_fixture0003credit","amount":-8.5,"date":"2026-10-24T10:05:00.000Z"}',
    ]),
  }
}

async function expectFailedRun(
  result: Awaited<ReturnType<typeof runSync>>,
  errorMessage: string,
  before: Snapshot,
  runsBefore: unknown[],
) {
  expect(result).toEqual({ outcome: 'failed', runId: 2, errorMessage })
  expect(await snapshot()).toEqual(before)
  expect(await syncRuns()).toEqual([
    ...runsBefore,
    {
      id: 2,
      started_at: LATER.toISOString(),
      finished_at: LATER.toISOString(),
      outcome: 'failed',
      inserted_count: 0,
      updated_count: 0,
      pending_mirrored_count: 0,
      error_message: errorMessage,
    },
  ])
}

const STAGES = ['accounts', 'transactions', 'pending'] as const

// Each reply carries the token where a careless error path would pick it
// up: the body, a response header, or a network error's message.
const FAILURES: [string, Reply, string][] = [
  [
    'a 401',
    {
      status: 401,
      body: `{"success":false,"message":"bad token Bearer ${SENTINEL_TOKEN}"}`,
      headers: { 'www-authenticate': `Bearer ${SENTINEL_TOKEN}` },
    },
    'akahu_unauthorized (HTTP 401)',
  ],
  [
    'a 500',
    {
      status: 500,
      body: `{"success":false,"message":"X-Akahu-Id ${SENTINEL_APP_ID}"}`,
      headers: { 'x-echo-authorization': `Bearer ${SENTINEL_TOKEN}` },
    },
    'akahu_server (HTTP 500)',
  ],
  [
    'a network drop',
    new Error(`socket hang up; Authorization: Bearer ${SENTINEL_TOKEN}`),
    'akahu_network',
  ],
]

describe('a failed request leaves the database as it was', () => {
  describe.each(STAGES)('at the %s request', (stage) => {
    it.each(FAILURES)('after %s', async (_label, reply, expected) => {
      const { before, runsBefore } = await establish()
      const routes = { ...changedRoutes(), [stage]: reply }

      const result = await runSync({
        client: fakeAkahu(routes).client,
        db,
        now: fixed(LATER),
      })

      await expectFailedRun(result, expected, before, runsBefore)
      expectNoSecret(JSON.stringify(await syncRuns()))
      expectNoSecret(consoleText())
    })
  })

  it('after a missing token, before any request', async () => {
    const { before, runsBefore } = await establish()
    const akahu = fakeAkahu(changedRoutes(), { token: '', appId: SENTINEL_APP_ID })

    const result = await runSync({ client: akahu.client, db, now: fixed(LATER) })

    await expectFailedRun(result, 'akahu_missing_credentials', before, runsBefore)
    expect(akahu.calls).toEqual([])
  })
})

/** The fake client, throwing `error` from the `stage` listing instead. */
function throwingAt(stage: (typeof STAGES)[number], error: unknown): AkahuClient {
  const { client } = fakeAkahu(changedRoutes())
  const fail = async (): Promise<never> => {
    throw error
  }
  return {
    listAccounts: stage === 'accounts' ? fail : client.listAccounts,
    listTransactions:
      stage === 'transactions' ? fail : client.listTransactions,
    listPendingTransactions:
      stage === 'pending' ? fail : client.listPendingTransactions,
  }
}

describe('an error that is not the client’s own', () => {
  it.each(STAGES)(
    'from the %s listing is recorded as a fetch failure, never as its text',
    async (stage) => {
      const { before, runsBefore } = await establish()
      // Shaped like a superagent error: the token in the message and in
      // the request headers it carries.
      const error = Object.assign(
        new Error(`request failed: Authorization: Bearer ${SENTINEL_TOKEN}`),
        {
          response: {
            headers: { authorization: `Bearer ${SENTINEL_TOKEN}` },
            text: `{"token":"${SENTINEL_TOKEN}"}`,
          },
        },
      )

      const result = await runSync({
        client: throwingAt(stage, error),
        db,
        now: fixed(LATER),
      })

      await expectFailedRun(result, 'sync_failed: fetch', before, runsBefore)
      expectNoSecret(JSON.stringify(await syncRuns()))
      expectNoSecret(consoleText())
    },
  )

  it('is cut to 200 characters', async () => {
    const { before, runsBefore } = await establish()
    const code = 'x'.repeat(300) as unknown as AkahuErrorCode
    const result = await runSync({
      client: throwingAt('accounts', new AkahuError(code, 'message', null)),
      db,
      now: fixed(LATER),
    })

    const expected = `akahu_${'x'.repeat(194)}`
    expect(expected).toHaveLength(200)
    await expectFailedRun(result, expected, before, runsBefore)
  })
})

describe('a failed write rolls the whole run back', () => {
  // The trigger's own text carries the token, so a message built from the
  // database error would leak it.
  const TRIGGERS = [
    [
      'the second account’s settled insert',
      `NEW.status = 'settled' AND NEW.account_id = 'acc_fixture0003credit'`,
    ],
    [
      'the second account’s pending insert',
      `NEW.status = 'pending' AND NEW.account_id = 'acc_fixture0003credit'`,
    ],
  ] as const

  it.each(TRIGGERS)('when %s fails', async (_label, when) => {
    const { before, runsBefore } = await establish()
    await db.raw(
      `CREATE TRIGGER fail_write BEFORE INSERT ON transactions
       WHEN ${when}
       BEGIN SELECT RAISE(ABORT, 'Bearer ${SENTINEL_TOKEN}'); END`,
    )

    const result = await runSync({
      client: fakeAkahu(changedRoutes()).client,
      db,
      now: fixed(LATER),
    })

    await expectFailedRun(result, 'sync_failed: write', before, runsBefore)
    expectNoSecret(JSON.stringify(await syncRuns()))
    expectNoSecret(consoleText())

    // With the fault gone, the same data syncs.
    await db.raw('DROP TRIGGER fail_write')
    const retry = await runSync({
      client: fakeAkahu(changedRoutes()).client,
      db,
      now: fixed(at(30 * MINUTE_MS)),
    })
    expect(retry).toEqual({
      outcome: 'success',
      runId: 3,
      insertedCount: 1,
      updatedCount: 1,
      pendingMirroredCount: 1,
    })
    const after = await snapshot()
    expect(after.accounts.map((a) => a.name)).toContain('Fixture Everyday Renamed')
    expect(after.settled.map((t) => t.akahu_id)).toContain(
      'trans_fixture_new_credit',
    )
    expect(after.corrections).toEqual(before.corrections)
  })
})

describe('a run superseded while it fetched', () => {
  it('cannot commit over the run that replaced it', async () => {
    let clock = NOW
    const now = () => clock

    const reachedPending = deferred()
    const releasePending = deferred()
    const routesA = changedRoutes()
    const runA = runSync({
      client: fakeAkahu({
        ...routesA,
        pending: async () => {
          reachedPending.resolve()
          await releasePending.promise
          return routesA.pending as string
        },
      }).client,
      db,
      now,
    })
    await reachedPending.promise

    // Run A has held sync for longer than the stale timeout.
    clock = at(31 * MINUTE_MS)
    const runB = await runSync({ client: fakeAkahu().client, db, now })
    expect(runB).toMatchObject({ outcome: 'success', runId: 2 })
    const afterB = await snapshot()
    const runsAfterB = await syncRuns()

    releasePending.resolve()
    const resultA = await runA

    expect(resultA).toEqual({
      outcome: 'failed',
      runId: 1,
      errorMessage: 'sync_failed: write',
    })
    expect(await snapshot()).toEqual(afterB)
    expect(await syncRuns()).toEqual(runsAfterB)
    expect(runsAfterB[0]).toMatchObject({
      id: 1,
      outcome: 'failed',
      error_message: 'sync_abandoned: run did not finish within the stale timeout',
    })
    expect(afterB.accounts.map((a) => a.name)).not.toContain(
      'Fixture Everyday Renamed',
    )
  })
})

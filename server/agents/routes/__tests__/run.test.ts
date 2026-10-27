import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import { setUserCategory } from '../../../db/transactions.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../test-utils/app.ts'
import { agentScheduler } from '../../scheduler.ts'

// POST /api/v1/agents/run (#58; prd-04 Rulings 2 and 7), over HTTP against
// the real app, its one agent scheduler (never started here, so no timer
// runs) and a fresh in-memory database. The real agents run. Every value is
// invented.
//
// Seams, pass-throughs unless a test sets the hook: the category agent's
// evidence read can be made to throw (the agent then records a failed run) or
// wait on a gate (so a pass stays in flight); the insights agent's aggregate
// query can be made to throw for one scope (a failed insights run); and the
// run log's `finishRun` can be made to throw, so the agent call itself
// rejects.

const hooks = vi.hoisted(() => ({
  failEvidence: false,
  gate: null as Promise<void> | null,
  failScope: null as null | 'personal' | 'strawb',
  failFinish: false,
}))

const FAILURE = vi.hoisted(() => {
  class FixtureReadError extends Error {}
  return { FixtureReadError, message: "select * from transactions where description = 'Sentinel Bound Value'" }
})

vi.mock('../../category/read.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../category/read.ts')>()
  return {
    ...actual,
    loadEvidence: async (...args: Parameters<typeof actual.loadEvidence>) => {
      if (hooks.gate !== null) await hooks.gate
      if (hooks.failEvidence) throw new FAILURE.FixtureReadError(FAILURE.message)
      return actual.loadEvidence(...args)
    },
  }
})

vi.mock('../../insights/queries.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../insights/queries.ts')>()
  return {
    ...actual,
    collectAggregates: async (...args: Parameters<typeof actual.collectAggregates>) => {
      if (hooks.failScope === args[0]) throw new FAILURE.FixtureReadError(FAILURE.message)
      return actual.collectAggregates(...args)
    },
  }
})

vi.mock('../../db/agent-runs.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/agent-runs.ts')>()
  return {
    ...actual,
    finishRun: async (...args: Parameters<typeof actual.finishRun>) => {
      if (hooks.failFinish) throw new FAILURE.FixtureReadError(FAILURE.message)
      return actual.finishRun(...args)
    },
  }
})

let served: LoopbackApi | undefined
let api: LoopbackApi['api']
const spyOnErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})
let errors: ReturnType<typeof spyOnErrors>

beforeEach(async () => {
  hooks.failEvidence = false
  hooks.gate = null
  hooks.failScope = null
  hooks.failFinish = false
  errors = spyOnErrors()
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  // A pass still in flight would write into the next test's database.
  await agentScheduler.whenIdle()
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.restoreAllMocks()
})

afterAll(closeDb)

const STAMP = '2026-10-01T00:00:00.000Z'
const RESPONSE_KEYS = ['agent', 'runs']
const ERROR_KEYS = ['error', 'runId']
const CATEGORY_RESULT_KEYS = ['considered', 'cursor', 'outcome', 'runId', 'skipped', 'written']
const INSIGHTS_RESULT_KEYS = ['considered', 'outcome', 'period', 'rejected', 'runId', 'skipped', 'written']

const sorted = (keys: string[]) => [...keys].sort()
const runRows = (): Promise<Record<string, unknown>[]> => connection('agent_runs').orderBy('id')

// A rule for one merchant and one row it proposes for.
async function seedProposable(): Promise<void> {
  await connection('accounts').insert({
    akahu_id: 'acc_fixture_p', source: 'akahu', scope: 'personal', name: 'Invented', created_at: STAMP, updated_at: STAMP,
  })
  const ids: number[] = []
  for (let i = 1; i <= 3; i += 1) {
    const [row]: { id: number }[] = await connection('transactions')
      .insert({
        akahu_id: `trans_fixture_${i}`,
        account_id: 'acc_fixture_p',
        date: STAMP,
        amount_cents: -1000,
        merchant_id: 'merchant_fixture_one',
        merchant_name: 'Invented Bakery',
        description: 'INVENTED BAKERY',
        category: 'Supermarkets and grocery stores',
        category_source: 'akahu',
        status: 'settled',
        source: 'akahu',
      })
      .returning('id')
    ids.push(row.id)
  }
  for (const id of ids.slice(0, 2)) {
    const moved = await setUserCategory(id, 'Bakeries', connection)
    if (moved === undefined || moved === 'pending') throw new Error('fixture move refused')
  }
}

const post = (body: unknown) => api.post('/api/v1/agents/run').send(body as object)

// Moves every seeded or logged run an hour back, so the next manual POST is
// outside the minimum gap (#454). A test that makes a second manual POST
// after a run uses this rather than waiting ten seconds.
const backdateRuns = () =>
  connection('agent_runs').update({ started_at: new Date(Date.now() - 3_600_000).toISOString() })

describe('400', () => {
  it.each([
    ['no agent', {}],
    ['an unknown agent', { agent: 'budgets' }],
    ['a scope with the category agent', { agent: 'category', scope: 'personal' }],
    ['an unknown scope', { agent: 'insights', scope: 'all' }],
    ['a non-string scope', { agent: 'insights', scope: ['personal'] }],
    ['an array body', [{ agent: 'category' }]],
  ])('refuses %s and runs nothing', async (_name, body) => {
    const res = await post(body)

    expect(res.status).toBe(400)
    expect(sorted(Object.keys(res.body))).toEqual(sorted(ERROR_KEYS))
    expect(res.body.runId).toBeNull()
    expect(await runRows()).toEqual([])
  })
})

describe('200', () => {
  it('category runs one manual run and answers with its result', async () => {
    await seedProposable()

    const res = await post({ agent: 'category' })

    expect(res.status).toBe(200)
    expect(sorted(Object.keys(res.body))).toEqual(sorted(RESPONSE_KEYS))
    expect(res.body.agent).toBe('category')
    expect(res.body.runs).toHaveLength(1)
    const [result] = res.body.runs
    expect(sorted(Object.keys(result))).toEqual(sorted(CATEGORY_RESULT_KEYS))
    expect(result).toMatchObject({ outcome: 'success', written: 1 })
    const runs = await runRows()
    expect(runs.map((r) => [r.id, r.kind, r.trigger, r.outcome])).toEqual([
      [result.runId, 'category', 'manual', 'success'],
    ])
    expect(await connection('category_proposals').where({ status: 'pending' })).toHaveLength(1)
  })

  it('insights with no scope runs every scope', async () => {
    const res = await post({ agent: 'insights' })

    expect(res.status).toBe(200)
    expect(res.body.agent).toBe('insights')
    expect(res.body.runs).toHaveLength(2)
    for (const result of res.body.runs) {
      expect(sorted(Object.keys(result))).toEqual(sorted(INSIGHTS_RESULT_KEYS))
      expect(result.outcome).toBe('success')
    }
    const runs = await runRows()
    expect(runs.map((r) => [r.kind, r.trigger, r.outcome])).toEqual([
      ['insights', 'manual', 'success'],
      ['insights', 'manual', 'success'],
    ])
  })

  it('insights with a scope runs that scope only', async () => {
    const res = await post({ agent: 'insights', scope: 'strawb' })

    expect(res.status).toBe(200)
    expect(res.body.runs).toHaveLength(1)
    expect(await runRows()).toHaveLength(1)
  })
})

describe('409 minimum gap between manual runs (#454)', () => {
  const seedRun = (startedAt: string, trigger: 'manual' | 'weekly' = 'manual') =>
    connection('agent_runs').insert({
      kind: trigger === 'manual' ? 'category' : 'insights',
      trigger,
      started_at: startedAt,
      finished_at: startedAt,
      outcome: 'success',
      considered_count: 0,
      written_count: 0,
    })

  it('refuses a manual run started a few seconds ago, and runs nothing', async () => {
    await seedRun(new Date(Date.now() - 5_000).toISOString())

    const res = await post({ agent: 'insights', scope: 'strawb' })

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'An agent run was started moments ago; try again shortly',
      runId: null,
    })
    expect((await runRows()).map((r) => r.kind)).toEqual(['category'])
  })

  it('reads the newest manual run, not the first one logged', async () => {
    await seedRun(new Date(Date.now() - 3_600_000).toISOString())
    await seedRun(new Date(Date.now() - 5_000).toISOString())

    expect((await post({ agent: 'insights', scope: 'strawb' })).status).toBe(409)
  })

  it('a scheduled run moments ago does not hold back a manual one', async () => {
    await seedRun(new Date(Date.now() - 2_000).toISOString(), 'weekly')

    expect((await post({ agent: 'insights', scope: 'strawb' })).status).toBe(200)
  })

  it('runs normally when the newest manual run started well over ten seconds ago', async () => {
    await seedRun(new Date(Date.now() - 60_000).toISOString())

    const res = await post({ agent: 'insights', scope: 'strawb' })

    expect(res.status).toBe(200)
    expect((await runRows()).map((r) => r.trigger)).toEqual(['manual', 'manual'])
  })
})

describe('409', () => {
  it('refuses while a pass is in flight, then the first run answers', async () => {
    let open: () => void = () => {}
    hooks.gate = new Promise<void>((resolve) => {
      open = resolve
    })

    const first = post({ agent: 'category' }).then((res) => res)
    await vi.waitFor(() => expect(agentScheduler.getState().running).toBe(true))

    const second = await post({ agent: 'insights' })
    expect(second.status).toBe(409)
    expect(second.body).toStrictEqual({ error: 'An agent pass is already running', runId: null })

    open()
    expect((await first).status).toBe(200)
    // The refused request ran nothing: only the category run is logged.
    expect((await runRows()).map((r) => r.kind)).toEqual(['category'])
  })
})

describe('500', () => {
  it('a failed run answers an error naming the run, which agent_runs records, and never the thrown message', async () => {
    hooks.failEvidence = true

    const res = await post({ agent: 'category' })

    expect(res.status).toBe(500)
    const runs = await runRows()
    expect(runs.map((r) => [r.id, r.outcome])).toEqual([[runs[0].id, 'failed']])
    expect(res.body).toStrictEqual({ error: 'Agent run failed', runId: runs[0].id })
    expect(res.text).not.toContain('Sentinel')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')

    // The next run goes ahead.
    await backdateRuns()
    hooks.failEvidence = false
    expect((await post({ agent: 'category' })).status).toBe(200)
  })

  it('a failed insights run answers an error naming that run', async () => {
    hooks.failScope = 'strawb'

    const res = await post({ agent: 'insights' })

    expect(res.status).toBe(500)
    const runs = await runRows()
    expect(runs.map((r) => [r.kind, r.outcome])).toEqual([
      ['insights', 'success'],
      ['insights', 'failed'],
    ])
    expect(res.body).toStrictEqual({ error: 'Agent run failed', runId: runs[1].id })
    expect(res.text).not.toContain('Sentinel')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')
  })

  it('an agent call that rejects answers a fixed error with no run, logged by class only', async () => {
    hooks.failFinish = true

    const res = await post({ agent: 'category' })

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not run agent', runId: null })
    expect(res.text).not.toContain('Sentinel')
    expect(errors).toHaveBeenCalledWith('agents: could not run agent', 'FixtureReadError')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')
    // The scheduler's guard is released: the next run goes ahead.
    await backdateRuns()
    hooks.failFinish = false
    expect((await post({ agent: 'insights', scope: 'personal' })).status).toBe(200)
  })

  it('a gap check that cannot read agent_runs answers a fixed error and runs nothing (#454)', async () => {
    await connection.schema.renameTable('agent_runs', 'agent_runs_hidden')
    try {
      const res = await post({ agent: 'category' })

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not run agent', runId: null })
      expect(agentScheduler.getState().running).toBe(false)
    } finally {
      await connection.schema.renameTable('agent_runs_hidden', 'agent_runs')
    }
    expect(await runRows()).toEqual([])
  })
})

describe('403', () => {
  it('a cross-site request is refused before anything runs', async () => {
    const res = await post({ agent: 'category' }).set('Sec-Fetch-Site', 'cross-site')

    expect(res.status).toBe(403)
    expect(res.body).toStrictEqual({ error: 'Forbidden' })
    expect(await runRows()).toEqual([])
  })
})

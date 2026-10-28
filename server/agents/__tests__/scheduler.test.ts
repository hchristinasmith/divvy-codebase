import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../../db/connection.ts'
import { setUserCategory } from '../../db/transactions.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import { runCategoryAgent, type CategoryRunResult } from '../category/agent.ts'
import type { Transport } from '../llm/client.ts'
import { recording, untouchable } from '../llm/__tests__/fakes.ts'
import { finishRun, startRun } from '../db/agent-runs.ts'
import { runInsightsAgent } from '../insights/agent.ts'
import {
  AGENT_INTERVAL_MS,
  createAgentScheduler,
  weeklyDueDay,
  type AgentSchedulerDeps,
} from '../scheduler.ts'

// The agent scheduler (#58; prd-04 Rulings 2, 5 and 7): the category agent
// once per completed sync run, oldest first and one per tick; the weekly
// insights pass once per NZ week; one pass at a time; stale runs closed at
// start; and every failure recorded while the ticks go on. Each test starts
// from an empty, freshly migrated in-memory database, and the real agents
// run unless a test injects one. Every merchant, account and category text
// is invented.
//
// Seams, pass-throughs unless a test sets the hook: the category agent's
// evidence read and the insights agent's aggregate query can be made to
// throw, which the real agents record as a failed run; and the run log's
// `finishRun` can be made to throw, so start()'s close of stale runs fails.

const hooks = vi.hoisted(() => ({
  failEvidence: false,
  failScope: null as null | 'personal' | 'strawb',
  failFinish: false,
}))

const FAILURE = vi.hoisted(() => {
  class FixtureReadError extends Error {}
  return { FixtureReadError, message: "select * from transactions where description = 'Sentinel Bound Value'" }
})

vi.mock('../category/read.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../category/read.ts')>()
  return {
    ...actual,
    loadEvidence: async (...args: Parameters<typeof actual.loadEvidence>) => {
      if (hooks.failEvidence) throw new FAILURE.FixtureReadError(FAILURE.message)
      return actual.loadEvidence(...args)
    },
  }
})

vi.mock('../db/agent-runs.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/agent-runs.ts')>()
  return {
    ...actual,
    finishRun: async (...args: Parameters<typeof actual.finishRun>) => {
      if (hooks.failFinish) throw new FAILURE.FixtureReadError(FAILURE.message)
      return actual.finishRun(...args)
    },
  }
})

vi.mock('../insights/queries.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../insights/queries.ts')>()
  return {
    ...actual,
    collectAggregates: async (...args: Parameters<typeof actual.collectAggregates>) => {
      if (hooks.failScope === args[0]) throw new FAILURE.FixtureReadError(FAILURE.message)
      return actual.collectAggregates(...args)
    },
  }
})

const STAMP = '2026-10-01T00:00:00.000Z'
// Thursday 22 October 2026, 12:00 NZDT: inside a week whose pass is done
// once a tick runs it.
const NOW = new Date('2026-10-21T23:00:00.000Z')
const BAKERY = 'Bakeries'
const GROCER = 'Supermarkets and grocery stores'

const spyOnErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})
let errors: ReturnType<typeof spyOnErrors>

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  hooks.failEvidence = false
  hooks.failScope = null
  hooks.failFinish = false
  seq = 0
  errors = spyOnErrors()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await connection.destroy()
})

let seq = 0

async function seedAccounts(): Promise<void> {
  await connection('accounts').insert([
    { akahu_id: 'acc_fixture_p', source: 'akahu', scope: 'personal', name: 'Invented', created_at: STAMP, updated_at: STAMP },
  ])
}

// A settled Akahu row of one merchant, categorised GROCER by Akahu.
async function tx(): Promise<number> {
  seq += 1
  const [row]: { id: number }[] = await connection('transactions')
    .insert({
      akahu_id: `trans_fixture_${seq}`,
      account_id: 'acc_fixture_p',
      date: STAMP,
      amount_cents: -1000,
      merchant_id: 'merchant_fixture_one',
      merchant_name: 'Invented Bakery',
      description: 'INVENTED BAKERY',
      category: GROCER,
      category_source: 'akahu',
      status: 'settled',
      source: 'akahu',
    })
    .returning('id')
  return row.id
}

// Two rows Hannah moved to BAKERY: a rule for the merchant (Ruling 7's N).
async function learnRule(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const moved = await setUserCategory(await tx(), BAKERY, connection)
    if (moved === undefined || moved === 'pending') throw new Error('fixture move refused')
  }
}

async function syncRun(outcome: 'success' | 'failed' = 'success'): Promise<number> {
  const [row]: { id: number }[] = await connection('sync_runs')
    .insert({
      started_at: STAMP,
      finished_at: STAMP,
      outcome,
      error_message: outcome === 'failed' ? 'fixture' : null,
    })
    .returning('id')
  return row.id
}

type Row = Record<string, unknown>
const runRows = (): Promise<Row[]> => connection('agent_runs').orderBy('id')
const categoryRuns = async () => (await runRows()).filter((r) => r.kind === 'category')
const insightsRuns = async () => (await runRows()).filter((r) => r.kind === 'insights')
const pendingCount = async () =>
  (await connection('category_proposals').where({ status: 'pending' })).length

function scheduler(deps: AgentSchedulerDeps = {}) {
  return createAgentScheduler({ db: connection, now: () => NOW, ...deps })
}

async function tick(s: ReturnType<typeof scheduler>) {
  expect(s.trigger()).toStrictEqual({ started: true })
  await s.whenIdle()
}

describe('nothing runs until start()', () => {
  it('importing the module starts no timer and leaves the scheduler unstarted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.resetModules()
    const mod = await import('../scheduler.ts')

    expect(vi.getTimerCount()).toBe(0)
    expect(mod.agentScheduler.getState()).toStrictEqual({
      started: false,
      stopped: false,
      running: false,
      nextRunAt: null,
    })
  })
})

describe('the category agent per sync run', () => {
  it('a completed sync run produces pending proposals once; a second poll and a restart do not run it again', async () => {
    await seedAccounts()
    await learnRule()
    await tx()
    const syncRunId = await syncRun()
    await syncRun('failed')

    const first = scheduler()
    await tick(first)

    expect(await pendingCount()).toBe(1)
    const runs = await categoryRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ trigger: 'sync', sync_run_id: syncRunId, outcome: 'success' })

    await tick(first)
    expect(await categoryRuns()).toHaveLength(1)

    // A restart: a new instance, started and stopped as the process would.
    const restarted = scheduler()
    restarted.start()
    await restarted.whenIdle()
    await tick(restarted)
    restarted.stop()

    expect(await categoryRuns()).toHaveLength(1)
    expect(await pendingCount()).toBe(1)
  })

  it('takes the oldest unprocessed sync run each tick, so a backlog larger than a batch takes several ticks', async () => {
    await seedAccounts()
    await learnRule()
    for (let i = 0; i < 5; i += 1) await tx()
    const syncIds: number[] = []
    for (let i = 0; i < 4; i += 1) syncIds.push(await syncRun())
    const s = scheduler({ categoryConfig: { batchSize: 2 } })

    const pending: number[] = []
    for (let i = 0; i < 5; i += 1) {
      await tick(s)
      pending.push(await pendingCount())
    }

    // Two, two and one; the fourth sync run's batch is past the end, and the
    // fifth tick has no sync run left to take.
    expect(pending).toEqual([2, 4, 5, 5, 5])
    const runs = await categoryRuns()
    expect(runs.map((r) => r.sync_run_id)).toEqual(syncIds)
    expect(runs.every((r) => r.outcome === 'success')).toBe(true)
  })
})

describe('a blocked category run (#430)', () => {
  it('counts as having processed its sync run, so the next tick does not retry it; the backlog resumes at the next sync', async () => {
    await seedAccounts()
    // A merchant with no rule: its row goes to the model.
    seq += 1
    await connection('transactions').insert({
      akahu_id: `trans_fixture_${seq}`,
      account_id: 'acc_fixture_p',
      date: STAMP,
      amount_cents: -1000,
      merchant_id: 'merchant_fixture_two',
      merchant_name: 'Invented Florist',
      description: 'INVENTED FLORIST',
      category: GROCER,
      category_source: 'akahu',
      status: 'settled',
      source: 'akahu',
    })
    const first = await syncRun()
    let deps: { transport: Transport; env: Record<string, string> } = {
      transport: untouchable().transport,
      env: { ANTHROPIC_API_KEY: 'sk-ant-invented', AGENT_KILL_SWITCH: '1' },
    }
    const s = scheduler({
      runCategoryAgent: (options, clock, db) => runCategoryAgent(options, clock, db, deps),
    })

    await tick(s)
    await tick(s)
    expect((await categoryRuns()).map((r) => [r.outcome, r.sync_run_id])).toEqual([['blocked', first]])

    // Switched off, and a new sync: that sync's run sends the row.
    const sent = recording([[100, 20]])
    deps = { transport: sent.transport, env: { ANTHROPIC_API_KEY: 'sk-ant-invented' } }
    const second = await syncRun()
    await tick(s)
    await tick(s)
    expect((await categoryRuns()).map((r) => [r.outcome, r.sync_run_id])).toEqual([
      ['blocked', first],
      ['success', second],
    ])
    expect(sent.bodies).toHaveLength(1)
  })
})

describe('one pass at a time', () => {
  it('two overlapping triggers, and a manual run during them, run one agent pass', async () => {
    await syncRun()
    let release: (r: CategoryRunResult) => void = () => {}
    const runCategory = vi.fn(
      () =>
        new Promise<CategoryRunResult>((resolve) => {
          release = resolve
        }),
    )
    const s = scheduler({ runCategoryAgent: runCategory })

    expect(s.trigger()).toStrictEqual({ started: true })
    expect(s.trigger()).toStrictEqual({ started: false, reason: 'already_running' })
    expect(s.runNow({ agent: 'category' })).toStrictEqual({ started: false, reason: 'already_running' })
    expect(s.getState().running).toBe(true)

    await vi.waitFor(() => expect(runCategory).toHaveBeenCalledTimes(1))
    release({ runId: 1, outcome: 'success', considered: 0, written: 0, skipped: 0, discarded: 0, cursor: null })
    await s.whenIdle()

    expect(runCategory).toHaveBeenCalledTimes(1)
    expect(s.getState().running).toBe(false)
  })

  it('a timer tick that arrives during a pass is refused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await syncRun()
    let release: (r: CategoryRunResult) => void = () => {}
    const runCategory = vi.fn(
      () =>
        new Promise<CategoryRunResult>((resolve) => {
          release = resolve
        }),
    )
    const s = scheduler({ runCategoryAgent: runCategory })
    s.start()
    await s.whenIdle()

    await vi.advanceTimersByTimeAsync(AGENT_INTERVAL_MS)
    await vi.waitFor(() => expect(runCategory).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(AGENT_INTERVAL_MS * 2)
    expect(runCategory).toHaveBeenCalledTimes(1)

    release({ runId: 1, outcome: 'success', considered: 0, written: 0, skipped: 0, discarded: 0, cursor: null })
    await s.whenIdle()
    s.stop()
    expect(s.getState().started).toBe(false)
  })
})

describe('stop() during the shutdown drain (#462)', () => {
  it('refuses trigger() and runNow() from stop() on, so the pass in flight is the only one', async () => {
    await syncRun()
    let release: (r: CategoryRunResult) => void = () => {}
    const runCategory = vi.fn(
      () =>
        new Promise<CategoryRunResult>((resolve) => {
          release = resolve
        }),
    )
    const s = scheduler({ runCategoryAgent: runCategory })

    expect(s.trigger()).toStrictEqual({ started: true })
    await vi.waitFor(() => expect(runCategory).toHaveBeenCalledTimes(1))

    s.stop()
    expect(s.trigger()).toStrictEqual({ started: false, reason: 'stopped' })
    expect(s.runNow({ agent: 'category' })).toStrictEqual({ started: false, reason: 'stopped' })
    expect(s.getState()).toMatchObject({ running: true, stopped: true })

    release({ runId: 1, outcome: 'success', considered: 0, written: 0, skipped: 0, discarded: 0, cursor: null })
    await s.whenIdle()

    // Still refused after the drain: a manual run would call the agent again.
    expect(s.trigger()).toStrictEqual({ started: false, reason: 'stopped' })
    expect(s.runNow({ agent: 'category' })).toStrictEqual({ started: false, reason: 'stopped' })
    expect(runCategory).toHaveBeenCalledTimes(1)
    expect(s.getState()).toMatchObject({ running: false, stopped: true })
  })

  it('start() after stop() lifts the refusal, and runNow() runs the agent again', async () => {
    const runCategory = vi.fn(
      async (): Promise<CategoryRunResult> => ({
        runId: 1,
        outcome: 'success',
        considered: 0,
        written: 0,
        skipped: 0,
        discarded: 0,
        cursor: null,
      }),
    )
    const s = scheduler({ runCategoryAgent: runCategory })
    s.stop()
    expect(s.runNow({ agent: 'category' })).toStrictEqual({ started: false, reason: 'stopped' })
    expect(runCategory).not.toHaveBeenCalled()

    s.start()
    await s.whenIdle()
    const run = s.runNow({ agent: 'category' })
    if (!run.started) throw new Error('runNow refused after start()')
    await run.result
    s.stop()

    expect(runCategory).toHaveBeenCalledTimes(1)
  })
})

describe('the weekly insights pass', () => {
  // Pacific/Auckland is UTC+13 throughout (NZDT, 27 Sep 2026 to 5 Apr 2027).
  const nz = (local: string) => new Date(new Date(`${local}Z`).getTime() - 13 * 3_600_000)

  it('runs once per NZ week per scope, from Wednesday 00:00; a week boundary neither double-fires nor skips', async () => {
    let at = nz('2026-10-21T12:00:00')
    const calls: string[] = []
    const s = scheduler({
      now: () => at,
      runInsightsAgent: (scope, options, clock, db) => {
        calls.push(`${scope} ${options.period} ${options.trigger}`)
        return runInsightsAgent(scope, options, clock, db)
      },
    })

    await tick(s) // Wednesday 21 Oct: the week of 12 to 18 Oct
    await tick(s)
    at = nz('2026-10-25T23:59:59') // Sunday
    await tick(s)
    at = nz('2026-10-27T23:59:59') // Tuesday, a second before the next due moment
    await tick(s)
    expect(calls).toEqual(['personal 2026-W42 weekly', 'strawb 2026-W42 weekly'])

    at = nz('2026-10-28T00:00:00') // Wednesday 00:00
    await tick(s)
    await tick(s)
    // No tick from Wednesday 4 Nov to Sunday; the week is still run on Monday.
    at = nz('2026-11-09T09:00:00')
    await tick(s)
    at = nz('2026-11-11T00:00:00')
    await tick(s)

    expect(calls).toEqual([
      'personal 2026-W42 weekly',
      'strawb 2026-W42 weekly',
      'personal 2026-W43 weekly',
      'strawb 2026-W43 weekly',
      'personal 2026-W44 weekly',
      'strawb 2026-W44 weekly',
      'personal 2026-W45 weekly',
      'strawb 2026-W45 weekly',
    ])
    const runs = await insightsRuns()
    expect(runs).toHaveLength(calls.length)
    expect(runs.every((r) => r.trigger === 'weekly' && r.outcome === 'success')).toBe(true)
  })

  it('the due day is the latest Wednesday at or before the NZ date', () => {
    expect(weeklyDueDay(nz('2026-10-27T23:59:59'))).toBe('2026-10-21')
    expect(weeklyDueDay(nz('2026-10-28T00:00:00'))).toBe('2026-10-28')
    expect(weeklyDueDay(nz('2026-11-01T12:00:00'))).toBe('2026-10-28')
    // 11:00 UTC Tuesday is already Wednesday in NZ.
    expect(weeklyDueDay(new Date('2026-10-27T11:00:00.000Z'))).toBe('2026-10-28')
  })

  it('a failed scope is recorded and the next tick runs the pass again, then stops', async () => {
    hooks.failScope = 'strawb'
    const s = scheduler()

    await tick(s)
    let runs = await insightsRuns()
    expect(runs.map((r) => r.outcome)).toEqual(['success', 'failed'])
    expect(errors).toHaveBeenCalledWith('insights agent: run failed', 'FixtureReadError')

    hooks.failScope = null
    await tick(s)
    await tick(s)
    runs = await insightsRuns()
    expect(runs.map((r) => r.outcome)).toEqual(['success', 'failed', 'success', 'success'])
  })
})

describe('the weekly due check stays honest without a scope column', () => {
  type Insights = NonNullable<AgentSchedulerDeps['runInsightsAgent']>
  // Logs a weekly run per call, as the real agent does, unless its scope is
  // set to reject before logging anything.
  function fakeInsights(calls: string[], reject: { scope: string | null }): Insights {
    return async (scope, options, clock, db) => {
      calls.push(`${scope} ${options.period}`)
      if (reject.scope === scope) throw new FAILURE.FixtureReadError(FAILURE.message)
      const run = await startRun({ kind: 'insights', trigger: 'weekly' }, clock(), db)
      await finishRun(run.id, { outcome: 'success', consideredCount: 0, writtenCount: 0 }, clock(), db)
      return { runId: run.id, outcome: 'success', period: options.period ?? '', considered: 0, written: 0, skipped: 0, rejected: [] }
    }
  }

  it('a scope that rejects before logging a run gets a failed run logged, so two runs of the other scope never finish the week', async () => {
    const calls: string[] = []
    const reject = { scope: 'strawb' as string | null }
    const s = scheduler({ runInsightsAgent: fakeInsights(calls, reject) })

    await tick(s)
    await tick(s)
    expect((await insightsRuns()).map((r) => [r.trigger, r.outcome])).toEqual([
      ['weekly', 'success'],
      ['weekly', 'failed'],
      ['weekly', 'success'],
      ['weekly', 'failed'],
    ])
    expect(errors).toHaveBeenCalledWith('agent scheduler: insights run rejected', 'FixtureReadError')

    reject.scope = null
    await tick(s)
    await tick(s)
    expect(calls.filter((c) => c.startsWith('strawb'))).toEqual([
      'strawb 2026-W42',
      'strawb 2026-W42',
      'strawb 2026-W42',
    ])
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')
  })

  it('when logging the rejected run also fails, it is logged by class only and the pass goes on', async () => {
    const calls: string[] = []
    const s = scheduler({ runInsightsAgent: fakeInsights(calls, { scope: 'personal' }) })
    hooks.failFinish = true

    await tick(s)

    expect(calls).toEqual(['personal 2026-W42', 'strawb 2026-W42'])
    expect(errors).toHaveBeenCalledWith('agent scheduler: could not log rejected insights run', 'FixtureReadError')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')
  })

  it('a call that rejects after logging its run gets no second row', async () => {
    const s = scheduler({
      runInsightsAgent: async (_scope, _options, clock, db) => {
        await startRun({ kind: 'insights', trigger: 'weekly' }, clock(), db)
        throw new FAILURE.FixtureReadError(FAILURE.message)
      },
    })

    await tick(s)

    expect((await insightsRuns()).map((r) => r.outcome)).toEqual(['running', 'running'])
  })

  it('a retry of last week that crosses into the next due day stops, so the new week still runs', async () => {
    // Pacific/Auckland is UTC+13 here (NZDT).
    const calls: string[] = []
    const reject = { scope: 'strawb' as string | null }
    let clock = (): Date => new Date('2026-10-21T00:00:00.000Z') // Wed 21 Oct, 13:00
    const s = scheduler({ now: () => clock(), runInsightsAgent: fakeInsights(calls, reject) })
    await tick(s) // the W42 pass: strawb fails
    reject.scope = null

    // The due check reads Tuesday 23:59:59.999; every later reading is
    // already Wednesday.
    let readings = 0
    clock = () =>
      readings++ === 0
        ? new Date('2026-10-27T10:59:59.999Z')
        : new Date('2026-10-27T11:00:00.001Z')
    await tick(s)
    clock = () => new Date('2026-10-28T00:00:00.000Z') // Wed 28 Oct, 13:00
    await tick(s)

    expect(calls).toEqual([
      'personal 2026-W42',
      'strawb 2026-W42',
      'personal 2026-W43',
      'strawb 2026-W43',
    ])
  })
})

describe('failure', () => {
  it('a failed category run is in agent_runs, and the timer keeps ticking and retries its sync run', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await seedAccounts()
    await learnRule()
    await tx()
    const syncRunId = await syncRun()
    hooks.failEvidence = true
    const s = scheduler()
    s.start()
    await s.whenIdle()

    await vi.advanceTimersByTimeAsync(AGENT_INTERVAL_MS)
    await s.whenIdle()
    let runs = await categoryRuns()
    expect(runs.map((r) => [r.outcome, r.sync_run_id])).toEqual([['failed', syncRunId]])
    expect(await pendingCount()).toBe(0)

    hooks.failEvidence = false
    await vi.advanceTimersByTimeAsync(AGENT_INTERVAL_MS)
    await s.whenIdle()
    s.stop()
    runs = await categoryRuns()
    expect(runs.map((r) => [r.outcome, r.sync_run_id])).toEqual([
      ['failed', syncRunId],
      ['success', syncRunId],
    ])
    expect(await pendingCount()).toBe(1)
    const logged = errors.mock.calls.flat().join(' ')
    expect(logged).not.toContain('Sentinel')
  })

  it('an agent call that rejects is logged by class only, and the next tick calls it again', async () => {
    await syncRun()
    const runCategory = vi.fn(async (): Promise<CategoryRunResult> => {
      throw new FAILURE.FixtureReadError(FAILURE.message)
    })
    const s = scheduler({ runCategoryAgent: runCategory })

    await tick(s)
    await tick(s)

    expect(runCategory).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledWith('agent scheduler: category run rejected', 'FixtureReadError')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')
    // The weekly pass still ran on each tick's other half.
    expect((await insightsRuns()).length).toBeGreaterThan(0)
  })
})

describe('stale runs', () => {
  it('start() closes every running run as failed and leaves finished runs alone', async () => {
    const before = new Date('2026-10-20T00:00:00.000Z')
    const staleCategory = await startRun({ kind: 'category', trigger: 'manual' }, before, connection)
    const staleInsights = await startRun({ kind: 'insights', trigger: 'weekly' }, before, connection)
    const finished = await startRun({ kind: 'category', trigger: 'manual' }, before, connection)
    await finishRun(finished.id, { outcome: 'success', consideredCount: 3, writtenCount: 1 }, before, connection)
    const s = scheduler()

    s.start()
    expect(s.trigger()).toStrictEqual({ started: false, reason: 'already_running' })
    await s.whenIdle()
    s.stop()

    const runs = await runRows()
    expect(runs.map((r) => [r.id, r.outcome, r.finished_at])).toEqual([
      [staleCategory.id, 'failed', NOW.toISOString()],
      [staleInsights.id, 'failed', NOW.toISOString()],
      [finished.id, 'success', before.toISOString()],
    ])
  })

  it('a close that fails is logged by class only, the run stays running, and the timer still ticks', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const stale = await startRun({ kind: 'category', trigger: 'manual' }, new Date(STAMP), connection)
    const syncRunId = await syncRun()
    hooks.failFinish = true
    const s = scheduler()

    s.start()
    await s.whenIdle()
    expect(errors).toHaveBeenCalledWith('agent scheduler: could not close stale runs', 'FixtureReadError')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Sentinel')
    expect((await runRows()).map((r) => [r.id, r.outcome])).toEqual([[stale.id, 'running']])

    hooks.failFinish = false
    await vi.advanceTimersByTimeAsync(AGENT_INTERVAL_MS)
    await s.whenIdle()
    s.stop()
    const runs = await categoryRuns()
    expect(runs.map((r) => [r.id === stale.id, r.outcome, r.sync_run_id])).toEqual([
      [true, 'running', null],
      [false, 'success', syncRunId],
    ])
  })
})

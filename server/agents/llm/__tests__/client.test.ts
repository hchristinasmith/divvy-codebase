import { randomUUID } from 'node:crypto'
import { format } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import type { AgentRun } from '../../contracts.ts'
import { startModelRun, type CompleteParams, type ModelRunDeps } from '../client.ts'
import { params, priorRun, recording, untouchable } from './fakes.ts'

// The one Claude API client (#429; prd-04 Rulings 1, 4 and 9, Done-when 6).
// Each test starts from an empty, freshly migrated in-memory database; no
// test touches the network; every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await connection.destroy()
})

// 28 October 2026, 14:00 in Auckland (NZDT, UTC+13).
const NOW = new Date('2026-10-28T01:00:00.000Z')
const clock = () => NOW
// Earlier the same Auckland day, though the previous UTC day.
const EARLIER_TODAY = '2026-10-27T20:00:00.000Z'
// 27 October 23:00 in Auckland: within 24 hours, but yesterday there.
const NZ_YESTERDAY = '2026-10-27T10:00:00.000Z'

const MODEL = 'claude-haiku-5-5'

const RUN_KEYS = [
  'id',
  'kind',
  'trigger',
  'started_at',
  'finished_at',
  'outcome',
  'considered_count',
  'written_count',
  'sync_run_id',
  'cursor',
  'model',
  'input_tokens',
  'output_tokens',
  'cost_micro_usd',
].sort()

const START = { kind: 'category', trigger: 'manual' } as const

const env = (fields: Record<string, string> = {}): Record<string, string | undefined> => ({
  ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`,
  ...fields,
})

const deps = (fields: ModelRunDeps): ModelRunDeps => ({ clock, db: connection, ...fields })

async function row(id: number): Promise<AgentRun> {
  const found: AgentRun | undefined = await connection('agent_runs').where({ id }).first()
  if (found === undefined) throw new Error('no such run')
  return found
}

const usageOf = (r: AgentRun) => ({
  outcome: r.outcome,
  model: r.model,
  input_tokens: r.input_tokens,
  output_tokens: r.output_tokens,
  cost_micro_usd: r.cost_micro_usd,
})

const done = { outcome: 'success', consideredCount: 3, writtenCount: 1 } as const

function quiet() {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('the kill switch', () => {
  it('blocks before any call and logs a blocked run with its model', async () => {
    quiet()
    const wire = untouchable()
    const run = await startModelRun(
      START,
      deps({ transport: wire.transport, env: env({ AGENT_KILL_SWITCH: '1' }) }),
    )
    expect(await run.complete(params)).toEqual({ status: 'blocked', reason: 'kill_switch' })
    expect(wire.calls()).toBe(0)
    expect(await run.finish(done)).toBe(true)

    const stored = await row(run.id)
    expect(Object.keys(stored).sort()).toEqual(RUN_KEYS)
    expect(usageOf(stored)).toEqual({
      outcome: 'blocked',
      model: MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cost_micro_usd: 0,
    })
    expect(stored.considered_count).toBe(3)
    expect(stored.written_count).toBe(1)
  })

  it('is read on every call: set after a first call, it blocks the next', async () => {
    quiet()
    const wire = recording([[1000, 100]])
    const vars = env()
    const run = await startModelRun(START, deps({ transport: wire.transport, env: vars }))
    expect((await run.complete(params)).status).toBe('ok')
    vars.AGENT_KILL_SWITCH = 'on'
    expect(await run.complete(params)).toEqual({ status: 'blocked', reason: 'kill_switch' })
    expect(wire.bodies).toHaveLength(1)
    await run.finish(done)
    // The call made before the stop is still logged (contracts.ts).
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'blocked',
      model: MODEL,
      input_tokens: 1000,
      output_tokens: 100,
      cost_micro_usd: 150,
    })
  })

  it('reads process.env when no env is given', async () => {
    quiet()
    vi.stubEnv('AGENT_KILL_SWITCH', 'yes')
    const wire = untouchable()
    const run = await startModelRun(START, { transport: wire.transport, clock, db: connection })
    expect(await run.complete(params)).toEqual({ status: 'blocked', reason: 'kill_switch' })
    expect(wire.calls()).toBe(0)
  })

  it('keeps a blocked run blocked once the switch is cleared', async () => {
    quiet()
    const wire = untouchable()
    const vars = env({ AGENT_KILL_SWITCH: '1' })
    const run = await startModelRun(START, deps({ transport: wire.transport, env: vars }))
    expect((await run.complete(params)).status).toBe('blocked')
    delete vars.AGENT_KILL_SWITCH
    expect(await run.complete(params)).toEqual({ status: 'blocked', reason: 'kill_switch' })
    expect(wire.calls()).toBe(0)
  })
})

describe('the daily budget', () => {
  it('blocks before any call when today’s logged tokens already meet it', async () => {
    quiet()
    await priorRun(EARLIER_TODAY, 600, 400)
    const wire = untouchable()
    const run = await startModelRun(
      START,
      deps({ transport: wire.transport, env: env({ AGENT_DAILY_TOKEN_BUDGET: '1000' }) }),
    )
    expect(await run.complete(params)).toEqual({ status: 'blocked', reason: 'budget' })
    expect(wire.calls()).toBe(0)
    await run.finish(done)
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'blocked',
      model: MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cost_micro_usd: 0,
    })
  })

  it('stops a run partway once its own calls cross it', async () => {
    quiet()
    // 200 earlier today; each call spends 400. Before the third call the day
    // stands at 1000, which meets the budget.
    await priorRun(EARLIER_TODAY, 150, 50)
    const wire = recording([[300, 100]])
    const run = await startModelRun(
      START,
      deps({ transport: wire.transport, env: env({ AGENT_DAILY_TOKEN_BUDGET: '1000' }) }),
    )
    const statuses: string[] = []
    for (let i = 0; i < 5; i += 1) statuses.push((await run.complete(params)).status)
    expect(statuses).toEqual(['ok', 'ok', 'blocked', 'blocked', 'blocked'])
    expect(wire.bodies).toHaveLength(2)
    await run.finish(done)
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'blocked',
      model: MODEL,
      input_tokens: 600,
      output_tokens: 200,
      cost_micro_usd: 160,
    })
  })

  it('does not count yesterday in Auckland', async () => {
    quiet()
    await priorRun(NZ_YESTERDAY, 5000, 5000)
    const wire = recording([[10, 1]])
    const run = await startModelRun(
      START,
      deps({ transport: wire.transport, env: env({ AGENT_DAILY_TOKEN_BUDGET: '1000' }) }),
    )
    expect((await run.complete(params)).status).toBe('ok')
    expect(wire.bodies).toHaveLength(1)
  })

  it('sees a run logged between two calls (no cached total)', async () => {
    quiet()
    const wire = recording([[300, 100]])
    const run = await startModelRun(
      START,
      deps({ transport: wire.transport, env: env({ AGENT_DAILY_TOKEN_BUDGET: '1000' }) }),
    )
    expect((await run.complete(params)).status).toBe('ok')
    // Without this row the next call would be allowed: 400 < 1000.
    await priorRun(EARLIER_TODAY, 500, 100)
    expect(await run.complete(params)).toEqual({ status: 'blocked', reason: 'budget' })
    expect(wire.bodies).toHaveLength(1)
  })
})

describe('usage on agent_runs', () => {
  it('sums a successful run’s calls, each call’s cost rounded up', async () => {
    const wire = recording([
      [1234, 56],
      [999, 1],
    ])
    const run = await startModelRun(START, deps({ transport: wire.transport, env: env() }))
    expect((await run.complete(params)).status).toBe('ok')
    expect((await run.complete(params)).status).toBe('ok')
    expect(await run.finish(done)).toBe(true)
    // 151.4 → 152 and 100.4 → 101 micro-USD.
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'success',
      model: MODEL,
      input_tokens: 2233,
      output_tokens: 57,
      cost_micro_usd: 253,
    })
  })

  it('logs a failed call with its model and no tokens', async () => {
    quiet()
    const run = await startModelRun(
      START,
      deps({ transport: async () => Promise.reject(new TypeError('socket hang up')), env: env() }),
    )
    await expect(run.complete(params)).rejects.toThrow('model call failed: TypeError')
    await run.finish({ ...done, outcome: 'failed' })
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'failed',
      model: MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cost_micro_usd: 0,
    })
  })

  it('keeps the usage of calls made before a failure', async () => {
    quiet()
    let calls = 0
    const run = await startModelRun(
      START,
      deps({
        transport: async (body) => {
          calls += 1
          if (calls > 1) throw new Error('overloaded')
          return recording([[1000, 100]]).transport(body)
        },
        env: env(),
      }),
    )
    expect((await run.complete(params)).status).toBe('ok')
    await expect(run.complete(params)).rejects.toThrow('model call failed')
    await run.finish({ ...done, outcome: 'failed' })
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'failed',
      model: MODEL,
      input_tokens: 1000,
      output_tokens: 100,
      cost_micro_usd: 150,
    })
  })

  it('refuses without a key before any call, and logs the attempt', async () => {
    quiet()
    const wire = untouchable()
    const run = await startModelRun(START, deps({ transport: wire.transport, env: {} }))
    await expect(run.complete(params)).rejects.toThrow('model call refused: no API key configured')
    expect(wire.calls()).toBe(0)
    await run.finish({ ...done, outcome: 'failed' })
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'failed',
      model: MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cost_micro_usd: 0,
    })
  })

  it('ends a blocked run failed when its caller says so', async () => {
    quiet()
    const run = await startModelRun(
      START,
      deps({ transport: untouchable().transport, env: env({ AGENT_KILL_SWITCH: '1' }) }),
    )
    await run.complete(params)
    await run.finish({ ...done, outcome: 'failed' })
    expect((await row(run.id)).outcome).toBe('failed')
  })

  it('leaves the usage columns null when complete was never called', async () => {
    const run = await startModelRun(START, deps({ transport: untouchable().transport, env: env() }))
    await run.finish(done)
    expect(usageOf(await row(run.id))).toEqual({
      outcome: 'success',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_micro_usd: null,
    })
  })

  it('refuses a call after the run finished, without sending it', async () => {
    const wire = untouchable()
    const run = await startModelRun(START, deps({ transport: wire.transport, env: env() }))
    await run.finish(done)
    await expect(run.complete(params)).rejects.toThrow('model run already finished')
    expect(wire.calls()).toBe(0)
  })
})

describe('the request', () => {
  it('sends the caller’s params with the model from config', async () => {
    const wire = recording([[10, 1]])
    const run = await startModelRun(START, deps({ transport: wire.transport, env: env() }))
    await run.complete(params)
    expect(wire.bodies).toHaveLength(1)
    const [body] = wire.bodies
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system'])
    expect(body).toEqual({ ...params, model: MODEL })
  })

  it('ignores a model the caller slips in', async () => {
    const wire = recording([[10, 1]])
    const run = await startModelRun(START, deps({ transport: wire.transport, env: env() }))
    const sneaky = { ...params, model: 'invented-expensive-model' } as CompleteParams
    await run.complete(sneaky)
    expect(wire.bodies[0].model).toBe(MODEL)
  })

  it('refuses a model run for the insights agent before logging it (Ruling 9)', async () => {
    await expect(
      startModelRun({ kind: 'insights', trigger: 'weekly' }, deps({ env: env() })),
    ).rejects.toThrow('only the category agent calls a model')
    expect(await connection('agent_runs').count({ n: '*' })).toEqual([{ n: 0 }])
  })
})

describe('the key never reaches output', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

  async function failWith(thrown: (key: string) => unknown) {
    const key = `sk-ant-test-${randomUUID()}`
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const run = await startModelRun(
      START,
      deps({
        transport: async () => {
          throw thrown(key)
        },
        env: { ANTHROPIC_API_KEY: key },
      }),
    )
    let caught: unknown
    try {
      await run.complete(params)
    } catch (err) {
      caught = err
    }
    await run.finish({ ...done, outcome: 'failed' })
    const lines = spies.flatMap((spy) => spy.mock.calls.map((args) => format(...args)))
    return { key, caught, lines }
  }

  it('an API error repeating the key leaves it out of every log line and the thrown error', async () => {
    const { key, caught, lines } = await failWith((k) =>
      Anthropic.APIError.generate(
        401,
        { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${k}` } },
        `401 invalid x-api-key ${k}`,
        new Headers({ 'x-api-key': k }),
      ),
    )
    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error
    expect(err.message).toBe('model call failed: AuthenticationError (status 401)')
    expect(err.message).not.toContain(key)
    expect(String(err.stack)).not.toContain(key)
    // No cause: it would carry the original message.
    expect('cause' in err).toBe(false)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(key)
  })

  it('a plain error carrying the key is reported by class only', async () => {
    const { key, caught, lines } = await failWith((k) => new Error(`request failed for ${k}`))
    const err = caught as Error
    expect(err.message).toBe('model call failed: Error')
    expect(String(err.stack)).not.toContain(key)
    for (const line of lines) expect(line).not.toContain(key)
  })
})

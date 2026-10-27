import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import {
  AGENT_KINDS,
  AGENT_RUN_OUTCOMES,
  AGENT_TRIGGERS,
  type AgentRun,
} from '../../contracts.ts'
import {
  finishRun,
  latestRun,
  listRuns,
  processedSyncRunIds,
  startRun,
  type FinishRun,
} from '../agent-runs.ts'

// The agents' run log accessors (#31; prd-04 Rulings 2, 5 and 7). Each test
// starts from an empty, freshly migrated in-memory database and inserts the
// rows it needs; every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const AT = '2026-10-25T03:00:00.000Z'
const NOW = new Date(AT)
const LATER = new Date('2026-10-25T04:30:00.000Z')
const LATEST = new Date('2026-10-25T06:00:00.000Z')

// `Record<keyof …>` makes TypeScript refuse this file if `AgentRun` gains or
// loses a field without this list changing; the first test pins the list to
// the table.
const RUN_FIELDS: Record<keyof AgentRun, true> = {
  id: true,
  kind: true,
  trigger: true,
  started_at: true,
  finished_at: true,
  outcome: true,
  considered_count: true,
  written_count: true,
  sync_run_id: true,
  cursor: true,
  model: true,
  input_tokens: true,
  output_tokens: true,
  cost_micro_usd: true,
}
const RUN_KEYS = Object.keys(RUN_FIELDS).sort()

async function syncRun(startedAt: string = AT): Promise<number> {
  const [id] = await connection('sync_runs').insert({
    started_at: startedAt,
    finished_at: startedAt,
    outcome: 'success',
  })
  return id
}

const usage = (fields: Partial<NonNullable<FinishRun['usage']>> = {}): NonNullable<FinishRun['usage']> => ({
  model: 'claude-haiku-5-5',
  inputTokens: 1200,
  outputTokens: 80,
  costMicroUsd: 1600,
  ...fields,
})

const done = (fields: Partial<FinishRun> = {}): FinishRun => ({
  outcome: 'success',
  consideredCount: 12,
  writtenCount: 3,
  ...fields,
})

describe('the row type and value lists match the migration', () => {
  it('AgentRun has one field per agent_runs column', async () => {
    const info: { name: string }[] = await connection.raw('PRAGMA table_info(agent_runs)')
    expect(info.map((c) => c.name).sort()).toEqual(RUN_KEYS)
  })

  it('AGENT_KINDS, AGENT_TRIGGERS and AGENT_RUN_OUTCOMES are the enum values of the table', async () => {
    const { sql } = await connection('sqlite_master').where({ type: 'table', name: 'agent_runs' }).first('sql')
    const values = (column: string) => {
      const m = String(sql).match(new RegExp(`\`${column}\` text check \\(\`${column}\` in \\(([^)]*)\\)\\)`))
      return [...String(m?.[1]).matchAll(/'([^']*)'/g)].map((v) => v[1])
    }
    expect(values('kind')).toEqual([...AGENT_KINDS])
    expect(values('trigger')).toEqual([...AGENT_TRIGGERS])
    expect(values('outcome')).toEqual([...AGENT_RUN_OUTCOMES])
  })
})

describe('startRun', () => {
  it('logs a running run with zero counts and returns its row', async () => {
    const started = await startRun({ kind: 'insights', trigger: 'weekly' }, NOW)

    expect(Object.keys(started).sort()).toEqual(RUN_KEYS)
    expect(started).toStrictEqual({
      id: started.id,
      kind: 'insights',
      trigger: 'weekly',
      started_at: AT,
      finished_at: null,
      outcome: 'running',
      considered_count: 0,
      written_count: 0,
      sync_run_id: null,
      cursor: null,
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_micro_usd: null,
    })
    expect(await connection('agent_runs')).toStrictEqual([started])
  })

  it('names the sync run exactly when the trigger is sync', async () => {
    const syncRunId = await syncRun()
    const run = await startRun({ kind: 'category', trigger: 'sync', syncRunId }, NOW)
    expect(run.sync_run_id).toBe(syncRunId)

    await expect(startRun({ kind: 'category', trigger: 'sync' }, NOW)).rejects.toThrow(
      /^a sync-triggered run must name its sync run$/,
    )
    for (const trigger of ['weekly', 'manual'] as const) {
      await expect(startRun({ kind: 'category', trigger, syncRunId }, NOW), trigger).rejects.toThrow(
        /^only a sync-triggered run names a sync run$/,
      )
    }
    await expect(
      startRun({ kind: 'category', trigger: 'sync', syncRunId: syncRunId + 1000 }, NOW),
    ).rejects.toThrow(/^startRun failed: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed$/)
    expect(await connection('agent_runs').pluck('id')).toEqual([run.id])
  })

  it("runs inside the caller's transaction: rolled back it leaves no row", async () => {
    await expect(
      connection.transaction(async (trx) => {
        const run = await startRun({ kind: 'insights', trigger: 'manual' }, NOW, trx)
        expect(await trx('agent_runs').pluck('id')).toEqual([run.id])
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    expect(await connection('agent_runs')).toEqual([])
  })
})

describe('trigger, a SQL keyword, round-trips through every query', () => {
  it.each(AGENT_TRIGGERS)('%s', async (trigger) => {
    const syncRunId = trigger === 'sync' ? await syncRun() : undefined
    const run = await startRun({ kind: 'category', trigger, syncRunId }, NOW)
    await startRun({ kind: 'insights', trigger: trigger === 'weekly' ? 'manual' : 'weekly' }, LATER)

    expect((await listRuns({ kind: 'category' })).map((r) => r.trigger)).toEqual([trigger])
    expect(await connection('agent_runs').where({ trigger }).pluck('id')).toEqual([run.id])
    expect(await connection('agent_runs').orderBy('trigger').pluck('trigger')).toEqual(
      [trigger, trigger === 'weekly' ? 'manual' : 'weekly'].sort(),
    )
    const raw: { trigger: string }[] = await connection.raw(
      'select "trigger" from agent_runs where id = ?',
      [run.id],
    )
    expect(raw).toEqual([{ trigger }])

    expect(await finishRun(run.id, done(), LATER)).toBe(true)
    expect((await latestRun('category'))?.trigger).toBe(trigger)
  })
})

describe('finishRun', () => {
  it('finishes a running run once, with its counts, time and cursor', async () => {
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)

    expect(await finishRun(run.id, done({ cursor: 'txn:1042' }), LATER)).toBe(true)
    expect(await finishRun(run.id, done({ outcome: 'failed', consideredCount: 0 }), LATEST)).toBe(false)
    expect(await finishRun(run.id + 1000, done(), LATER)).toBe(false)

    const [stored]: AgentRun[] = await connection('agent_runs')
    expect(Object.keys(stored).sort()).toEqual(RUN_KEYS)
    expect(stored).toStrictEqual({
      ...run,
      finished_at: LATER.toISOString(),
      outcome: 'success',
      considered_count: 12,
      written_count: 3,
      cursor: 'txn:1042',
    })
  })

  it('records a failed run, and leaves the cursor alone when none is given', async () => {
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    await connection('agent_runs').where({ id: run.id }).update({ cursor: 'txn:7' })

    expect(await finishRun(run.id, done({ outcome: 'failed', writtenCount: 0 }), LATER)).toBe(true)
    expect(await connection('agent_runs').first('outcome', 'cursor', 'written_count')).toStrictEqual({
      outcome: 'failed',
      cursor: 'txn:7',
      written_count: 0,
    })
  })

  it('records a blocked run with its usage (Ruling 9)', async () => {
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)

    expect(
      await finishRun(run.id, done({ outcome: 'blocked', writtenCount: 0, usage: usage() }), LATER),
    ).toBe(true)

    const [stored]: AgentRun[] = await connection('agent_runs')
    expect(Object.keys(stored).sort()).toEqual(RUN_KEYS)
    expect(stored).toStrictEqual({
      ...run,
      finished_at: LATER.toISOString(),
      outcome: 'blocked',
      considered_count: 12,
      written_count: 0,
      model: 'claude-haiku-5-5',
      input_tokens: 1200,
      output_tokens: 80,
      cost_micro_usd: 1600,
    })
  })

  it('leaves every usage column null on a run finished without usage', async () => {
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    await finishRun(run.id, done(), LATER)
    expect(
      await connection('agent_runs').first('model', 'input_tokens', 'output_tokens', 'cost_micro_usd'),
    ).toStrictEqual({ model: null, input_tokens: null, output_tokens: null, cost_micro_usd: null })
  })

  it('clears the cursor when given null', async () => {
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    await connection('agent_runs').where({ id: run.id }).update({ cursor: 'txn:7' })
    await finishRun(run.id, done({ cursor: null }), LATER)
    expect(await connection('agent_runs').pluck('cursor')).toEqual([null])
  })

  const BAD: [name: string, fields: Partial<FinishRun>, message: RegExp][] = [
    ['outcome running', { outcome: 'running' as unknown as FinishRun['outcome'] }, /^outcome must be success, failed or blocked$/],
    ['consideredCount -1', { consideredCount: -1 }, /^consideredCount must be a non-negative integer$/],
    ['consideredCount 1.5', { consideredCount: 1.5 }, /^consideredCount must be a non-negative integer$/],
    ['writtenCount NaN', { writtenCount: NaN }, /^writtenCount must be a non-negative integer$/],
    ['writtenCount "2"', { writtenCount: '2' as unknown as number }, /^writtenCount must be a non-negative integer$/],
    ['usage.inputTokens -1', { usage: usage({ inputTokens: -1 }) }, /^usage\.inputTokens must be a non-negative integer$/],
    ['usage.outputTokens 2.5', { usage: usage({ outputTokens: 2.5 }) }, /^usage\.outputTokens must be a non-negative integer$/],
    ['usage.costMicroUsd -3', { usage: usage({ costMicroUsd: -3 }) }, /^usage\.costMicroUsd must be a non-negative integer$/],
    ['usage.costMicroUsd 0.5', { usage: usage({ costMicroUsd: 0.5 }) }, /^usage\.costMicroUsd must be a non-negative integer$/],
    ['usage.model blank', { usage: usage({ model: '  ' }) }, /^usage\.model must not be blank$/],
  ]

  it.each(BAD)('throws on %s and leaves the run running', async (_, fields, message) => {
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    await expect(finishRun(run.id, done(fields), LATER)).rejects.toThrow(message)
    expect(await connection('agent_runs')).toStrictEqual([run])
  })
})

// knex's error message holds the SQL with its bound values, and a cursor is
// the agent's own text. A test-only trigger refuses the update, the way a
// constraint would, after finishRun's own checks pass.
describe('a refused write throws without the row', () => {
  it('finishRun, without the cursor', async () => {
    const SENTINEL = 'Fixture Merchant 5527'
    const run = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    await connection.raw(
      "create trigger fixture_refusal before update on agent_runs begin select raise(abort, 'fixture refusal'); end",
    )
    const attempt = finishRun(run.id, done({ cursor: SENTINEL }), LATER)
    await expect(attempt).rejects.toThrow(/^finishRun failed: SQLITE_CONSTRAINT: fixture refusal$/)
    await expect(attempt).rejects.not.toThrow(SENTINEL)
    expect(await connection('agent_runs')).toStrictEqual([run])
  })
})

describe('processedSyncRunIds (Ruling 5)', () => {
  it('is empty until a successful run of the kind has processed a sync run', async () => {
    expect(await processedSyncRunIds('category')).toStrictEqual([])

    const first = await syncRun(AT)
    const second = await syncRun(LATER.toISOString())
    const third = await syncRun(LATEST.toISOString())

    // Running, failed, blocked, another kind, and a run with no sync run: none count.
    await startRun({ kind: 'category', trigger: 'sync', syncRunId: third }, NOW)
    const failed = await startRun({ kind: 'category', trigger: 'sync', syncRunId: second }, NOW)
    await finishRun(failed.id, done({ outcome: 'failed' }), LATER)
    const blocked = await startRun({ kind: 'category', trigger: 'sync', syncRunId: second }, NOW)
    await finishRun(blocked.id, done({ outcome: 'blocked' }), LATER)
    const other = await startRun({ kind: 'insights', trigger: 'sync', syncRunId: third }, NOW)
    await finishRun(other.id, done(), LATER)
    const manual = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    await finishRun(manual.id, done(), LATER)
    expect(await processedSyncRunIds('category')).toStrictEqual([])
    expect(await processedSyncRunIds('insights')).toStrictEqual([third])

    const ok = await startRun({ kind: 'category', trigger: 'sync', syncRunId: first }, NOW)
    await finishRun(ok.id, done(), LATER)
    expect(await processedSyncRunIds('category')).toStrictEqual([first])
  })

  // A set, not a high-water mark: a later success must not hide a failed sync
  // run from the poller (#58), or the failed one is never retried.
  it('leaves out a failed sync run after a later one succeeds, until a run for it succeeds', async () => {
    const failedFor = await syncRun(AT)
    const later = await syncRun(LATER.toISOString())
    const failed = await startRun({ kind: 'category', trigger: 'sync', syncRunId: failedFor }, NOW)
    await finishRun(failed.id, done({ outcome: 'failed' }), NOW)
    const ok = await startRun({ kind: 'category', trigger: 'sync', syncRunId: later }, LATER)
    await finishRun(ok.id, done(), LATER)
    expect(await processedSyncRunIds('category')).toStrictEqual([later])

    const retry = await startRun({ kind: 'category', trigger: 'sync', syncRunId: failedFor }, LATEST)
    await finishRun(retry.id, done(), LATEST)
    expect(await processedSyncRunIds('category')).toStrictEqual([failedFor, later])
  })

  it('names each sync run once, ascending, whatever order the runs started in', async () => {
    const low = await syncRun(AT)
    const high = await syncRun(LATER.toISOString())
    for (const [syncRunId, at] of [
      [high, NOW],
      [low, LATER],
      [high, LATEST],
      [low, LATEST],
    ] as const) {
      const run = await startRun({ kind: 'category', trigger: 'sync', syncRunId }, at)
      await finishRun(run.id, done(), at)
    }

    expect(await processedSyncRunIds('category')).toStrictEqual([low, high])
  })
})

describe('latestRun and listRuns', () => {
  it('latestRun is the most recently started run of the kind, ties by id', async () => {
    expect(await latestRun('category')).toBeUndefined()
    await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    const tieLow = await startRun({ kind: 'category', trigger: 'manual' }, LATER)
    const tieHigh = await startRun({ kind: 'category', trigger: 'weekly' }, LATER)
    await startRun({ kind: 'insights', trigger: 'weekly' }, LATEST)

    const latest = await latestRun('category')
    expect(Object.keys(latest ?? {}).sort()).toEqual(RUN_KEYS)
    expect(latest?.id).toBe(tieHigh.id)
    expect(latest?.id).not.toBe(tieLow.id)
  })

  it('listRuns is newest first, filtered by kind, and limited', async () => {
    const a = await startRun({ kind: 'category', trigger: 'manual' }, NOW)
    const b = await startRun({ kind: 'insights', trigger: 'weekly' }, LATER)
    const c = await startRun({ kind: 'category', trigger: 'weekly' }, LATEST)

    expect((await listRuns()).map((r) => r.id)).toEqual([c.id, b.id, a.id])
    expect((await listRuns({ kind: 'category' })).map((r) => r.id)).toEqual([c.id, a.id])
    expect((await listRuns({ limit: 2 })).map((r) => r.id)).toEqual([c.id, b.id])
    for (const r of await listRuns()) expect(Object.keys(r).sort()).toEqual(RUN_KEYS)
  })

  it('listRuns returns 50 runs by default', async () => {
    const base = Date.parse(AT)
    for (let i = 0; i < 52; i++) {
      await startRun({ kind: 'insights', trigger: 'manual' }, new Date(base + i * 60_000))
    }
    const runs = await listRuns()
    expect(runs).toHaveLength(50)
    expect(runs[0].started_at).toBe(new Date(base + 51 * 60_000).toISOString())
  })

  it.each([0, -1, 1.5, NaN, Infinity])('listRuns refuses a limit of %s rather than returning every run', async (limit) => {
    await startRun({ kind: 'insights', trigger: 'manual' }, NOW)
    await expect(listRuns({ limit })).rejects.toThrow(/^limit must be a positive integer$/)
  })
})

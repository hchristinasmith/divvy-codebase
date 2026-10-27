import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { checkBrakes, costMicroUsd, tokensSpentToday } from '../guard.ts'
import { priorRun } from './fakes.ts'

// The model path's brakes (#429; prd-04 Rulings 4 and 9). Each test starts
// from an empty, freshly migrated in-memory database; every value is
// invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

// 28 October 2026, 14:00 in Auckland (NZDT, UTC+13); the NZ day began at
// 2026-10-27T11:00Z.
const NOW = new Date('2026-10-28T01:00:00.000Z')
// 27 October 23:00 in Auckland: yesterday there, though within 24 hours.
const NZ_YESTERDAY = '2026-10-27T10:00:00.000Z'
// 28 October 09:00 in Auckland: today there, though yesterday in UTC.
const NZ_TODAY_UTC_YESTERDAY = '2026-10-27T20:00:00.000Z'

const HAIKU = { input: 100_000, output: 500_000 }

describe('costMicroUsd', () => {
  it('is integer micro-USD, rounded up', () => {
    // 1234 × 0.1 + 56 × 0.5 = 151.4 micro-USD.
    expect(costMicroUsd({ inputTokens: 1234, outputTokens: 56 }, HAIKU)).toBe(152)
    // 1000 × 0.1 + 100 × 0.5 = 150 exactly.
    expect(costMicroUsd({ inputTokens: 1000, outputTokens: 100 }, HAIKU)).toBe(150)
    // One input token is a tenth of a micro-USD, which still costs one.
    expect(costMicroUsd({ inputTokens: 1, outputTokens: 0 }, HAIKU)).toBe(1)
    expect(costMicroUsd({ inputTokens: 0, outputTokens: 0 }, HAIKU)).toBe(0)
    // A million of each: $0.10 + $0.50.
    expect(costMicroUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, HAIKU)).toBe(600_000)
  })

  it.each([
    [{ inputTokens: -1, outputTokens: 0 }],
    [{ inputTokens: 1.5, outputTokens: 0 }],
    [{ inputTokens: 0, outputTokens: Number.NaN }],
  ])('refuses %j', (usage) => {
    expect(() => costMicroUsd(usage, HAIKU)).toThrow(RangeError)
  })
})

describe('checkBrakes', () => {
  const config = { killSwitch: false, dailyTokenBudget: 1000 }

  it('allows a call below the budget', () => {
    expect(checkBrakes(config, 600, 399)).toBeNull()
  })

  it('blocks once today and this run together reach the budget', () => {
    expect(checkBrakes(config, 600, 400)).toBe('budget')
    expect(checkBrakes(config, 1000, 0)).toBe('budget')
    expect(checkBrakes(config, 0, 1000)).toBe('budget')
    expect(checkBrakes(config, Number.NaN, 0)).toBe('budget')
  })

  it('puts the kill switch first', () => {
    expect(checkBrakes({ ...config, killSwitch: true }, 0, 0)).toBe('kill_switch')
    expect(checkBrakes({ ...config, killSwitch: true }, 5000, 0)).toBe('kill_switch')
  })
})

describe('tokensSpentToday', () => {
  it('is zero on an empty log', async () => {
    expect(await tokensSpentToday(NOW, connection)).toBe(0)
  })

  it('sums input and output of runs that finished on the Auckland day', async () => {
    await priorRun('2026-10-28T00:30:00.000Z', 300, 20)
    await priorRun(NZ_TODAY_UTC_YESTERDAY, 100, 5)
    expect(await tokensSpentToday(NOW, connection)).toBe(425)
  })

  it('does not count yesterday in Auckland, even within 24 hours', async () => {
    await priorRun(NZ_YESTERDAY, 9000, 900)
    await priorRun('2026-10-25T01:00:00.000Z', 9000, 900)
    expect(await tokensSpentToday(NOW, connection)).toBe(0)
  })

  it('counts the first minute of the Auckland day', async () => {
    await priorRun('2026-10-27T11:00:00.000Z', 7, 3)
    await priorRun('2026-10-27T10:59:59.999Z', 700, 300)
    expect(await tokensSpentToday(NOW, connection)).toBe(10)
  })

  it('keeps a 25-hour Auckland day whole (daylight saving ends 5 April 2026)', async () => {
    await priorRun('2026-04-04T11:00:00.000Z', 1, 0) // 5 April 00:00 NZDT
    await priorRun('2026-04-04T10:59:59.999Z', 100, 0) // 4 April 23:59 NZDT
    await priorRun('2026-04-05T11:59:59.999Z', 10, 0) // 5 April 23:59 NZST
    expect(await tokensSpentToday(new Date('2026-04-05T11:59:59.999Z'), connection)).toBe(11)
    expect(await tokensSpentToday(new Date('2026-04-05T12:00:00.000Z'), connection)).toBe(0)
  })

  it('keeps a 23-hour Auckland day whole (daylight saving starts 27 September 2026)', async () => {
    await priorRun('2026-09-26T12:00:00.000Z', 1, 0) // 27 September 00:00 NZST
    await priorRun('2026-09-26T11:59:59.999Z', 100, 0) // 26 September 23:59 NZST
    await priorRun('2026-09-27T10:59:59.999Z', 10, 0) // 27 September 23:59 NZDT
    expect(await tokensSpentToday(new Date('2026-09-27T10:59:59.999Z'), connection)).toBe(11)
    expect(await tokensSpentToday(new Date('2026-09-27T11:00:00.000Z'), connection)).toBe(0)
  })

  it('ignores runs with no usage and runs still going', async () => {
    await connection('agent_runs').insert({
      kind: 'category',
      trigger: 'manual',
      started_at: '2026-10-28T00:00:00.000Z',
      finished_at: '2026-10-28T00:01:00.000Z',
      outcome: 'success',
      considered_count: 4,
      written_count: 1,
    })
    await connection('agent_runs').insert({
      kind: 'category',
      trigger: 'manual',
      started_at: '2026-10-28T00:00:00.000Z',
      outcome: 'running',
      considered_count: 0,
      written_count: 0,
    })
    expect(await tokensSpentToday(NOW, connection)).toBe(0)
  })

  it('reads the log afresh on every call', async () => {
    await priorRun('2026-10-28T00:10:00.000Z', 50, 5)
    expect(await tokensSpentToday(NOW, connection)).toBe(55)
    await priorRun('2026-10-28T00:20:00.000Z', 40, 4)
    expect(await tokensSpentToday(NOW, connection)).toBe(99)
  })
})

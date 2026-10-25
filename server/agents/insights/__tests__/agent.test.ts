import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { CHART_LIMITS, parseChartSpecJson, type ChartSpec } from '../../../../models/insights.ts'
import { dismissInsight, type NewInsight } from '../../db/insights.ts'
import { runInsightsAgent } from '../agent.ts'
import { mdCode } from '../prompt.ts'
import { cleanLabel, collectAggregates, type Aggregates } from '../queries.ts'

// The insights agent end to end (#47; prd-04 Rulings 2, 3, 7 and 8). Each
// test starts from an empty, freshly migrated in-memory database and inserts
// the rows it needs; every merchant, account and amount is invented.
//
// Three seams, each a pass-through unless a test sets its hook: the
// template's drafts can be replaced (a spec the validator refuses), the
// aggregate query can be made to throw, and `insertInsight` calls are
// counted (one attempt, no retry).

const hooks = vi.hoisted(() => ({
  drafts: null as null | ((drafts: NewInsight[]) => NewInsight[]),
  failQuery: false,
  insertCalls: 0,
}))

vi.mock('../prompt.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt.ts')>()
  return {
    ...actual,
    buildDrafts: (a: Aggregates, scope: 'personal' | 'strawb') => {
      const drafts = actual.buildDrafts(a, scope)
      return hooks.drafts ? hooks.drafts(drafts) : drafts
    },
  }
})

vi.mock('../queries.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../queries.ts')>()
  return {
    ...actual,
    collectAggregates: async (...args: Parameters<typeof actual.collectAggregates>) => {
      if (hooks.failQuery) throw new Error('fixture query failure')
      return actual.collectAggregates(...args)
    },
  }
})

vi.mock('../../db/insights.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/insights.ts')>()
  return {
    ...actual,
    insertInsight: (...args: Parameters<typeof actual.insertInsight>) => {
      hooks.insertCalls += 1
      return actual.insertInsight(...args)
    },
  }
})

const spyOnErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})
let errors: ReturnType<typeof spyOnErrors>

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  hooks.drafts = null
  hooks.failQuery = false
  hooks.insertCalls = 0
  seq = 0
  errors = spyOnErrors()
})

afterEach(() => {
  errors.mockRestore()
})

afterAll(async () => {
  await connection.destroy()
})

const STAMP = '2026-10-01T00:00:00.000Z'
const WEEK = '2026-W43' // Monday 2026-10-19 to Sunday 2026-10-25
// Tuesday 27 October in NZ: the last complete week is 2026-W43.
const NOW = new Date('2026-10-27T00:00:00.000Z')

const day = (date: string) => `${date}T00:00:00.000Z`

const INSIGHT_KEYS = ['body_md', 'chart_spec_json', 'created_at', 'dismissed_at', 'id', 'kind', 'period', 'scope', 'title']
const RUN_KEYS = [
  'considered_count',
  'cursor',
  'finished_at',
  'id',
  'kind',
  'outcome',
  'started_at',
  'sync_run_id',
  'trigger',
  'written_count',
]
const RESULT_KEYS = ['considered', 'outcome', 'period', 'rejected', 'runId', 'skipped', 'written']

const PERSONAL = { merchant: 'Personal Only Bakery', category: 'Personal Only Cafes', cents: 66666, shown: '$666.66' }
const STRAWB = { merchant: 'Strawb Only Supplies', category: 'Strawb Only Category', cents: 55555, shown: '$555.55' }
const DESCRIPTION = 'SENTINEL DESC card 1234'

async function seedAccounts(): Promise<void> {
  await connection('accounts').insert(
    [
      ['acc_p1', 'personal'],
      ['acc_p2', 'personal'],
      ['acc_s1', 'strawb'],
    ].map(([akahuId, scope]) => ({
      akahu_id: akahuId,
      source: 'akahu',
      scope,
      name: 'Invented account',
      created_at: STAMP,
      updated_at: STAMP,
    })),
  )
}

let seq = 0

async function tx(account: string, at: string, cents: number, merchant: string | null, category: string | null) {
  seq += 1
  await connection('transactions').insert({
    akahu_id: `trans_fixture_${seq}`,
    account_id: account,
    date: at,
    amount_cents: cents,
    merchant_name: merchant,
    category,
    status: 'settled',
    source: 'akahu',
    description: DESCRIPTION,
    reference: 'SENTINEL REF',
    particulars: 'SENTINEL PART',
    code: 'SENTINEL CODE',
  })
}

async function seedLedger(): Promise<void> {
  await seedAccounts()
  // Personal: the week, the week before, Sample Fuel's history, a transfer.
  await tx('acc_p1', day('2026-10-19'), -1250, 'Fixture Bakery', 'Cafes')
  await tx('acc_p1', day('2026-10-20'), -4500, 'Invented Grocer', 'Groceries')
  await tx('acc_p1', day('2026-10-23'), -6000, 'Sample Fuel', 'Fuel')
  await tx('acc_p1', day('2026-10-21'), -PERSONAL.cents, PERSONAL.merchant, PERSONAL.category)
  await tx('acc_p1', day('2026-10-13'), -1000, 'Fixture Bakery', 'Cafes')
  await tx('acc_p1', day('2026-09-01'), -1500, 'Sample Fuel', 'Fuel')
  await tx('acc_p1', day('2026-09-15'), -1600, 'Sample Fuel', 'Fuel')
  await tx('acc_p1', day('2026-10-06'), -1700, 'Sample Fuel', 'Fuel')
  await tx('acc_p1', day('2026-07-15'), -3000, 'Sample Fuel', 'Fuel')
  // The same spend both weeks: a category with no change.
  await tx('acc_p1', day('2026-10-21'), -900, 'Invented Gym', 'Fitness')
  await tx('acc_p1', day('2026-10-14'), -900, 'Invented Gym', 'Fitness')
  await tx('acc_p1', day('2026-10-24'), -20000, null, 'Transfers')
  await tx('acc_p2', day('2026-10-24'), 20000, null, 'Transfers')
  // Strawb.
  await tx('acc_s1', day('2026-10-20'), -STRAWB.cents, STRAWB.merchant, STRAWB.category)
  await tx('acc_s1', day('2026-10-13'), -1200, 'Strawb Other Vendor', 'Supplies')
}

interface StoredInsight {
  id: number
  kind: string
  title: string
  body_md: string
  chart_spec_json: string | null
  scope: string
  period: string
  created_at: string
  dismissed_at: string | null
}

const insightRows = (): Promise<StoredInsight[]> => connection('insights').orderBy('id')
const runRows = (): Promise<Record<string, unknown>[]> => connection('agent_runs').orderBy('id')

function specOf(row: StoredInsight): ChartSpec {
  const checked = parseChartSpecJson(row.chart_spec_json)
  if (!checked.ok) throw new Error(`stored spec refused: ${checked.reason}`)
  return checked.spec
}

function numbersIn(value: unknown, into: number[] = []): number[] {
  if (typeof value === 'number') into.push(value)
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, into)
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) numbersIn(v, into)
  return into
}

const stripCodeSpans = (md: string) => md.replace(/`[^`]*`/g, '')

describe('a run', () => {
  it('writes the three insights with scope and period, and logs one successful run', async () => {
    await seedLedger()
    const result = await runInsightsAgent('personal', {}, NOW)

    const rows = await insightRows()
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...INSIGHT_KEYS].sort())
    expect(rows.map((r) => [r.kind, r.scope, r.period, r.title, r.dismissed_at, r.created_at])).toEqual([
      ['pattern', 'personal', WEEK, `Top merchants and unusual spends, ${WEEK}`, null, NOW.toISOString()],
      ['report', 'personal', WEEK, `Spending against last week, ${WEEK}`, null, NOW.toISOString()],
      ['chart', 'personal', WEEK, 'Spend by category, last 6 months', null, NOW.toISOString()],
    ])
    for (const r of rows) expect(r.chart_spec_json).not.toBeNull()

    // Personal rows May to the week's Sunday: everything above but strawb.
    const considered = 13
    expect(Object.keys(result).sort()).toEqual([...RESULT_KEYS].sort())
    expect(result).toStrictEqual({
      runId: result.runId,
      outcome: 'success',
      period: WEEK,
      considered,
      written: 3,
      skipped: 0,
      rejected: [],
    })

    const runs = await runRows()
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(Object.keys(run).sort()).toEqual([...RUN_KEYS].sort())
    expect(run).toMatchObject({
      id: result.runId,
      kind: 'insights',
      trigger: 'manual',
      outcome: 'success',
      considered_count: considered,
      written_count: 3,
      sync_run_id: null,
      cursor: null,
      started_at: NOW.toISOString(),
    })
    expect(String(run.finished_at) >= NOW.toISOString()).toBe(true)
    expect((await collectAggregates('personal', WEEK)).ledgerRowCount).toBe(considered)
  })

  it('takes a weekly trigger and an explicit period', async () => {
    await seedLedger()
    const result = await runInsightsAgent('personal', { period: '2026-W42', trigger: 'weekly' }, NOW)
    expect(result.period).toBe('2026-W42')
    const [run] = await runRows()
    expect(run.trigger).toBe('weekly')
    expect((await insightRows()).every((r) => r.period === '2026-W42')).toBe(true)
  })

  it('every number in every stored spec is a number collectAggregates produced', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const produced = new Set(numbersIn(await collectAggregates('personal', WEEK)))
    const stored = (await insightRows()).flatMap((r) => numbersIn(specOf(r)))
    expect(stored.length).toBeGreaterThan(0)
    for (const n of stored) expect(produced.has(n), String(n)).toBe(true)
  })

  it('the stored spec numbers equal a hand-written oracle', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const rows = await insightRows()
    const byKind = new Map(rows.map((r) => [r.kind, specOf(r)]))

    // Top merchants over NZ 2026-10-19 to 2026-10-25, transfers (no
    // merchant) and inflows out.
    const oracle = (await connection('transactions as t')
      .join('accounts as a', 't.account_id', 'a.akahu_id')
      .where({ 'a.scope': 'personal', 't.status': 'settled' })
      .where('t.amount_cents', '<', 0)
      .whereNotNull('t.merchant_name')
      .whereBetween('t.date', ['2026-10-18T11:00:00.000Z', '2026-10-25T10:59:59.999Z'])
      .select({ merchant: 't.merchant_name' })
      .sum({ total: 't.amount_cents' })
      .groupBy('t.merchant_name')
      .orderBy([{ column: 'total', order: 'asc' }, 'merchant'])) as { merchant: string; total: number }[]
    expect(byKind.get('pattern')?.data.values).toStrictEqual(
      oracle.map((o) => ({ merchant: o.merchant, spend_cents: -o.total })),
    )

    // Change per category: this week minus the week before; Fitness did not
    // change, so it is not charted.
    expect(byKind.get('report')?.data.values).toStrictEqual([
      { category: PERSONAL.category, change_cents: 66666 },
      { category: 'Fuel', change_cents: 6000 },
      { category: 'Groceries', change_cents: 4500 },
      { category: 'Cafes', change_cents: 250 },
    ])

    // October: 1250 + 1000 Cafes, 4500 Groceries, 6000 + 1700 Fuel, 900 + 900
    // Fitness.
    const october = byKind.get('chart')?.data.values.filter((v) => v.month === '2026-10')
    expect(october).toStrictEqual([
      { month: '2026-10', category: PERSONAL.category, spend_cents: 66666 },
      { month: '2026-10', category: 'Fuel', spend_cents: 7700 },
      { month: '2026-10', category: 'Groceries', spend_cents: 4500 },
      { month: '2026-10', category: 'Cafes', spend_cents: 2250 },
      { month: '2026-10', category: 'Fitness', spend_cents: 1800 },
    ])
  })

  it('the bodies show the same figures, labels in code spans', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const [pattern, report] = await insightRows()
    expect(pattern.body_md).toContain('- `Sample Fuel` $60.00 across 1 transaction')
    expect(pattern.body_md).toContain('- `Sample Fuel` on 2026-10-23, $60.00 against a typical $16.00 (`Fuel`)')
    expect(report.body_md).toContain('was $793.16, against $19.00 the week before, a change of +$774.16 (+4075%).')
  })
})

describe('scope', () => {
  const textOf = (rows: StoredInsight[]) => rows.map((r) => [r.title, r.body_md, r.chart_spec_json].join('\n')).join('\n')

  it('a personal run stores nothing derived from strawb rows', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const rows = await insightRows()
    expect(rows.length).toBe(3)
    const text = textOf(rows)
    for (const sentinel of [STRAWB.merchant, STRAWB.category, String(STRAWB.cents), STRAWB.shown, 'Strawb Other Vendor']) {
      expect(text, sentinel).not.toContain(sentinel)
    }
    expect(text).toContain(PERSONAL.merchant)
  })

  it('a strawb run stores nothing derived from personal rows', async () => {
    await seedLedger()
    await runInsightsAgent('strawb', {}, NOW)
    const rows = await insightRows()
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.scope === 'strawb')).toBe(true)
    const text = textOf(rows)
    for (const sentinel of [PERSONAL.merchant, PERSONAL.category, String(PERSONAL.cents), PERSONAL.shown, 'Sample Fuel']) {
      expect(text, sentinel).not.toContain(sentinel)
    }
    expect(text).toContain(STRAWB.merchant)
  })

  it('no stored text holds an account id, a transaction id or a description', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    await runInsightsAgent('strawb', {}, NOW)
    const rows = await insightRows()
    expect(rows).toHaveLength(6)
    const text = textOf(rows)
    for (const sentinel of ['acc_p1', 'acc_p2', 'acc_s1', 'trans_fixture', DESCRIPTION, 'SENTINEL']) {
      expect(text, sentinel).not.toContain(sentinel)
    }
  })
})

describe('hostile merchant text', () => {
  const HOSTILE = [
    'http://evil.example/x',
    'PAYMENT: X',
    'News: x',
    'javascript:alert(1)',
    '<script>alert(1)</script>',
    'https\uFF1A//x',
    'Bad\u202Eevil\u200Bname',
    'z'.repeat(500),
    'www.evil.com',
    '[x](http://y)',
    '   ',
    '/',
    'tick`tock',
    '<img src=x onerror=alert(1)>',
  ]
  // Only the top merchants show in a list, so the names run in groups.
  const groups = [HOSTILE.slice(0, 5), HOSTILE.slice(5, 10), HOSTILE.slice(10)]

  it.each(groups.map((g, i) => [i, g] as const))('group %i is stored safely end to end', async (_i, names) => {
    await seedAccounts()
    let cents = 1000
    for (const name of names) {
      cents += 100
      await tx('acc_p1', day('2026-10-20'), -cents, name, name)
      await tx('acc_p1', day('2026-10-13'), -100, name, name)
    }
    const result = await runInsightsAgent('personal', {}, NOW)
    expect(result).toMatchObject({ outcome: 'success', written: 3, rejected: [] })

    const rows = await insightRows()
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(parseChartSpecJson(r.chart_spec_json).ok).toBe(true)
      // No URL anywhere in the stored spec, `$schema` included.
      expect(r.chart_spec_json?.toLowerCase()).not.toMatch(/https?:|javascript:|\/\//)
      expect(r.body_md).not.toContain('<')
      expect(r.body_md).not.toContain('](')
      expect(r.body_md.toLowerCase()).not.toMatch(/https?:|javascript:|\/\//)
      // Outside code spans there is no label at all.
      const prose = stripCodeSpans(r.body_md)
      expect(prose.toLowerCase()).not.toContain('http')
      for (const name of names) {
        const label = cleanLabel(name, 'Unknown merchant')
        expect(prose, label).not.toContain(label)
      }
    }
    const shown = rows.map((r) => r.body_md).join('\n')
    expect(shown).toContain('`')
  })
})

describe('mdCode', () => {
  it.each([
    ['Invented Shop', '`Invented Shop`'],
    // Unreachable through cleanLabel, which drops both; held here anyway.
    ['a`b', '`a b`'],
    ['line\nbreak', '`line break`'],
    ['`', '`?`'],
  ])('%j becomes %j', (label, md) => {
    expect(mdCode(label)).toBe(md)
  })
})

describe('a refused spec', () => {
  const swapPattern = (spec: unknown) => (drafts: NewInsight[]) =>
    drafts.map((d) => (d.kind === 'pattern' ? { ...d, chart_spec: spec } : d))
  const bar = (fields: Record<string, unknown>) => ({
    data: { values: [{ merchant: 'Invented Shop', spend_cents: 100 }] },
    mark: 'bar',
    encoding: { x: { field: 'merchant', type: 'nominal' }, y: { field: 'spend_cents', type: 'quantitative' } },
    ...fields,
  })

  it.each([
    [
      'a URL in a data value',
      bar({ data: { values: [{ merchant: 'https://evil.example', spend_cents: 100 }] } }),
      'url_in_string',
      '$.data.values[0]',
    ],
    ['an unknown mark', bar({ mark: 'scatter' }), 'bad_mark', '$.mark'],
    ['a javascript: title', bar({ title: 'javascript:alert(1)' }), 'url_in_string', '$.title'],
  ])('%s stores nothing from that draft, and the run is logged failed', async (_why, spec, reason, path) => {
    await seedLedger()
    hooks.drafts = swapPattern(spec)
    const result = await runInsightsAgent('personal', {}, NOW)

    expect(result).toMatchObject({ outcome: 'failed', written: 2, skipped: 0 })
    expect(result.rejected).toStrictEqual([{ kind: 'pattern', reason, path }])
    expect((await insightRows()).map((r) => r.kind)).toEqual(['report', 'chart'])
    // One attempt per draft: no retry of the refused one.
    expect(hooks.insertCalls).toBe(3)
    const [run] = await runRows()
    expect(run).toMatchObject({ outcome: 'failed', written_count: 2, considered_count: 13 })
    expect(await runRows()).toHaveLength(1)
    // The log names the kind, reason and path; never the hostile value.
    expect(errors).toHaveBeenCalledWith('insights agent: spec rejected', 'pattern', reason, path)
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).not.toContain('evil')
    expect(logged).not.toContain('alert')
    expect(logged).not.toContain('scatter')
  })
})

describe('failure and repeat', () => {
  it('a query that throws logs a failed run with nothing considered or written', async () => {
    await seedLedger()
    hooks.failQuery = true
    const result = await runInsightsAgent('personal', {}, NOW)
    expect(result).toMatchObject({ outcome: 'failed', considered: 0, written: 0, skipped: 0, rejected: [] })
    expect(await insightRows()).toEqual([])
    const [run] = await runRows()
    expect(run).toMatchObject({ outcome: 'failed', considered_count: 0, written_count: 0 })
    expect(run.finished_at).not.toBeNull()
    expect(errors).toHaveBeenCalledWith('insights agent: run failed', 'fixture query failure')
  })

  it('a second run for the same period writes nothing and skips all three', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const before = await insightRows()
    const again = await runInsightsAgent('personal', {}, NOW)
    expect(again).toMatchObject({ outcome: 'success', written: 0, skipped: 3 })
    expect(await insightRows()).toStrictEqual(before)
    const runs = await runRows()
    expect(runs.map((r) => [r.outcome, r.written_count])).toEqual([
      ['success', 3],
      ['success', 0],
    ])
  })

  it('a dismissed insight is not written again', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const [first] = await insightRows()
    expect(await dismissInsight(first.id, NOW)).toBe(true)
    const again = await runInsightsAgent('personal', {}, NOW)
    expect(again).toMatchObject({ written: 0, skipped: 3 })
    const rows = await insightRows()
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.kind === first.kind)).toEqual([{ ...first, dismissed_at: NOW.toISOString() }])
  })

  it('the next week in the same scope is not a repeat', async () => {
    await seedLedger()
    const earlier = await runInsightsAgent('personal', { period: '2026-W42' }, NOW)
    const later = await runInsightsAgent('personal', { period: WEEK }, NOW)
    expect([earlier, later].map((r) => [r.written, r.skipped])).toEqual([
      [3, 0],
      [3, 0],
    ])
    expect((await insightRows()).map((r) => r.period)).toEqual([
      '2026-W42',
      '2026-W42',
      '2026-W42',
      WEEK,
      WEEK,
      WEEK,
    ])
  })

  it('the same period in the other scope is not a repeat', async () => {
    await seedLedger()
    await runInsightsAgent('personal', {}, NOW)
    const strawb = await runInsightsAgent('strawb', {}, NOW)
    expect(strawb).toMatchObject({ written: 3, skipped: 0 })
  })

  it('an empty week writes nothing and succeeds', async () => {
    await seedAccounts()
    const result = await runInsightsAgent('personal', {}, NOW)
    expect(result).toMatchObject({ outcome: 'success', considered: 0, written: 0, skipped: 0, rejected: [] })
    expect(await insightRows()).toEqual([])
    const [run] = await runRows()
    expect(run).toMatchObject({ outcome: 'success', considered_count: 0, written_count: 0 })
  })

  it.each([
    ['an unknown scope', 'everyone', {}, 'scope must be personal or strawb'],
    ['a bad period', 'personal', { period: '2026-W99' }, 'period must be an ISO week label (YYYY-Www)'],
    ['a sync trigger', 'personal', { trigger: 'sync' }, 'trigger must be manual or weekly'],
  ])('%s is refused before any run is logged', async (_why, scope, options, message) => {
    await expect(
      runInsightsAgent(scope as 'personal', options as { period?: string }, NOW),
    ).rejects.toThrow(message)
    expect(await runRows()).toEqual([])
  })
})

describe('what a run touches', () => {
  it('changes only insights and agent_runs', async () => {
    await seedLedger()
    await connection('budgets').insert({
      scope: 'personal',
      category: 'Cafes',
      limit_cents: 10000,
      created_at: STAMP,
      updated_at: STAMP,
    })
    const tables: string[] = (await connection('sqlite_master').where({ type: 'table' }).pluck('name')).filter(
      (t: string) => !['insights', 'agent_runs'].includes(t) && !/^(knex_|sqlite_)/.test(t),
    )
    expect(tables).toEqual(expect.arrayContaining(['transactions', 'accounts', 'budgets', 'bills', 'goals', 'settings']))
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {}
      for (const t of tables) out[t] = await connection(t).select()
      return out
    }
    const before = await snapshot()
    await runInsightsAgent('personal', {}, NOW)
    expect(await snapshot()).toStrictEqual(before)
    expect(await insightRows()).toHaveLength(3)
  })

  it('every chart stays within the row and key caps, and every body stays short', async () => {
    await seedAccounts()
    // Many long-named categories and merchants, every month.
    for (let i = 0; i < 30; i += 1) {
      const name = `Invented ${String(i).padStart(2, '0')} ${'n'.repeat(40)}`
      for (const month of ['05', '06', '07', '08', '09', '10']) {
        await tx('acc_p1', day(`2026-${month}-20`), -(1000 + i), name, name)
      }
      await tx('acc_p1', day('2026-10-13'), -(10 + i), name, name)
    }
    const result = await runInsightsAgent('personal', {}, NOW)
    expect(result).toMatchObject({ outcome: 'success', written: 3 })
    const rows = await insightRows()
    const counts = new Map<string, { rows: number; keys: number; categories: number }>()
    for (const r of rows) {
      const spec = specOf(r)
      const values = spec.data.values
      expect(values.length).toBeLessThanOrEqual(CHART_LIMITS.maxRows)
      for (const v of values) expect(Object.keys(v).length).toBeLessThanOrEqual(CHART_LIMITS.maxKeys)
      expect(r.body_md.length).toBeLessThanOrEqual(2000)
      counts.set(r.kind, {
        rows: values.length,
        keys: Math.max(...values.map((v) => Object.keys(v).length)),
        categories: new Set(values.map((v) => v.category)).size,
      })
    }
    expect(counts.get('pattern')?.rows).toBe(5)
    expect(counts.get('report')?.rows).toBe(8)
    // Six named categories and the rest summed, in each of six months.
    expect(counts.get('chart')).toEqual({ rows: 42, keys: 3, categories: 7 })
  })
})

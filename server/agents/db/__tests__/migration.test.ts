// prd-04 wave 1 (#31): the agents' inbox tables, Rulings 2, 5, 7 and 8.
// Covers 20261025160000_agent_inboxes.js from the schema just before it, up
// and back down, with prd-01's tables holding rows throughout. Every fixture
// value here is invented.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../../db/knexfile.js'
import { migrateToJustBefore } from '../../../db/__tests__/migrateToJustBefore.ts'
import { omit } from '../../../db/__tests__/omit.ts'
import { sequence } from '../../../db/__tests__/schemaInfo.ts'
import {
  PROPOSAL_ORIGINS,
  PROPOSAL_STATUSES,
  type CategoryProposal,
} from '../../contracts.ts'
import {
  INSIGHT_KINDS,
  type Insight,
  type InsightScope,
} from '../../../../models/insights.ts'

const OURS = '20261025160000_agent_inboxes.js'
const MIGRATION_TEXT = readFileSync(
  new URL(`../../../db/migrations/${OURS}`, import.meta.url),
  'utf8',
)
// The migration without its comments, which name the knex calls it must not
// make.
const MIGRATION_CODE = MIGRATION_TEXT.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
)

// Tables whose rows and id counters this migration must leave alone.
const PRD01 = ['transactions', 'category_corrections', 'sync_runs']

type Row = Record<string, unknown>

// Every column of every table, as `PRAGMA table_info` reports its declared
// type and nullability.
const SCHEMA: Record<string, Record<string, string>> = {
  category_proposals: {
    id: 'integer not null',
    transaction_id: 'integer not null',
    current_category: 'varchar(255)',
    proposed_category: 'varchar(255) not null',
    confidence: 'float not null',
    reason: 'text not null',
    origin: 'text not null',
    status: 'text not null',
    created_at: 'datetime not null',
  },
  insights: {
    id: 'integer not null',
    kind: 'text not null',
    title: 'varchar(255) not null',
    body_md: 'text not null',
    chart_spec_json: 'text',
    scope: 'text not null',
    period: 'varchar(255) not null',
    created_at: 'datetime not null',
    dismissed_at: 'datetime',
  },
  agent_runs: {
    id: 'integer not null',
    kind: 'text not null',
    trigger: 'text not null',
    started_at: 'datetime not null',
    finished_at: 'datetime',
    outcome: 'text not null',
    considered_count: 'integer not null',
    written_count: 'integer not null',
    sync_run_id: 'integer',
    cursor: 'text',
  },
}
const OUR_TABLES = Object.keys(SCHEMA).sort()

// `Record<keyof …>` makes TypeScript refuse this file if the contract gains
// or loses a field without the list changing too; the test then pins the
// list to the table.
const PROPOSAL_FIELDS: Record<keyof CategoryProposal, true> = {
  id: true,
  transaction_id: true,
  current_category: true,
  proposed_category: true,
  confidence: true,
  reason: true,
  origin: true,
  status: true,
  created_at: true,
}
// `mermaid` is the one field of `Insight` with no column (Ruling 2).
const INSIGHT_FIELDS: Record<Exclude<keyof Insight, 'mermaid'>, true> = {
  id: true,
  kind: true,
  title: true,
  body_md: true,
  chart_spec_json: true,
  scope: true,
  period: true,
  created_at: true,
  dismissed_at: true,
}
const SCOPES: Record<InsightScope, true> = { personal: true, strawb: true }

const AT = '2026-10-25T03:00:00.000Z'
const LATER = '2026-10-25T04:30:00.000Z'

const transaction = (fields: Row = {}): Row => ({
  akahu_id: 'trans_fixture_kept',
  account_id: 'acc_fixture_everyday',
  amount_cents: -450,
  ...fields,
})

const proposal = (transactionId: number, fields: Row = {}): Row => ({
  transaction_id: transactionId,
  current_category: null,
  proposed_category: 'Bakeries',
  confidence: 0.9,
  reason: 'Moved to Bakeries twice',
  origin: 'rule',
  status: 'pending',
  created_at: AT,
  ...fields,
})

const insight = (fields: Row = {}): Row => ({
  kind: 'pattern',
  title: 'Top merchants this week',
  body_md: 'Most of the week went to **Fixture Bakery**.',
  chart_spec_json: null,
  scope: 'personal',
  period: '2026-W43',
  created_at: AT,
  dismissed_at: null,
  ...fields,
})

const run = (fields: Row = {}): Row => ({
  kind: 'insights',
  trigger: 'weekly',
  started_at: AT,
  finished_at: null,
  outcome: 'running',
  considered_count: 0,
  written_count: 0,
  sync_run_id: null,
  cursor: null,
  ...fields,
})

const refusedBy = (check: string) => new RegExp(`CHECK constraint failed: ${check}$`)
const notNull = (table: string, column: string) =>
  new RegExp(`NOT NULL constraint failed: ${table}\\.${column}$`)
const FOREIGN_KEY = /FOREIGN KEY constraint failed$/

let db: Knex

async function tables(): Promise<string[]> {
  return db('sqlite_master').where({ type: 'table' }).orderBy('name').pluck('name')
}

// Every schema object (table, index, trigger) that does not belong to one of
// our tables, as SQLite stores it, root page included: a rebuilt table moves
// to a new page.
async function otherObjects(): Promise<Row[]> {
  const rows: Row[] = await db('sqlite_master')
    .orderBy(['type', 'name'])
    .select('type', 'name', 'tbl_name', 'rootpage', 'sql')
  return rows.filter((r) => !OUR_TABLES.includes(String(r.tbl_name)))
}

async function tableSql(table: string): Promise<string> {
  const row = await db('sqlite_master').where({ type: 'table', name: table }).first('sql')
  return String(row?.sql)
}

// The name of every named CHECK on `table`.
async function checkNames(table: string): Promise<string[]> {
  return [...(await tableSql(table)).matchAll(/constraint (\w+) check/g)].map((m) => m[1])
}

// The allowed values of every knex `enu` column on `table`.
async function enums(table: string): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {}
  for (const m of (await tableSql(table)).matchAll(/`(\w+)` text check \(`\1` in \(([^)]*)\)\)/g)) {
    found[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1])
  }
  return found
}

async function count(table: string): Promise<number> {
  const row = await db(table).count('* as n').first()
  return Number(row?.n)
}

async function applied(): Promise<string[]> {
  const [completed] = (await db.migrate.list()) as [{ name: string }[], unknown]
  return completed.map((m) => m.name)
}

// prd-01's rows and id counters, to compare before and after.
async function prd01State(): Promise<Row> {
  const state: Row = {}
  for (const table of PRD01) {
    state[table] = { rows: await db(table).orderBy('id'), seq: await sequence(db, table) }
  }
  return state
}

let tablesBefore: string[]
let objectsBefore: Row[]
let prd01Before: Row
let transactionId: number
let syncRunId: number

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, OURS)

  // A kept transaction, plus one inserted and deleted so the AUTOINCREMENT
  // high-water mark sits above every live id.
  ;[transactionId] = await db('transactions').insert(transaction())
  const [deletedId] = await db('transactions').insert(transaction({ akahu_id: 'trans_fixture_deleted' }))
  await db('transactions').where({ id: deletedId }).delete()
  await db('category_corrections').insert({
    transaction_id: transactionId,
    from_category: null,
    to_category: 'Bakeries',
    corrected_at: AT,
    source: 'user',
  })
  ;[syncRunId] = await db('sync_runs').insert({
    started_at: AT,
    finished_at: LATER,
    outcome: 'success',
  })

  tablesBefore = await tables()
  objectsBefore = await otherObjects()
  prd01Before = await prd01State()
  for (const table of PRD01) expect(await count(table), table).toBe(1)

  await db.migrate.up()
})

afterEach(async () => {
  await db.destroy()
})

describe('migration (Ruling 2)', () => {
  it('creates exactly the three inbox tables and changes no other schema object', async () => {
    expect(tablesBefore.filter((t) => OUR_TABLES.includes(t))).toEqual([])
    expect(await applied()).toContain(OURS)

    const after = await tables()
    expect(after.filter((t) => OUR_TABLES.includes(t))).toEqual(OUR_TABLES)
    expect(after.filter((t) => !OUR_TABLES.includes(t))).toEqual(tablesBefore)
    expect(await otherObjects()).toStrictEqual(objectsBefore)
  })

  it("never rebuilds transactions: prd-01's rows, ids and counters are as they were", async () => {
    expect(await prd01State()).toStrictEqual(prd01Before)
    expect(MIGRATION_CODE).not.toMatch(/alterTable|dropColumn|renameTable|schema\.table\(|\.alter\(\)/)

    const created = [...MIGRATION_CODE.matchAll(/createTable\(\s*'([^']+)'/g)].map((m) => m[1])
    const dropped = [...MIGRATION_CODE.matchAll(/dropTable\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(MIGRATION_CODE.match(/createTable\(/g)).toHaveLength(created.length)
    expect(MIGRATION_CODE.match(/dropTable\(/g)).toHaveLength(dropped.length)
    expect([...created].sort()).toEqual(OUR_TABLES)
    expect([...dropped].sort()).toEqual(OUR_TABLES)
  })

  it('explains its foreign keys and the rebuild hazard in its header', () => {
    for (const word of ['CASCADE', 'NO ACTION', 'rebuild', 'Ruling 7', 'replacePending']) {
      expect(MIGRATION_TEXT).toContain(word)
    }
  })
})

describe('schema (Ruling 2, #31 amended by Ruling 7)', () => {
  it.each(OUR_TABLES)('%s has exactly its columns, each with its type and nullability', async (table) => {
    const info: { name: string; type: string; notnull: number }[] = await db.raw(
      'PRAGMA table_info(??)',
      [table],
    )
    expect(info.map((c) => c.name).sort()).toEqual(Object.keys(SCHEMA[table]).sort())
    for (const c of info) {
      expect(`${c.type.toLowerCase()}${c.notnull ? ' not null' : ''}`, `${table}.${c.name}`).toBe(
        SCHEMA[table][c.name],
      )
    }
  })

  it('category_proposals has one column per CategoryProposal field', () => {
    expect(Object.keys(SCHEMA.category_proposals).sort()).toEqual(Object.keys(PROPOSAL_FIELDS).sort())
  })

  it('insights has one column per Insight field except mermaid', () => {
    expect(Object.keys(SCHEMA.insights).sort()).toEqual(Object.keys(INSIGHT_FIELDS).sort())
    expect(Object.keys(SCHEMA.insights)).not.toContain('mermaid')
  })

  it('agent_runs is a run log: no model, token, cost, money or error column', () => {
    expect(Object.keys(SCHEMA.agent_runs)).toHaveLength(10)
    for (const column of Object.keys(SCHEMA.agent_runs)) {
      expect(column).not.toMatch(/model|token|cost|error|cents|amount|usage/)
    }
  })

  it('each enum column holds exactly the values the contracts name', async () => {
    expect(await enums('category_proposals')).toStrictEqual({
      origin: [...PROPOSAL_ORIGINS],
      status: [...PROPOSAL_STATUSES],
    })
    expect(await enums('insights')).toStrictEqual({
      kind: [...INSIGHT_KINDS],
      scope: Object.keys(SCOPES),
    })
    // AGENT_KINDS, AGENT_TRIGGERS and AGENT_RUN_OUTCOMES in agent-runs.ts are
    // pinned to these in agent-runs.test.ts.
    expect(await enums('agent_runs')).toStrictEqual({
      kind: ['category', 'insights'],
      trigger: ['sync', 'weekly', 'manual'],
      outcome: ['running', 'success', 'failed'],
    })
  })

  it('names every CHECK after its table, and has no other', async () => {
    const expected: Record<string, string[]> = {
      category_proposals: [
        'category_proposals_confidence_unit_interval',
        'category_proposals_reason_not_blank',
      ],
      insights: ['insights_chart_spec_is_json'],
      agent_runs: [
        'agent_runs_counts_non_negative_integers',
        'agent_runs_running_iff_unfinished',
        'agent_runs_sync_run_iff_sync_trigger',
      ],
    }
    for (const table of OUR_TABLES) {
      const names = await checkNames(table)
      expect(names.sort(), table).toEqual(expected[table])
      for (const name of names) expect(name).toMatch(new RegExp(`^${table}_[a-z_]+$`))
    }
  })

  it('defaults only the two counts, to 0, and never to CURRENT_TIMESTAMP', async () => {
    const defaults: string[] = []
    for (const table of OUR_TABLES) {
      const info: { name: string; dflt_value: string | null }[] = await db.raw(
        'PRAGMA table_info(??)',
        [table],
      )
      for (const c of info) if (c.dflt_value !== null) defaults.push(`${table}.${c.name}=${c.dflt_value}`)
      expect(await tableSql(table), table).not.toMatch(/current_timestamp/i)
    }
    expect(defaults.sort()).toEqual(["agent_runs.considered_count='0'", "agent_runs.written_count='0'"])

    await db('agent_runs').insert(omit(omit(run(), 'considered_count'), 'written_count'))
    expect(
      await db('agent_runs').first(
        db.raw("considered_count, typeof(considered_count) as t, written_count"),
      ),
    ).toStrictEqual({ considered_count: 0, t: 'integer', written_count: 0 })
  })

  // Every NOT NULL column a writer must supply (not the rowid key, not the
  // defaulted counts), with a valid row for its table.
  const VALID: Record<string, () => Row> = {
    category_proposals: () => proposal(transactionId),
    insights: () => insight(),
    agent_runs: () => run(),
  }
  const DEFAULTED = ['agent_runs.considered_count', 'agent_runs.written_count']
  const NOT_NULL: [table: string, column: string][] = OUR_TABLES.flatMap((table) =>
    Object.entries(SCHEMA[table])
      .filter(([c, type]) => type.endsWith('not null') && c !== 'id' && !DEFAULTED.includes(`${table}.${c}`))
      .map(([c]): [string, string] => [table, c]),
  )

  it.each(NOT_NULL)('%s.%s refuses NULL, and refuses being left out (no default)', async (table, column) => {
    const row = VALID[table]()
    await expect(db(table).insert({ ...row, [column]: null }), 'set to null').rejects.toThrow(
      notNull(table, column),
    )
    await expect(db(table).insert(omit(row, column)), 'left out').rejects.toThrow(notNull(table, column))
    expect(await count(table)).toBe(0)
    await expect(db(table).insert(row), 'the valid row').resolves.toBeDefined()
  })
})

describe('CHECKs refuse by name', () => {
  it('category_proposals: confidence is a REAL in 0..1, reason is not blank, enums are closed', async () => {
    for (const confidence of [-0.1, 1.1, 'abc', '']) {
      await expect(
        db('category_proposals').insert(proposal(transactionId, { confidence })),
        String(confidence),
      ).rejects.toThrow(refusedBy('category_proposals_confidence_unit_interval'))
    }
    for (const reason of ['', '   ']) {
      await expect(
        db('category_proposals').insert(proposal(transactionId, { reason })),
        JSON.stringify(reason),
      ).rejects.toThrow(refusedBy('category_proposals_reason_not_blank'))
    }
    await expect(db('category_proposals').insert(proposal(transactionId, { origin: 'claude' }))).rejects.toThrow(
      refusedBy('origin'),
    )
    await expect(db('category_proposals').insert(proposal(transactionId, { status: 'done' }))).rejects.toThrow(
      refusedBy('status'),
    )
    expect(await count('category_proposals')).toBe(0)

    // The boundaries pass, and an integer lands as a REAL.
    for (const [confidence, category] of [
      [0, 'Bakeries'],
      [1, 'Supermarkets and grocery stores'],
    ] as const) {
      await db('category_proposals').insert(
        proposal(transactionId, { confidence, proposed_category: category }),
      )
    }
    expect(
      await db('category_proposals')
        .orderBy('id')
        .select(db.raw('confidence, typeof(confidence) as t')),
    ).toStrictEqual([
      { confidence: 0, t: 'real' },
      { confidence: 1, t: 'real' },
    ])
  })

  it('insights: chart_spec_json is NULL or JSON, enums are closed', async () => {
    await expect(db('insights').insert(insight({ chart_spec_json: '{' }))).rejects.toThrow(
      refusedBy('insights_chart_spec_is_json'),
    )
    await expect(db('insights').insert(insight({ kind: 'x' }))).rejects.toThrow(refusedBy('kind'))
    await expect(db('insights').insert(insight({ scope: 'x' }))).rejects.toThrow(refusedBy('scope'))
    expect(await count('insights')).toBe(0)

    await db('insights').insert(insight({ chart_spec_json: '{"mark":"bar"}' }))
    await db('insights').insert(insight({ chart_spec_json: null }))
    expect(await count('insights')).toBe(2)
  })

  it('agent_runs: running iff unfinished', async () => {
    for (const fields of [
      { outcome: 'running', finished_at: LATER },
      { outcome: 'success', finished_at: null },
      { outcome: 'failed', finished_at: null },
    ]) {
      await expect(db('agent_runs').insert(run(fields)), JSON.stringify(fields)).rejects.toThrow(
        refusedBy('agent_runs_running_iff_unfinished'),
      )
    }
    expect(await count('agent_runs')).toBe(0)
    await db('agent_runs').insert(run({ outcome: 'success', finished_at: LATER }))
    await db('agent_runs').insert(run({ outcome: 'failed', finished_at: LATER }))
    expect(await count('agent_runs')).toBe(2)
  })

  it.each(['considered_count', 'written_count'])('agent_runs: %s is a non-negative integer', async (column) => {
    for (const value of [-1, 1.5, '1.5', 'one']) {
      await expect(db('agent_runs').insert(run({ [column]: value })), String(value)).rejects.toThrow(
        refusedBy('agent_runs_counts_non_negative_integers'),
      )
    }
    expect(await count('agent_runs')).toBe(0)
    await db('agent_runs').insert(run({ [column]: 7 }))
    expect(await db('agent_runs').pluck(column)).toEqual([7])
  })

  it('agent_runs: a sync_run_id exactly when the trigger is sync', async () => {
    for (const fields of [
      { trigger: 'sync', sync_run_id: null },
      { trigger: 'weekly', sync_run_id: syncRunId },
      { trigger: 'manual', sync_run_id: syncRunId },
    ]) {
      await expect(db('agent_runs').insert(run(fields)), JSON.stringify(fields)).rejects.toThrow(
        refusedBy('agent_runs_sync_run_iff_sync_trigger'),
      )
    }
    await expect(db('agent_runs').insert(run({ kind: 'x' }))).rejects.toThrow(refusedBy('kind'))
    await expect(db('agent_runs').insert(run({ trigger: 'cron' }))).rejects.toThrow(refusedBy('trigger'))
    await expect(db('agent_runs').insert(run({ outcome: 'x' }))).rejects.toThrow(refusedBy('outcome'))
    expect(await count('agent_runs')).toBe(0)

    await db('agent_runs').insert(run({ kind: 'category', trigger: 'sync', sync_run_id: syncRunId }))
    expect(await db('agent_runs').pluck('sync_run_id')).toEqual([syncRunId])
  })
})

describe('(transaction_id, proposed_category) is unique in every status (Done-when 3)', () => {
  const DUPLICATE = /UNIQUE constraint failed: category_proposals\.transaction_id, category_proposals\.proposed_category$/

  it.each(PROPOSAL_STATUSES)('a %s pair cannot be inserted again, in any status', async (status) => {
    await db('category_proposals').insert(proposal(transactionId, { status }))
    for (const again of PROPOSAL_STATUSES) {
      await expect(
        db('category_proposals').insert(proposal(transactionId, { status: again, created_at: LATER })),
        again,
      ).rejects.toThrow(DUPLICATE)
    }
    expect(await db('category_proposals').pluck('status')).toEqual([status])
  })

  it('allows another category for the same transaction, and the same category for another', async () => {
    const [otherId] = await db('transactions').insert(transaction({ akahu_id: 'trans_fixture_other' }))
    await db('category_proposals').insert(proposal(transactionId))
    await db('category_proposals').insert(
      proposal(transactionId, { proposed_category: 'Supermarkets and grocery stores' }),
    )
    await db('category_proposals').insert(proposal(otherId))
    expect(await count('category_proposals')).toBe(3)
  })

  it('serves a lookup by transaction_id from the unique index, the only index on the table', async () => {
    const plan: { detail: string }[] = await db.raw(
      'EXPLAIN QUERY PLAN SELECT * FROM category_proposals WHERE transaction_id = ?',
      [transactionId],
    )
    expect(plan.map((p) => p.detail).join('\n')).toContain(
      'USING INDEX category_proposals_transaction_id_proposed_category_unique',
    )
    const indexes: { name: string; unique: number }[] = await db.raw('PRAGMA index_list(category_proposals)')
    expect(indexes.map((i) => [i.name, i.unique])).toEqual([
      ['category_proposals_transaction_id_proposed_category_unique', 1],
    ])
  })
})

describe('foreign keys', () => {
  it('category_proposals.transaction_id cascades; agent_runs.sync_run_id is NO ACTION', async () => {
    const keys = async (table: string) =>
      (
        (await db.raw('PRAGMA foreign_key_list(??)', [table])) as {
          table: string
          from: string
          to: string
          on_delete: string
        }[]
      ).map((k) => `${k.from} -> ${k.table}.${k.to} ON DELETE ${k.on_delete}`)
    expect(await keys('category_proposals')).toEqual(['transaction_id -> transactions.id ON DELETE CASCADE'])
    expect(await keys('agent_runs')).toEqual(['sync_run_id -> sync_runs.id ON DELETE NO ACTION'])
    expect(await keys('insights')).toEqual([])
  })

  it('deleting a transaction deletes its proposals in every status', async () => {
    const [otherId] = await db('transactions').insert(transaction({ akahu_id: 'trans_fixture_other' }))
    const categories = ['Bakeries', 'Supermarkets and grocery stores', 'Cafes and restaurants']
    for (const [i, status] of PROPOSAL_STATUSES.entries()) {
      await db('category_proposals').insert(proposal(transactionId, { status, proposed_category: categories[i] }))
    }
    await db('category_proposals').insert(proposal(otherId))

    await db('transactions').where({ id: transactionId }).delete()

    expect(await db('category_proposals').pluck('transaction_id')).toEqual([otherId])
  })

  it("sync's pending-mirror delete still runs over a pending row with a proposal", async () => {
    const [pendingId] = await db('transactions').insert(
      transaction({ akahu_id: null, status: 'pending', source: 'akahu' }),
    )
    await db('category_proposals').insert(proposal(pendingId))

    // The same delete `replacePending` makes (server/sync/upsert.ts).
    await db('transactions').where({ status: 'pending', source: 'akahu' }).del()

    expect(await db('transactions').pluck('id')).toEqual([transactionId])
    expect(await count('category_proposals')).toBe(0)
  })

  it('refuses a proposal for a transaction that does not exist', async () => {
    await expect(db('category_proposals').insert(proposal(transactionId + 1000))).rejects.toThrow(FOREIGN_KEY)
    expect(await count('category_proposals')).toBe(0)
  })

  it('refuses a run for a sync run that does not exist, and the delete of a sync run a run names', async () => {
    await expect(
      db('agent_runs').insert(run({ kind: 'category', trigger: 'sync', sync_run_id: syncRunId + 1000 })),
    ).rejects.toThrow(FOREIGN_KEY)

    await db('agent_runs').insert(run({ kind: 'category', trigger: 'sync', sync_run_id: syncRunId }))
    await expect(db('sync_runs').where({ id: syncRunId }).delete()).rejects.toThrow(FOREIGN_KEY)
    expect(await db('sync_runs').pluck('id')).toEqual([syncRunId])
    expect(await db('agent_runs').pluck('sync_run_id')).toEqual([syncRunId])
  })
})

describe('rollback', () => {
  it('rolls back to the schema it started from, with rows present, and leaves prd-01 untouched', async () => {
    await db('category_proposals').insert(proposal(transactionId, { status: 'rejected' }))
    await db('insights').insert(insight({ chart_spec_json: '{"mark":"bar"}' }))
    await db('agent_runs').insert(run({ kind: 'category', trigger: 'sync', sync_run_id: syncRunId }))
    for (const table of OUR_TABLES) {
      expect(await count(table), table).toBe(1)
      expect(await sequence(db, table), table).toBe(1)
    }

    await db.migrate.down()

    expect(await applied()).not.toContain(OURS)
    expect(await tables()).toEqual(tablesBefore)
    expect(await otherObjects()).toStrictEqual(objectsBefore)
    for (const table of OUR_TABLES) expect(await sequence(db, table), table).toBeUndefined()
    expect(await prd01State()).toStrictEqual(prd01Before)

    await db.migrate.up()
    for (const table of OUR_TABLES) expect(await count(table), table).toBe(0)
  })

  it('a fresh database migrates to latest, rolls all the way back, and migrates again', async () => {
    const fresh = knex(config.test)
    try {
      await fresh.migrate.latest()
      await fresh.migrate.rollback(undefined, true)
      const [completed] = (await fresh.migrate.list()) as [unknown[], unknown]
      expect(completed).toEqual([])
      await fresh.migrate.latest()
      for (const table of OUR_TABLES) expect(await fresh.schema.hasTable(table), table).toBe(true)
    } finally {
      await fresh.destroy()
    }
  })
})

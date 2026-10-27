// prd-04 Ruling 9 (#428): 20261028120000_ruling9_claude_origin_and_usage.js
// rebuilds `category_proposals` and `agent_runs` to allow origin `claude`,
// outcome `blocked` and the usage columns. Seeds the schema just before it
// with rule proposals and finished runs, steps up, and checks every row and
// id counter survives; then steps down and up again. Every fixture value
// here is invented.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../../db/knexfile.js'
import { migrateToJustBefore } from '../../../db/__tests__/migrateToJustBefore.ts'
import { sequence } from '../../../db/__tests__/schemaInfo.ts'
import { AGENT_RUN_OUTCOMES, PROPOSAL_ORIGINS } from '../../contracts.ts'

const OURS = '20261028120000_ruling9_claude_origin_and_usage.js'
const TABLES = ['category_proposals', 'agent_runs']
const PARENTS = ['transactions', 'sync_runs']
const USAGE = ['model', 'input_tokens', 'output_tokens', 'cost_micro_usd']
const NO_USAGE = { model: null, input_tokens: null, output_tokens: null, cost_micro_usd: null }

const AT = '2026-10-28T03:00:00.000Z'
const LATER = '2026-10-28T03:05:00.000Z'

type Row = Record<string, unknown>

const refusedBy = (check: string) => new RegExp(`CHECK constraint failed: ${check}$`)
const FOREIGN_KEY = /FOREIGN KEY constraint failed$/

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

const run = (fields: Row = {}): Row => ({
  kind: 'category',
  trigger: 'manual',
  started_at: AT,
  finished_at: LATER,
  outcome: 'success',
  considered_count: 12,
  written_count: 3,
  sync_run_id: null,
  cursor: null,
  ...fields,
})

let db: Knex
let transactionId: number
let syncRunId: number

interface State {
  rows: Record<string, Row[]>
  seq: Record<string, number | undefined>
  sql: Record<string, string>
  foreignKeys: Record<string, Row[]>
  indexes: Record<string, Row[]>
}

async function state(): Promise<State> {
  const s: State = { rows: {}, seq: {}, sql: {}, foreignKeys: {}, indexes: {} }
  for (const table of [...TABLES, ...PARENTS]) {
    s.rows[table] = await db(table).orderBy('id')
    s.seq[table] = await sequence(db, table)
  }
  for (const table of TABLES) {
    const row = await db('sqlite_master').where({ type: 'table', name: table }).first('sql')
    s.sql[table] = String(row?.sql)
    s.foreignKeys[table] = await db.raw('PRAGMA foreign_key_list(??)', [table])
    const indexes: Row[] = await db.raw('PRAGMA index_list(??)', [table])
    s.indexes[table] = []
    for (const index of indexes) {
      const columns: { name: string }[] = await db.raw('PRAGMA index_info(??)', [index.name])
      s.indexes[table].push({
        name: index.name,
        unique: index.unique,
        columns: columns.map((c) => c.name),
      })
    }
  }
  return s
}

// The allowed values of a knex `enu` column on `table`.
function enumValues(sql: string, column: string): string[] {
  const m = sql.match(new RegExp(`\`${column}\` text check \\(\`${column}\` in \\(([^)]*)\\)\\)`))
  return [...String(m?.[1]).matchAll(/'([^']*)'/g)].map((v) => v[1])
}

let before: State

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, OURS)

  ;[transactionId] = await db('transactions').insert({
    akahu_id: 'trans_fixture_kept',
    account_id: 'acc_fixture_everyday',
    amount_cents: -450,
  })
  ;[syncRunId] = await db('sync_runs').insert({
    started_at: AT,
    finished_at: LATER,
    outcome: 'success',
  })

  await db('category_proposals').insert(proposal(transactionId, { status: 'pending' }))
  await db('category_proposals').insert(
    proposal(transactionId, {
      proposed_category: 'Groceries',
      current_category: 'Bakeries',
      confidence: 0.55,
      status: 'accepted',
    }),
  )
  await db('category_proposals').insert(
    proposal(transactionId, { proposed_category: 'Cafes', status: 'rejected' }),
  )
  // Inserted and deleted, so the counter sits above every live id.
  const [deletedProposal] = await db('category_proposals').insert(
    proposal(transactionId, { proposed_category: 'Takeaways' }),
  )
  await db('category_proposals').where({ id: deletedProposal }).delete()

  await db('agent_runs').insert(run({ outcome: 'success', cursor: 'txn:41' }))
  await db('agent_runs').insert(
    run({ kind: 'insights', trigger: 'weekly', outcome: 'failed', considered_count: 0, written_count: 0 }),
  )
  await db('agent_runs').insert(run({ trigger: 'sync', sync_run_id: syncRunId }))
  const [deletedRun] = await db('agent_runs').insert(run({ trigger: 'manual' }))
  await db('agent_runs').where({ id: deletedRun }).delete()

  before = await state()
  expect(before.rows.category_proposals).toHaveLength(3)
  expect(before.rows.agent_runs).toHaveLength(3)
  expect(before.seq.category_proposals).toBe(deletedProposal)
  expect(before.seq.agent_runs).toBe(deletedRun)
})

afterEach(async () => {
  await db.destroy()
})

describe('up (Ruling 9)', () => {
  it('keeps every row and id counter, and gives old runs null usage', async () => {
    await db.migrate.up()
    const after = await state()

    expect(after.rows.category_proposals).toStrictEqual(before.rows.category_proposals)
    expect(after.rows.agent_runs).toStrictEqual(
      before.rows.agent_runs.map((r) => ({ ...r, ...NO_USAGE })),
    )
    for (const r of after.rows.agent_runs) {
      expect(Object.keys(r).sort()).toEqual([...Object.keys(before.rows.agent_runs[0]), ...USAGE].sort())
    }
    for (const table of PARENTS) expect(after.rows[table], table).toStrictEqual(before.rows[table])
    expect(after.seq).toStrictEqual(before.seq)
  })

  it('keeps the foreign keys and indexes', async () => {
    await db.migrate.up()
    const after = await state()

    expect(after.foreignKeys).toStrictEqual(before.foreignKeys)
    expect(after.indexes).toStrictEqual(before.indexes)
    expect(after.foreignKeys.category_proposals).toMatchObject([
      { table: 'transactions', from: 'transaction_id', to: 'id', on_delete: 'CASCADE' },
    ])
    expect(after.foreignKeys.agent_runs).toMatchObject([
      { table: 'sync_runs', from: 'sync_run_id', to: 'id', on_delete: 'NO ACTION' },
    ])
    expect(after.indexes.category_proposals).toStrictEqual([
      {
        name: 'category_proposals_transaction_id_proposed_category_unique',
        unique: 1,
        columns: ['transaction_id', 'proposed_category'],
      },
    ])
    expect(after.indexes.agent_runs).toStrictEqual([
      { name: 'agent_runs_kind_started_at_index', unique: 0, columns: ['kind', 'started_at'] },
    ])

    // And they still act: the run's sync run cannot go, the transaction's
    // proposals go with it.
    await expect(db('sync_runs').where({ id: syncRunId }).delete()).rejects.toThrow(FOREIGN_KEY)
    await db('transactions').where({ id: transactionId }).delete()
    expect(await db('category_proposals').count('* as n').first()).toStrictEqual({ n: 0 })
  })

  it('allows the values the contracts name', async () => {
    await db.migrate.up()
    const { sql } = await state()

    expect(enumValues(sql.category_proposals, 'origin')).toEqual([...PROPOSAL_ORIGINS])
    expect(enumValues(sql.agent_runs, 'outcome')).toEqual([...AGENT_RUN_OUTCOMES])
  })

  it('takes a claude proposal and a blocked run with usage, after the old ids', async () => {
    await db.migrate.up()

    const [proposalId] = await db('category_proposals').insert(
      proposal(transactionId, { proposed_category: 'Dining out', origin: 'claude' }),
    )
    const [runId] = await db('agent_runs').insert(
      run({
        outcome: 'blocked',
        model: 'claude-haiku-5-5',
        input_tokens: 1200,
        output_tokens: 80,
        cost_micro_usd: 1600,
      }),
    )

    expect(proposalId).toBe(Number(before.seq.category_proposals) + 1)
    expect(runId).toBe(Number(before.seq.agent_runs) + 1)
    expect(await db('agent_runs').where({ id: runId }).first()).toStrictEqual({
      id: runId,
      ...run({
        outcome: 'blocked',
        model: 'claude-haiku-5-5',
        input_tokens: 1200,
        output_tokens: 80,
        cost_micro_usd: 1600,
      }),
    })
  })

  it('refuses an unknown origin or outcome', async () => {
    await db.migrate.up()

    // knex's `enu` CHECKs are unnamed; SQLite names them by their column.
    await expect(
      db('category_proposals').insert(proposal(transactionId, { proposed_category: 'Fuel', origin: 'haiku' })),
    ).rejects.toThrow(refusedBy('origin'))
    await expect(db('agent_runs').insert(run({ outcome: 'paused' }))).rejects.toThrow(refusedBy('outcome'))
    // `blocked` is a finished outcome.
    await expect(db('agent_runs').insert(run({ outcome: 'blocked', finished_at: null }))).rejects.toThrow(
      refusedBy('agent_runs_running_iff_unfinished'),
    )
  })

  it.each(['input_tokens', 'output_tokens', 'cost_micro_usd'])(
    'refuses a negative, fractional or text %s',
    async (column) => {
      await db.migrate.up()

      // '12' is not here: INTEGER affinity stores it as 12 before the CHECK.
      for (const bad of [-1, 12.5, 'abc']) {
        await expect(db('agent_runs').insert(run({ [column]: bad })), String(bad)).rejects.toThrow(
          refusedBy('agent_runs_usage_non_negative_integers'),
        )
      }
      await db('agent_runs').insert(run({ [column]: 0 }))
    },
  )
})

describe('a proposal whose transaction is already gone (keys once off)', () => {
  it('survives up and down as it was, and the keys are on afterwards', async () => {
    const [orphanParent] = await db('transactions').insert({
      akahu_id: 'trans_fixture_gone',
      account_id: 'acc_fixture_everyday',
      amount_cents: -900,
    })
    const [orphanId] = await db('category_proposals').insert(proposal(orphanParent))
    await db.raw('PRAGMA foreign_keys = OFF')
    await db('transactions').where({ id: orphanParent }).delete()
    await db.raw('PRAGMA foreign_keys = ON')
    const orphan = await db('category_proposals').where({ id: orphanId }).first()

    await db.migrate.up()
    expect(await db('category_proposals').where({ id: orphanId }).first()).toStrictEqual(orphan)
    await db.migrate.down()
    expect(await db('category_proposals').where({ id: orphanId }).first()).toStrictEqual(orphan)

    expect(await db.raw('PRAGMA foreign_keys')).toStrictEqual([{ foreign_keys: 1 }])
    await expect(db('category_proposals').insert(proposal(orphanParent, { proposed_category: 'Fuel' }))).rejects.toThrow(
      FOREIGN_KEY,
    )
  })
})

describe('down (Ruling 9)', () => {
  it('round-trips: keeps the old rows, restores the old schema, and steps up again', async () => {
    await db.migrate.up()
    await db('category_proposals').insert(
      proposal(transactionId, { proposed_category: 'Dining out', origin: 'claude' }),
    )
    await db('agent_runs').insert(run({ outcome: 'blocked', model: 'claude-haiku-5-5', input_tokens: 10 }))
    await db('agent_runs').insert(run({ outcome: 'success', model: 'claude-haiku-5-5', input_tokens: 20 }))
    const highWater = await state()

    await db.migrate.down()
    const down = await state()

    // The success run with usage was not there before `up`; it fits the old
    // shape, so it stays without its usage.
    const successWithUsage = highWater.rows.agent_runs.find((r) => r.input_tokens === 20) ?? {}
    expect(down.rows.category_proposals).toStrictEqual(before.rows.category_proposals)
    expect(down.rows.agent_runs).toStrictEqual([
      ...before.rows.agent_runs,
      Object.fromEntries(Object.entries(successWithUsage).filter(([k]) => !USAGE.includes(k))),
    ])
    for (const table of PARENTS) expect(down.rows[table], table).toStrictEqual(before.rows[table])
    expect(down.sql).toStrictEqual(before.sql)
    expect(down.foreignKeys).toStrictEqual(before.foreignKeys)
    expect(down.indexes).toStrictEqual(before.indexes)
    expect(down.seq).toStrictEqual(highWater.seq)

    await db.migrate.up()
    const again = await state()
    expect(again.rows.category_proposals).toStrictEqual(before.rows.category_proposals)
    expect(again.rows.agent_runs).toStrictEqual(down.rows.agent_runs.map((r) => ({ ...r, ...NO_USAGE })))
    expect(again.seq).toStrictEqual(highWater.seq)
  })
})

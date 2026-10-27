// prd-04 Ruling 9 (#428): the category agent may call Haiku again, so its
// inboxes allow the model path. Amends 20261025160000_agent_inboxes.js for
// `category_proposals` and `agent_runs`, and touches nothing else:
// - `category_proposals.origin` allows `claude` beside `rule`.
// - `agent_runs.outcome` allows `blocked`: the run stopped before calling the
//   model because the kill switch is on or the daily token budget is spent.
//   A blocked run is finished, so `finished_at` is set, as for every outcome
//   but `running`.
// - `agent_runs` gains `model`, `input_tokens`, `output_tokens` and
//   `cost_micro_usd`, all nullable and NULL on a run that called no model.
//   The token and cost columns hold an integer >= 0 or NULL; the CHECK
//   refuses 12.5 and 'abc', which SQLite's INTEGER affinity would store as a
//   REAL and as text.
//   `cost_micro_usd` is millionths of a US dollar, Anthropic's billing
//   currency; it is not Divvy money and is never added to a cents column.
// The insights table is untouched: Ruling 7 still governs the insights agent.
//
// SQLite holds an enum as a CHECK in the table's CREATE statement, so
// widening one means rebuilding the table. Each table is rebuilt the same
// way: rename the old copy aside, drop its indexes so the new copy can take
// their names, create the new copy with knex's `createTable` (so
// `sqlite_master.sql` stays in knex's format, which the tests parse), copy
// every row with its id, drop the old copy, and put back the AUTOINCREMENT
// high-water mark, which can sit above max(id) after deletes (see
// 20261023120000_money_as_cents.js).
//
// The copy runs with `PRAGMA defer_foreign_keys = ON` (PRAGMA foreign_keys =
// OFF is ignored inside the migration transaction). A row whose parent is
// already gone can only exist if the keys were once off, as a test does on
// purpose; copying it would fail an immediate check. Deferred, the copy's
// violation is cancelled by dropping the old copy's identical row, so the
// rebuild keeps such a row as it found it rather than losing it or throwing.
// Any violation the rebuild did not inherit still fails the commit.
//
// Both tables are children only: nothing references `category_proposals` or
// `agent_runs`, so dropping their old copies cascades nothing. Their parents,
// `transactions` and `sync_runs`, are never rebuilt (hazard in
// 20261025160000_agent_inboxes.js); renaming and dropping a child leaves the
// parent alone.
//
// Every other rule of 20261025160000 stands: the same columns, types,
// nullability, named CHECKs, count defaults, the one unique index on
// `category_proposals` and the (kind, started_at) index on `agent_runs`,
// transaction_id ON DELETE CASCADE and sync_run_id NO ACTION. `trigger` and
// `cursor` are SQL keywords, so the row copy binds every column with `??`.
//
// The enum lists below repeat server/agents/contracts.ts;
// server/agents/db/__tests__/agent-runs.test.ts pins the outcome list to the
// table, and ruling9-migration.test.ts pins both.
//
// Rolling back deletes every row that could not exist before this migration
// (a proposal with origin `claude`, a run with outcome `blocked`), drops the
// usage columns with their values, and keeps every other row.

const PROPOSAL_ORIGINS_BEFORE = ['rule']
const PROPOSAL_ORIGINS = ['rule', 'claude']
const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected']
const AGENT_KINDS = ['category', 'insights']
const AGENT_TRIGGERS = ['sync', 'weekly', 'manual']
const AGENT_RUN_OUTCOMES_BEFORE = ['running', 'success', 'failed']
const AGENT_RUN_OUTCOMES = ['running', 'success', 'failed', 'blocked']

const PROPOSAL_COLUMNS = [
  'id',
  'transaction_id',
  'current_category',
  'proposed_category',
  'confidence',
  'reason',
  'origin',
  'status',
  'created_at',
]
const PROPOSAL_INDEXES = [
  'category_proposals_transaction_id_proposed_category_unique',
]

const RUN_COLUMNS = [
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
]
const RUN_INDEXES = ['agent_runs_kind_started_at_index']

function createProposals(knex, origins) {
  return knex.schema.createTable('category_proposals', (table) => {
    table.increments('id').primary()
    table
      .integer('transaction_id')
      .notNullable()
      .references('id')
      .inTable('transactions')
      .onDelete('CASCADE')
    table.string('current_category')
    table.string('proposed_category').notNullable()
    table.float('confidence').notNullable()
    table.text('reason').notNullable()
    table.enu('origin', origins).notNullable()
    table.enu('status', PROPOSAL_STATUSES).notNullable()
    table.timestamp('created_at').notNullable()

    table.unique(['transaction_id', 'proposed_category'])
    table.check(
      "typeof(??) = 'real' AND ?? >= 0 AND ?? <= 1",
      ['confidence', 'confidence', 'confidence'],
      'category_proposals_confidence_unit_interval',
    )
    table.check(
      'length(trim(??)) > 0',
      ['reason'],
      'category_proposals_reason_not_blank',
    )
  })
}

function createRuns(knex, outcomes, withUsage) {
  return knex.schema.createTable('agent_runs', (table) => {
    table.increments('id').primary()
    table.enu('kind', AGENT_KINDS).notNullable()
    table.enu('trigger', AGENT_TRIGGERS).notNullable()
    table.timestamp('started_at').notNullable()
    table.timestamp('finished_at')
    table.enu('outcome', outcomes).notNullable()
    table.integer('considered_count').notNullable().defaultTo(0)
    table.integer('written_count').notNullable().defaultTo(0)
    table.integer('sync_run_id').references('id').inTable('sync_runs')
    table.text('cursor')
    if (withUsage) {
      table.string('model')
      table.integer('input_tokens')
      table.integer('output_tokens')
      table.integer('cost_micro_usd')
    }

    table.index(['kind', 'started_at'])
    table.check(
      '(?? = ?) = (?? IS NULL)',
      ['outcome', 'running', 'finished_at'],
      'agent_runs_running_iff_unfinished',
    )
    table.check(
      "typeof(??) = 'integer' AND ?? >= 0 AND typeof(??) = 'integer' AND ?? >= 0",
      ['considered_count', 'considered_count', 'written_count', 'written_count'],
      'agent_runs_counts_non_negative_integers',
    )
    table.check(
      "(?? = 'sync') = (?? IS NOT NULL)",
      ['trigger', 'sync_run_id'],
      'agent_runs_sync_run_iff_sync_trigger',
    )
    if (withUsage) {
      const usage = ['input_tokens', 'output_tokens', 'cost_micro_usd']
      table.check(
        usage
          .map(() => "(?? IS NULL OR (typeof(??) = 'integer' AND ?? >= 0))")
          .join(' AND '),
        usage.flatMap((column) => [column, column, column]),
        'agent_runs_usage_non_negative_integers',
      )
    }
  })
}

async function readSequence(knex, table) {
  const row = await knex('sqlite_sequence').where({ name: table }).first('seq')
  return row ? row.seq : null
}

// The new copy's counter is max(copied id), or absent when no row was
// copied; either way it may be below the old copy's.
async function restoreSequence(knex, table, seq) {
  if (seq === null) return
  const updated = await knex('sqlite_sequence')
    .where({ name: table })
    .update({ seq: knex.raw('max(seq, ?)', [seq]) })
  if (updated === 0) await knex('sqlite_sequence').insert({ name: table, seq })
}

// Rebuilds `table` with `create`, copying `columns` of every row.
async function rebuild(knex, { table, columns, indexes, create }) {
  const seq = await readSequence(knex, table)
  const aside = `${table}_before_rebuild`

  await knex.schema.renameTable(table, aside)
  for (const index of indexes) await knex.raw('DROP INDEX ??', [index])
  await create()

  const list = columns.map(() => '??').join(', ')
  await knex.raw('PRAGMA defer_foreign_keys = ON')
  await knex.raw(`INSERT INTO ?? (${list}) SELECT ${list} FROM ??`, [
    table,
    ...columns,
    ...columns,
    aside,
  ])
  await knex.schema.dropTable(aside)
  await knex.raw('PRAGMA defer_foreign_keys = OFF')

  await restoreSequence(knex, table, seq)
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await rebuild(knex, {
    table: 'category_proposals',
    columns: PROPOSAL_COLUMNS,
    indexes: PROPOSAL_INDEXES,
    create: () => createProposals(knex, PROPOSAL_ORIGINS),
  })
  await rebuild(knex, {
    table: 'agent_runs',
    columns: RUN_COLUMNS,
    indexes: RUN_INDEXES,
    create: () => createRuns(knex, AGENT_RUN_OUTCOMES, true),
  })
}

/**
 * Deletes every `claude` proposal and every `blocked` run, and the usage
 * columns' values; keeps every other row.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex('category_proposals').where({ origin: 'claude' }).delete()
  await knex('agent_runs').where({ outcome: 'blocked' }).delete()

  await rebuild(knex, {
    table: 'category_proposals',
    columns: PROPOSAL_COLUMNS,
    indexes: PROPOSAL_INDEXES,
    create: () => createProposals(knex, PROPOSAL_ORIGINS_BEFORE),
  })
  await rebuild(knex, {
    table: 'agent_runs',
    columns: RUN_COLUMNS,
    indexes: RUN_INDEXES,
    create: () => createRuns(knex, AGENT_RUN_OUTCOMES_BEFORE, false),
  })
}

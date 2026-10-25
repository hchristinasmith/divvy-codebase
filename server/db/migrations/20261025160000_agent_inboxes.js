// prd-04 wave 1 (#31), Rulings 2, 5, 7 and 8: the agents' inboxes. Creates
// `category_proposals`, `insights` and `agent_runs`, and touches nothing
// else. Agents write only these tables (Ruling 2); nothing here holds money
// state.
//
// Scope, as amended on #31 by Ruling 7 (no model calls):
// - `category_proposals.origin` is `rule` only. `claude` comes back only by
//   a further amendment.
// - `agent_runs` is a run log only: which agent, why it ran, when, how it
//   ended, how many rows it considered and wrote, and the polling state of
//   Ruling 5 (`sync_run_id`, `cursor`). No model, token, cost or money
//   column. No error column either: a failed run's reason goes to the server
//   log, not to a row kept indefinitely.
// - `insights` has exactly Ruling 2's columns. The optional Mermaid text of
//   Ruling 3 (`Insight.mermaid` in models/insights.ts) has no column.
//
// category_proposals.transaction_id is ON DELETE CASCADE, as
// `category_corrections.transaction_id` is. Sync replaces the pending mirror
// on every run by deleting every pending row and inserting new ones with new
// ids (`replacePending`, server/sync/upsert.ts). RESTRICT or NO ACTION would
// make that delete throw the first time a pending row had a proposal, and
// wedge every sync from then on. A proposal for a deleted id has nothing
// left to suppress: the replacement row has a different id. Consequence for
// the category agent: propose only on settled rows, or the proposal is lost
// at the next sync.
//
// agent_runs.sync_run_id is NO ACTION (no `onDelete`). Nothing deletes or
// rebuilds `sync_runs`. SET NULL would silently erase a run's record of the
// sync run it processed, which is what the poller reads to know which sync
// runs are done; NO ACTION makes such a delete fail loudly instead.
//
// From here on, never rebuild `transactions` or `sync_runs` (knex
// `dropColumn`, `.alter()`, or anything that recreates the table): the
// rebuild runs inside the migration transaction, where PRAGMA foreign_keys =
// OFF is ignored. Rebuilding `transactions` cascades into this table and
// deletes every proposal, the rejected ones included; rebuilding `sync_runs`
// now throws on the first run that names it. See the hazard in
// 20261023120000_money_as_cents.js.
//
// Never INSERT OR REPLACE a proposal, nor delete and re-insert one. A
// `rejected` row is the permanent memory that suppresses that (transaction,
// proposed category) pair (prd-04 Done-when 3, dated note 3); the unique
// index below refuses a second row for the pair in every status. Nothing
// prunes this table.
//
// The unique index leads with `transaction_id`, so it also serves the
// cascade's lookup by transaction; there is no second index.
//
// Counts CHECK `typeof(col) = 'integer'` and confidence CHECKs
// `typeof(col) = 'real'`: SQLite's affinity stores 12.5 in an INTEGER column
// as a REAL, and 'abc' in a FLOAT column as text, rather than refusing
// either.
//
// Instants are ISO-8601 UTC strings ending in `Z`, written by the
// application; no `CURRENT_TIMESTAMP` default. `trigger` and `cursor` are SQL
// keywords: knex quotes them, and any raw SQL naming them must bind them
// with `??`.
//
// The enum lists below repeat server/agents/contracts.ts and
// models/insights.ts; server/agents/db/__tests__/migration.test.ts pins them
// equal.
//
// Rolling back deletes every proposal, insight and run.

const PROPOSAL_ORIGINS = ['rule']
const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected']
const INSIGHT_KINDS = ['pattern', 'report', 'chart']
const SCOPES = ['personal', 'strawb']
const AGENT_KINDS = ['category', 'insights']
const AGENT_TRIGGERS = ['sync', 'weekly', 'manual']
const AGENT_RUN_OUTCOMES = ['running', 'success', 'failed']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('category_proposals', (table) => {
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
    table.enu('origin', PROPOSAL_ORIGINS).notNullable()
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

  await knex.schema.createTable('insights', (table) => {
    table.increments('id').primary()
    table.enu('kind', INSIGHT_KINDS).notNullable()
    table.string('title').notNullable()
    table.text('body_md').notNullable()
    table.text('chart_spec_json')
    table.enu('scope', SCOPES).notNullable()
    table.string('period').notNullable()
    table.timestamp('created_at').notNullable()
    table.timestamp('dismissed_at')

    table.check(
      '?? IS NULL OR json_valid(??)',
      ['chart_spec_json', 'chart_spec_json'],
      'insights_chart_spec_is_json',
    )
  })

  await knex.schema.createTable('agent_runs', (table) => {
    table.increments('id').primary()
    table.enu('kind', AGENT_KINDS).notNullable()
    table.enu('trigger', AGENT_TRIGGERS).notNullable()
    table.timestamp('started_at').notNullable()
    table.timestamp('finished_at')
    table.enu('outcome', AGENT_RUN_OUTCOMES).notNullable()
    table.integer('considered_count').notNullable().defaultTo(0)
    table.integer('written_count').notNullable().defaultTo(0)
    table.integer('sync_run_id').references('id').inTable('sync_runs')
    table.text('cursor')

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
  })
}

/**
 * Deletes every proposal, insight and run.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('agent_runs')
  await knex.schema.dropTable('insights')
  await knex.schema.dropTable('category_proposals')
}

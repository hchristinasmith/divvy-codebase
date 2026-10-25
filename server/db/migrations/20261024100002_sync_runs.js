// prd-01 wave 1 (#19): one row per Akahu sync run, so a failed run can be
// seen with its error text and the counts of what a run changed.
//
// The CHECKs keep a row honest: a run is `running` exactly while it has no
// `finished_at`, a `failed` run always says why, and no count is negative.
// The partial unique index allows one `running` row at a time (prd-01
// Ruling 6, one sync at a time).
//
// Consequence for sync: a process that dies mid-run leaves its row
// `running`, and the index then refuses every later run. The claim step of
// each run (prd-01 Ruling 6 implementation note, #21) closes a stale
// `running` row as `failed`, with a `finished_at` and a fixed error message,
// before it starts its own; a younger `running` row makes the run skip.
//
// `error_message` is shown to Hannah and kept indefinitely. It must never
// contain a token, a request header or a raw Akahu response body.
//
// Instants are ISO-8601 UTC strings ending in `Z`, written by the
// application; no `CURRENT_TIMESTAMP` default.

const OUTCOMES = ['running', 'success', 'failed']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('sync_runs', (table) => {
    table.increments('id').primary()
    table.timestamp('started_at').notNullable()
    table.timestamp('finished_at')
    table.enu('outcome', OUTCOMES).notNullable().defaultTo('running')
    table.integer('inserted_count').notNullable().defaultTo(0)
    table.integer('updated_count').notNullable().defaultTo(0)
    table.integer('pending_mirrored_count').notNullable().defaultTo(0)
    table.text('error_message')

    table.index(['started_at'])
    table.check(
      '(?? = ?) = (?? IS NULL)',
      ['outcome', 'running', 'finished_at'],
      'sync_runs_running_iff_unfinished',
    )
    table.check(
      '?? <> ? OR ?? IS NOT NULL',
      ['outcome', 'failed', 'error_message'],
      'sync_runs_failed_has_error',
    )
    table.check(
      '?? >= 0 AND ?? >= 0 AND ?? >= 0',
      ['inserted_count', 'updated_count', 'pending_mirrored_count'],
      'sync_runs_counts_non_negative',
    )
  })
  await knex.raw(
    "CREATE UNIQUE INDEX sync_runs_one_running ON sync_runs (outcome) WHERE outcome = 'running'",
  )
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('sync_runs')
}

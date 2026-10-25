// prd-01 wave 1 (#19), Ruling 4: the history of who changed a transaction's
// effective category, from what, to what, and when. `source` is who made the
// change (`user`, `rule` or `claude`); Akahu's own category is never a
// correction, so `akahu` is refused, and there is no default so a writer has
// to say who it is.
//
// ON DELETE CASCADE, not RESTRICT. Sync replaces a pending row by deleting
// it and inserting a new one with a new id, so a correction on a pending row
// would point at nothing after the next sync. RESTRICT would make that
// delete fail and wedge every sync from the moment a pending row was
// touched. Category edit paths must refuse a row whose
// `status` is not `settled`, so a correction is only ever made on a row that
// stays.
//
// From here on, never rebuild `transactions` (knex `dropColumn`, `.alter()`,
// or anything that recreates the table): the rebuild runs inside the
// migration transaction, where PRAGMA foreign_keys = OFF is ignored, and
// this cascade would delete every correction. See the hazard in
// 20261023120000_money_as_cents.js.
//
// Rolling this migration back deletes every correction.
//
// `corrected_at` is an ISO-8601 UTC string ending in `Z`, written by the
// application; no `CURRENT_TIMESTAMP` default.

const CORRECTION_SOURCES = ['user', 'rule', 'claude']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('category_corrections', (table) => {
    table.increments('id').primary()
    table
      .integer('transaction_id')
      .notNullable()
      .references('id')
      .inTable('transactions')
      .onDelete('CASCADE')
    table.string('from_category')
    table.string('to_category').notNullable()
    table.timestamp('corrected_at').notNullable()
    table.enu('source', CORRECTION_SOURCES).notNullable()

    table.index(['transaction_id'])
  })
}

/**
 * Deletes every correction.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('category_corrections')
}

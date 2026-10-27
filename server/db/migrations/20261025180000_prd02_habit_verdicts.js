// prd-02 wave 3, issue #52 (Done-when 4): `habit_verdicts` holds Hannah's
// "worth it" tag on a transaction, as the Habits screen sets it through
// `PUT /api/v1/habits/verdicts/:transactionId`. One row per transaction.
//
// - `transaction_id` is `transactions.id`. The CHECK holds it to a positive
//   SQLite integer, so text, a real, zero or a negative id never lands.
// - `verdict` is `worth_it` or `not_really`. Clearing a verdict deletes the
//   row; NULL is never stored, so "no verdict" has one representation.
//
// Conventions, as in 20261025170000_subscription_marks.js:
// - No `user_id`: Divvy has one user.
// - Instants are ISO-8601 UTC strings ending in `Z`, written by the
//   application. There is no `CURRENT_TIMESTAMP` default.
//
// No foreign key to `transactions`, deliberately:
// - CASCADE or SET NULL would put this table among the children that the
//   rebuild-cascade guard (server/db/__tests__/migration-guards.test.ts)
//   pins; a later rebuild of `transactions` would delete or blank every
//   verdict silently.
// - NO ACTION (or RESTRICT) would make sync's delete-and-reinsert of the
//   pending mirror (`replacePending`, server/sync/upsert.ts;
//   docs/akahu-pending-semantics.md §2) throw the first time a pending row
//   had a verdict, and wedge every sync after it.
// - Without a key, nothing can be lost or wedged. A verdict is allowed only
//   on a settled row (the writer refuses a pending one, as category edits
//   do, docs/akahu-pending-semantics.md §5). Sync never changes or deletes a
//   settled row's id (prd-01 Ruling 1), and `transactions.id` is
//   AUTOINCREMENT, so an id is never reused for another transaction.
//
// No `scope` column. A verdict's scope is read by joining its transaction to
// that transaction's account, so it cannot drift from the transaction's own.
//
// Never rebuild `transactions` (see 20261024100004_category_corrections.js
// and the hazard in 20261023120000_money_as_cents.js). This migration does
// not touch it.
//
// Rolling back drops the table and every verdict in it.

const VERDICTS = ['worth_it', 'not_really']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('habit_verdicts', (table) => {
    table.increments('id').primary()
    table.integer('transaction_id').notNullable()
    table.enu('verdict', VERDICTS).notNullable()
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()

    table.unique(['transaction_id'], {
      indexName: 'habit_verdicts_transaction_id_unique',
    })
    table.check(
      "typeof(??) = 'integer' AND ?? > 0",
      ['transaction_id', 'transaction_id'],
      'habit_verdicts_transaction_id_positive_integer',
    )
  })
}

/**
 * Drops `habit_verdicts` and every verdict in it.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('habit_verdicts')
}

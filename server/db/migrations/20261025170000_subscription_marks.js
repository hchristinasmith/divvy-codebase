// prd-02 Ruling 14, issue #229: `subscription_marks` holds what Hannah has
// said about a merchant in one scope. Subscriptions themselves are not
// stored: `shared/subscriptions.ts` detects them on every read from settled
// Akahu transactions. Only her answer and her cancel date are stored, so
// both survive the next sync, which replaces pending rows with new ids.
//
// A row is one merchant in one scope, keyed by `(scope, merchant_key)`:
// - `merchant_key` is the key `merchantKeyOf` in shared/subscriptions.ts
//   builds: `m:<Akahu merchant_id>`, else `d:<normalised description>`. It is
//   a stored contract. Changing how the shared module builds keys orphans
//   every row here. The CHECK holds the same shape `isMerchantKey` checks:
//   3 to 255 characters starting `m:` or `d:`.
// - `answer` is `subscription` (she says it is one, whatever detection
//   says), `not_subscription` (she says it is not), or NULL (no answer;
//   detection and the name-hint question decide).
// - `cancelled_on` is the NZ calendar date she marked it cancelled, or NULL.
//   Cancel records a date and never acts: nothing is sent to the merchant or
//   the bank.
//
// Conventions, as in 20261025120000_prd02_budgets_bills_goals_roles_dismissals.js:
// - `scope` has no default, so a writer has to say. `all` is a view and is
//   never stored.
// - No `user_id`: Divvy has one user.
// - Calendar dates are `YYYY-MM-DD` text, checked with
//   `date(col, '+0 days') IS col`, which refuses an impossible day and lets
//   a nullable column hold NULL and nothing else that is not a real date.
// - Instants are ISO-8601 UTC strings ending in `Z`, written by the
//   application. There is no `CURRENT_TIMESTAMP` default.
//
// No foreign keys. A mark names a merchant, not a transaction row, so it
// references nothing, and nothing references it. That keeps it out of the
// rebuild-cascade hazard (migration-guards.test.ts) both ways.
//
// Never rebuild `transactions` (see 20261024100004_category_corrections.js
// and the hazard in 20261023120000_money_as_cents.js). This migration does
// not touch it.
//
// Rolling back drops the table and every answer and cancel date in it.

const SCOPES = ['personal', 'strawb']
const ANSWERS = ['subscription', 'not_subscription']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('subscription_marks', (table) => {
    table.increments('id').primary()
    table.enu('scope', SCOPES).notNullable()
    table.string('merchant_key', 255).notNullable()
    table.enu('answer', ANSWERS)
    table.text('cancelled_on')
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()

    table.unique(['scope', 'merchant_key'], {
      indexName: 'subscription_marks_scope_merchant_key_unique',
    })
    table.check(
      "length(??) BETWEEN 3 AND 255 AND substr(??, 1, 2) IN ('m:', 'd:')",
      ['merchant_key', 'merchant_key'],
      'subscription_marks_merchant_key_shape',
    )
    table.check(
      "date(??, '+0 days') IS ??",
      ['cancelled_on', 'cancelled_on'],
      'subscription_marks_cancelled_on_is_date',
    )
  })
}

/**
 * Drops `subscription_marks` and every row in it.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('subscription_marks')
}

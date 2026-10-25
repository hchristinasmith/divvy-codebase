// prd-01 wave 1 (#19), Rulings 8 and 9: the bank and ledger accounts Divvy
// mirrors, one row per account.
//
// `scope` (personal | strawb) and `source` (akahu | xero) are set by Hannah,
// never inferred from anything Akahu or Xero sends. The account upsert in
// sync must not write either column: an insert takes the defaults and every
// later update leaves them alone.
//
// `akahu_id` is Akahu's account `_id`. It is nullable because a Xero-sourced
// account (Ruling 9) has none; SQLite's UNIQUE allows any number of NULLs.
// The table CHECK makes an Akahu-sourced account carry one.
//
// `transactions.account_id` stays a bare string with no foreign key to this
// table: existing rows may name accounts that were never stored here, and
// adding a foreign key to `transactions` would need a table rebuild (see the
// hazard in 20261023120000_money_as_cents.js). The join is soft:
// `transactions.account_id = accounts.akahu_id`.
//
// Money is integer cents (M1 #8): `balance_cents` is Akahu's
// `balance.current`, `available_balance_cents` is `balance.available`, and
// `credit_limit_cents` is `balance.limit`. Akahu's open enums (`type`,
// `status`, `connection_type`) are stored as text with no CHECK, so a value
// Akahu adds later is kept rather than refused. `attributes` is Akahu's
// attribute array as JSON text.
//
// Instants are written by the application as ISO-8601 UTC strings ending in
// `Z`. There is no `CURRENT_TIMESTAMP` default: its format sorts differently
// from the ISO strings beside it.
//
// Never rebuild `accounts` in a later migration (knex `dropColumn`, `.alter()`,
// or anything that recreates the table). The rebuild runs inside the migration
// transaction, where PRAGMA foreign_keys = OFF is ignored, so it deletes every
// `account_settings` row (CASCADE) and clears every `bills.account_id`
// (SET NULL). The fuller note is in
// 20261025120000_prd02_budgets_bills_goals_roles_dismissals.js.
// `server/db/__tests__/migration-guards.test.ts` (#165) enforces the no-rebuild
// rule by test. Sync must update an account in place, keyed on `akahu_id`:
// #145 names `INSERT … ON CONFLICT(akahu_id) DO UPDATE`, and
// `server/sync/upsert.ts` reads, then updates or inserts, with the same effect.
// Never `INSERT OR REPLACE`, a delete and reinsert, or a delete of an account
// Akahu stops returning. `server/sync/__tests__/run.test.ts` (#145) enforces
// the upsert rule by test.

const SCOPES = ['personal', 'strawb']
const SOURCES = ['akahu', 'xero']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('accounts', (table) => {
    table.increments('id').primary()
    table.string('akahu_id').unique()
    table.enu('source', SOURCES).notNullable().defaultTo('akahu')
    table.enu('scope', SCOPES).notNullable().defaultTo('personal')
    table.string('name').notNullable()
    table.string('formatted_account')
    table.string('type')
    table.string('status')
    table.text('attributes').notNullable().defaultTo('[]')

    // Akahu's `connection` object, and the authorisation it belongs to.
    table.string('connection_id')
    table.string('connection_name')
    table.string('connection_type')
    table.string('connection_logo')
    table.string('authorisation_id')
    table.string('credentials_id')

    // Akahu's `balance` object. No invented currency default.
    table.string('currency')
    table.integer('balance_cents')
    table.integer('available_balance_cents')
    table.integer('credit_limit_cents')

    // Akahu's `refreshed` object.
    table.timestamp('refreshed_balance_at')
    table.timestamp('refreshed_meta_at')
    table.timestamp('refreshed_transactions_at')

    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()

    table.check(
      '?? <> ? OR ?? IS NOT NULL',
      ['source', 'akahu', 'akahu_id'],
      'accounts_akahu_has_akahu_id',
    )
  })
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('accounts')
}

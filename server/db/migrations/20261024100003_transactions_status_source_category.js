// prd-01 wave 1 (#19), Rulings 1, 4 and 9: a transaction's status, where it
// came from, and Akahu's category kept apart from the effective one.
//
// - `status` is `settled` or `pending` (Ruling 1). A pending item from
//   Akahu has no `_id` and no `hash`, so a pending row has NULL `akahu_id`
//   and `hash`; the existing nullable UNIQUE on `akahu_id` allows any number
//   of them. Pending rows are identified only as the set
//   (`account_id`, `status = 'pending'`) and are replaced wholesale on each
//   sync (docs/akahu-pending-semantics.md).
// - `source` is `akahu` or `xero` (Ruling 9).
// - `akahu_category_*` hold Akahu's category as received (Ruling 4), beside
//   the effective `category` and `category_source` that
//   20261023130000_transaction_effective_category.js added.
//
// Copy, not rename. The legacy `category_*` columns are copied into
// `akahu_category_*` and left in place, because the M1 code, the seed and
// `server/db/transactions.ts` still read them (#19 Done-when). Dropping them
// is a later wave's change.
//
// Defaults: every existing row came from Akahu and is settled, and SQLite
// can add a NOT NULL column only with a default, so `status` defaults to
// `settled` and `source` to `akahu`. The cost: an insert that forgets to set
// `status` becomes a settled row. Sync must set `status = 'pending'`
// explicitly on every pending insert, and a Xero importer must set
// `source = 'xero'` explicitly.
//
// No database rule says a settled row has an `akahu_id`: that CHECK would
// need a table rebuild. Sync holds it as an application invariant.
//
// Copied from 20261023120000_money_as_cents.js: knex rebuilds a SQLite
// table to drop or alter a column, and the rebuilt table starts a fresh
// AUTOINCREMENT counter. The rebuild runs inside knex's migration
// transaction, where PRAGMA foreign_keys = OFF is ignored, so rebuilding a
// table that other tables reference with ON DELETE CASCADE deletes their
// rows. Transactions gains exactly such a child in
// 20261024100004_category_corrections.js.
//
// So this migration never rebuilds `transactions`. `up` adds columns with
// native ADD COLUMN; `down` removes them with native ALTER TABLE ... DROP
// COLUMN (SQLite 3.35+), never knex's `dropColumn`, which rebuilds. Native
// DROP COLUMN refuses a column that an index names, so the index goes first.

const STATUSES = ['settled', 'pending']
const SOURCES = ['akahu', 'xero']

const INDEX = 'transactions_account_status_idx'

// Each new Akahu category column, paired with the legacy column it copies.
const AKAHU_CATEGORY = [
  ['akahu_category_id', 'category_id'],
  ['akahu_category_name', 'category_name'],
  ['akahu_category_group_id', 'category_group_id'],
  ['akahu_category_group_name', 'category_group_name'],
]

const NEW_COLUMNS = ['status', 'source', ...AKAHU_CATEGORY.map(([akahu]) => akahu)]

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.alterTable('transactions', (table) => {
    table.enu('status', STATUSES).notNullable().defaultTo('settled')
    table.enu('source', SOURCES).notNullable().defaultTo('akahu')
    for (const [akahu] of AKAHU_CATEGORY) table.string(akahu)
    table.index(['account_id', 'status'], INDEX)
  })

  await knex('transactions').update(
    Object.fromEntries(
      AKAHU_CATEGORY.map(([akahu, legacy]) => [akahu, knex.ref(legacy)]),
    ),
  )

  // A row whose category is still Akahu's to set, that has Akahu's category
  // name but no effective category, gets Akahu's name. Rows that already
  // have a category, and rows a user, rule or Claude owns, are left alone,
  // and so is `category_source`; running this twice changes nothing.
  await knex('transactions')
    .where({ category_source: 'akahu' })
    .whereNull('category')
    .whereNotNull('category_name')
    .update({ category: knex.ref('category_name') })
}

/**
 * Removes the new columns without rebuilding `transactions`, so the
 * AUTOINCREMENT counter and any child rows are untouched. Akahu's category
 * is still in the legacy `category_*` columns, so nothing Akahu sent is lost.
 * A category repaired by `up` stays repaired.
 *
 * Pending rows are deleted first: without `status` they would look settled,
 * with no `akahu_id`, and the M1 code would count them beside the settled
 * row they become. The next sync re-mirrors them. `category_corrections`
 * is already gone (its `down` runs first), so nothing cascades. A
 * `source = 'xero'` row would become indistinguishable from an Akahu one;
 * none exists yet.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex('transactions').where({ status: 'pending' }).del()
  await knex.raw('DROP INDEX ??', [INDEX])
  for (const column of NEW_COLUMNS) {
    await knex.raw('ALTER TABLE ?? DROP COLUMN ??', ['transactions', column])
  }
}

// prd-01 Ruling 4 ("every Akahu transaction is stored in full"), issue #191
// (spawned by #155): the two Akahu fields `transactions` had no column for.
//
// - `posted_date` is when the bank posted a settled transaction. Akahu sends
//   it on settled items only, so a pending row keeps NULL.
// - `merchant_nzbn` is the merchant's NZ Business Number, on settled and
//   pending rows alike.
//
// Both are nullable text with no default, no CHECK and no index: Akahu omits
// either freely, nothing queries by them yet, and sync must be able to write
// NULL when Akahu stops sending one (#155). `posted_date` is stored exactly as
// Akahu sends it, ISO-8601 UTC text like `date`, `created_at` and
// `updated_at` (20261024100001_accounts.js), not cut down to YYYY-MM-DD.
// Sync compares the stored text with the incoming text on every run, so a
// value stored in any other form than the one sync sends would read as a
// change on every run.
//
// No backfill. A row already stored has NULL in both until the next sync
// sees it, and sync writes them back as an ordinary change.
//
// Never rebuild `transactions` (see 20261024100004_category_corrections.js
// and the hazard in 20261023120000_money_as_cents.js): knex `dropColumn` and
// `.alter()` rebuild a SQLite table inside the migration transaction, where
// PRAGMA foreign_keys = OFF is ignored, and the rebuild cascades into
// `category_corrections` and deletes every correction. So `up` only adds
// columns (a native ADD COLUMN) and `down` uses native ALTER TABLE ... DROP
// COLUMN (SQLite 3.35+), never knex's `dropColumn`. Native DROP COLUMN
// refuses a column an index names, so if a later change indexes either
// column, `down` must drop that index first or it errors.
//
// Rolling back drops both columns and the values in them. The next sync
// writes them again for the rows Akahu returns; older rows stay NULL.
// Nothing else is touched: rows, ids, the AUTOINCREMENT counter and
// `category_corrections` are as they were.

const NEW_COLUMNS = ['posted_date', 'merchant_nzbn']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.alterTable('transactions', (table) => {
    for (const column of NEW_COLUMNS) table.text(column)
  })
}

/**
 * Drops the new columns with native DROP COLUMN, so `transactions` is not
 * rebuilt and `category_corrections` keeps every row.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  for (const column of NEW_COLUMNS) {
    await knex.raw('ALTER TABLE ?? DROP COLUMN ??', ['transactions', column])
  }
}

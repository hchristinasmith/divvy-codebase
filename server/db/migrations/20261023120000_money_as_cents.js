// M1 #8 (D12): money is integer cents. Replaces the float/decimal money
// columns with integer `*_cents` columns, backfilled from the old values,
// then drops the old columns so nothing can read dollars from the database.
//
// Backfill rounds in SQL (ROUND is half away from zero) on amounts that are
// already two-decimal dollars, so `ROUND(x * 100)` lands on the intended cent
// even where `x * 100` is a hair off in binary floating point.
//
// `conversion_amount` is included: it is a foreign-currency money amount
// stored as a float, and the issue's exit is "no float money columns".
// `conversion_rate` is a rate, not money, and stays a float.

// knex rebuilds a SQLite table to drop or alter a column, and the rebuilt
// table starts a fresh AUTOINCREMENT counter. Keep the old high-water mark so
// an id that was used and deleted is never handed out again.
//
// Hazard for later migrations: the rebuild runs inside knex's migration
// transaction, where PRAGMA foreign_keys = OFF is ignored, so rebuilding a
// table that other tables reference with ON DELETE CASCADE deletes their
// rows. Neither table rebuilt here has children; transactions will once
// prd-01 wave 1 adds category_corrections.
async function readSequence(knex, table) {
  const row = await knex('sqlite_sequence').where({ name: table }).first('seq')
  return row ? row.seq : null
}

async function restoreSequence(knex, table, seq) {
  if (seq === null) return
  await knex('sqlite_sequence')
    .where({ name: table })
    .update({ seq: knex.raw('max(seq, ?)', [seq]) })
}

const TRANSACTION_MONEY = [
  ['amount', 'amount_cents'],
  ['balance', 'balance_cents'],
  ['conversion_amount', 'conversion_amount_cents'],
]

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const transactionsSeq = await readSequence(knex, 'transactions')
  const targetsSeq = await readSequence(knex, 'targets')

  await knex.schema.alterTable('transactions', (table) => {
    for (const [, cents] of TRANSACTION_MONEY) table.integer(cents)
  })
  await knex('transactions').update(
    Object.fromEntries(
      TRANSACTION_MONEY.map(([dollars, cents]) => [
        cents,
        knex.raw('CAST(ROUND(?? * 100) AS INTEGER)', [dollars]),
      ]),
    ),
  )
  await knex.schema.alterTable('transactions', (table) => {
    for (const [dollars] of TRANSACTION_MONEY) table.dropColumn(dollars)
  })

  await knex.schema.alterTable('targets', (table) => {
    table.integer('target_amount_cents')
  })
  await knex('targets').update({
    target_amount_cents: knex.raw('CAST(ROUND(target_amount * 100) AS INTEGER)'),
  })
  await knex.schema.alterTable('targets', (table) => {
    table.dropColumn('target_amount')
  })
  await knex.schema.alterTable('targets', (table) => {
    table.integer('target_amount_cents').notNullable().alter()
  })

  await restoreSequence(knex, 'transactions', transactionsSeq)
  await restoreSequence(knex, 'targets', targetsSeq)
}

/**
 * Restores the dollar columns from cents. Lossless: every cent value maps to
 * exactly one two-decimal dollar value.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  const transactionsSeq = await readSequence(knex, 'transactions')
  const targetsSeq = await readSequence(knex, 'targets')

  await knex.schema.alterTable('transactions', (table) => {
    table.float('amount')
    table.float('balance')
    table.float('conversion_amount')
  })
  await knex('transactions').update(
    Object.fromEntries(
      TRANSACTION_MONEY.map(([dollars, cents]) => [
        dollars,
        knex.raw('?? / 100.0', [cents]),
      ]),
    ),
  )
  await knex.schema.alterTable('transactions', (table) => {
    for (const [, cents] of TRANSACTION_MONEY) table.dropColumn(cents)
  })

  await knex.schema.alterTable('targets', (table) => {
    table.decimal('target_amount', 14, 2)
  })
  await knex('targets').update({
    target_amount: knex.raw('target_amount_cents / 100.0'),
  })
  await knex.schema.alterTable('targets', (table) => {
    table.dropColumn('target_amount_cents')
  })
  await knex.schema.alterTable('targets', (table) => {
    table.decimal('target_amount', 14, 2).notNullable().alter()
  })

  await restoreSequence(knex, 'transactions', transactionsSeq)
  await restoreSequence(knex, 'targets', targetsSeq)
}

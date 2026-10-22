// M1 #9, prd-01 Ruling 4: Akahu's category and the user's are separate.
//
// The existing category_id / category_name / category_group_* columns hold
// what Akahu sent and stay untouched here (prd-01 wave 1 renames them to
// akahu_category_*). This adds the effective category, `category` (an NZFCC
// category name, as listed in data/cats.js), and `category_source`, which
// says who set it. A category edit writes `category` and
// `category_source = 'user'`; sync may write `category` only while
// `category_source = 'akahu'`.
//
// Backfill: every existing row came from Akahu (seed or dump), so its
// effective category is Akahu's category name and its source is 'akahu'.

const CATEGORY_SOURCES = ['akahu', 'user', 'rule', 'claude']

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.alterTable('transactions', (table) => {
    table.string('category')
    table
      .enu('category_source', CATEGORY_SOURCES)
      .notNullable()
      .defaultTo('akahu')
  })
  await knex('transactions').update({ category: knex.ref('category_name') })
}

/**
 * Drops the effective category. A user's corrections are lost on rollback;
 * Akahu's category columns were never touched, so they remain.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.alterTable('transactions', (table) => {
    table.dropColumn('category')
    table.dropColumn('category_source')
  })
}

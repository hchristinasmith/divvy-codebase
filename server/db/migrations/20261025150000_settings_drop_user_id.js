// issue 46, prd-02 Rulings 9 and 11: `settings` becomes the single user's
// key/value table the settings route reads and writes. It drops `user_id`
// and its foreign key to `users` (Divvy has one user and no `users` row in
// a fresh or production database, so no settings row could be written), and
// gains a UNIQUE `key`, so a write is an upsert on `key` and a read sees one
// value per setting.
//
// The new shape:
// - `id`: integer surrogate key.
// - `key`: NOT NULL, UNIQUE. A setting with no row takes its default from
//   `SETTINGS_DEFAULTS` in shared/contracts.ts.
// - `value`: text, NOT NULL. A missing row, not a NULL, means "the default".
// - `updated_at`: NOT NULL, no default; an ISO-8601 UTC string ending in `Z`,
//   written by the application. There is no `CURRENT_TIMESTAMP` default: its
//   format sorts differently from the ISO strings beside it.
//
// Existing rows are copied, not discarded:
// - `updated_at` becomes ISO: a number is epoch milliseconds (how the sqlite3
//   driver stores a JS Date, which the old dev seed wrote); a
//   `YYYY-MM-DD HH:MM:SS` string is the old `CURRENT_TIMESTAMP` default, in
//   UTC; any other parseable string is read as a date; anything else takes
//   this migration's own time.
// - A row whose `value` is NULL is skipped: no row means the default.
// - Where one key has several rows (the old table had no uniqueness, and one
//   row per user), the latest `updated_at` wins, then the later rowid.
// - Keys nothing reads yet (for example `dark_mode`) are kept.
//
// The table is copied into `settings_next`, the old one dropped and the copy
// renamed, rather than altered with `dropColumn` or `.alter()`. Nothing
// references `settings` with a foreign key, so dropping it deletes nothing
// elsewhere (the rebuild hazard in 20261023120000_money_as_cents.js is about
// a parent with children; `settings` has none). `users` is not touched.
//
// Rolling back recreates `settings` exactly as 20250619122207_settings.js
// created it, EMPTY: the old shape needs a `user_id` for every row, and there
// is no user to give them, so every settings row is lost on the way down.

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const now = new Date().toISOString()

  await knex.schema.createTable('settings_next', (table) => {
    table.increments('id').primary()
    table.string('key', 255).notNullable().unique()
    table.text('value').notNullable()
    table.timestamp('updated_at').notNullable()
  })

  const legacy = await knex.raw(
    'SELECT rowid AS legacy_rowid, key, value, updated_at FROM settings',
  )

  const latest = new Map()
  legacy
    .filter((row) => row.value !== null && row.value !== undefined)
    .map((row) => ({ ...row, updated_at: toIso(row.updated_at, now) }))
    .sort(
      (a, b) =>
        a.updated_at.localeCompare(b.updated_at) ||
        a.legacy_rowid - b.legacy_rowid,
    )
    .forEach((row) => latest.set(row.key, row))

  const rows = [...latest.values()].map((row) => ({
    key: row.key,
    value: String(row.value),
    updated_at: row.updated_at,
  }))
  if (rows.length > 0) await knex('settings_next').insert(rows)

  await knex.schema.dropTable('settings')
  await knex.schema.renameTable('settings_next', 'settings')
}

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// An old `updated_at` as an ISO-8601 UTC string, or `fallback`.
function toIso(value, fallback) {
  let ms = NaN
  if (typeof value === 'number') ms = value
  else if (typeof value === 'string' && SQLITE_DATETIME.test(value)) {
    ms = Date.parse(`${value.replace(' ', 'T')}Z`)
  } else if (typeof value === 'string') ms = Date.parse(value)
  if (!Number.isFinite(ms)) return fallback
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

/**
 * Recreates `settings` in its old shape, empty. Every settings row is lost.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('settings')

  // As 20250619122207_settings.js created it, so that migration's own down()
  // still runs after this one.
  await knex.schema.createTable('settings', (table) => {
    table.string('id').primary()
    table.integer('user_id').unsigned().notNullable()
    table.string('key', 255).notNullable()
    table.string('value', 1000)
    table.timestamp('updated_at').defaultTo(knex.fn.now())

    table.foreign('user_id').references('users.id').onDelete('CASCADE')
  })
}

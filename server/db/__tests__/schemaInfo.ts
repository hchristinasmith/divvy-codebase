// Test helper, not a test: reads a table's shape back from SQLite (PRAGMA
// table_info, sqlite_sequence, the row count) so the schema tests share one
// reading of each. Every helper takes the `db` it reads from.
import type { Knex } from 'knex'

// Column names of `table`, in declaration order.
export async function columns(db: Knex, table: string): Promise<string[]> {
  const info: { name: string }[] = await db.raw('PRAGMA table_info(??)', [
    table,
  ])
  return info.map((c) => c.name)
}

// `table`'s rowid high-water mark from sqlite_sequence; undefined if the table
// has never been written to.
export async function sequence(
  db: Knex,
  table: string,
): Promise<number | undefined> {
  const row = await db('sqlite_sequence').where({ name: table }).first('seq')
  return row?.seq
}

export async function count(db: Knex, table: string): Promise<number> {
  const row = await db(table).count('* as n').first()
  return Number(row?.n)
}

// The NOT NULL columns of `table`, bar the `id` primary key (a rowid alias,
// filled in when omitted), each with the default SQLite reports for it, or null
// when it has none.
export async function notNullColumns(
  db: Knex,
  table: string,
): Promise<{ name: string; dflt_value: string | null }[]> {
  const info: { name: string; notnull: number; dflt_value: string | null }[] =
    await db.raw('PRAGMA table_info(??)', [table])
  return info
    .filter((c) => c.notnull && c.name !== 'id')
    .map((c) => ({ name: c.name, dflt_value: c.dflt_value }))
}

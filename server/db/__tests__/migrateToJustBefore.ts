// Test helper, not a test: runs every migration before `file`, one step at a
// time, so a migration test can write rows in the schema that migration
// starts from and then step it up or down.
import { expect } from 'vitest'
import type { Knex } from 'knex'

export async function migrateToJustBefore(db: Knex, file: string) {
  const [, pending] = (await db.migrate.list()) as [unknown, { file: string }[]]
  const index = pending.findIndex((m) => m.file === file)
  expect(index, `${file} is not a pending migration`).toBeGreaterThan(0)
  for (let i = 0; i < index; i++) await db.migrate.up()
}

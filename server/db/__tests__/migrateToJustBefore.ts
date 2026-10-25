// Test helper, not a test: steps the migrations up one at a time to a named
// file, so a test can write rows in the schema a given migration starts from
// (`migrateToJustBefore`) or leaves (`migrateThrough`) and then step on.
import { expect } from 'vitest'
import type { Knex } from 'knex'

async function pendingIndex(db: Knex, file: string) {
  const [, pending] = (await db.migrate.list()) as [unknown, { file: string }[]]
  return { pending, index: pending.findIndex((m) => m.file === file) }
}

async function upTimes(db: Knex, steps: number) {
  for (let i = 0; i < steps; i++) await db.migrate.up()
}

// Runs every migration before `file`, so a migration test can write rows in
// the schema that migration starts from and then step it up or down.
export async function migrateToJustBefore(db: Knex, file: string) {
  const { index } = await pendingIndex(db, file)
  expect(index, `${file} is not a pending migration`).toBeGreaterThan(0)
  await upTimes(db, index)
}

// Runs every migration up to and including `file`, and checks at least one
// migration is left for `latest` to run, so a guard that seeds here and then
// runs `latest` is never vacuously green.
export async function migrateThrough(db: Knex, file: string) {
  const { pending, index } = await pendingIndex(db, file)
  expect(index, `${file} is not a pending migration`).toBeGreaterThanOrEqual(0)
  expect(pending.length - index - 1, `no migration runs after ${file}`).toBeGreaterThan(0)
  await upTimes(db, index + 1)
}

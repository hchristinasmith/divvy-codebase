// Test helper: the real Express app, backed by a freshly migrated in-memory
// SQLite database.
//
// The app reads its database through the module singleton in
// `server/db/connection.ts`, which picks its knexfile config from NODE_ENV.
// Under vitest that is `test`, whose connection is `:memory:`. vitest gives
// every test file its own module graph, so every test file gets its own
// database; `freshApp()` additionally rolls every migration back and
// re-applies them, so every call starts from an empty, fully migrated schema.
//
// Never point a test at a developer's real `.sqlite3` file (CLAUDE.md,
// Testing): `assertInMemory` refuses before anything is rolled back.
import type { Express } from 'express'
import type { Knex } from 'knex'

import server from '../server.ts'
import connection from '../db/connection.ts'

export function assertInMemory(db: Knex): void {
  const config = db.client.config as Knex.Config
  const target = config.connection
  const filename =
    target && typeof target === 'object' && 'filename' in target
      ? target.filename
      : undefined
  if (filename !== ':memory:') {
    throw new Error(
      `Refusing to run tests against ${JSON.stringify(filename ?? target)}: ` +
        `the test database must be ':memory:' (is NODE_ENV=${process.env.NODE_ENV}?)`,
    )
  }
}

export async function freshApp(): Promise<Express> {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  return server
}

export async function closeDb(): Promise<void> {
  await connection.destroy()
}

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
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'
import type { Knex } from 'knex'
import request from 'supertest'

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

export type LoopbackApi = {
  api: ReturnType<typeof request>
  // The socket the server bound; tests read it to pin the bind address and port.
  address: AddressInfo
  close(): Promise<void>
}

// One HTTP server per test, already listening on 127.0.0.1, with supertest
// bound to it. Given a bare Express app, supertest opens a fresh server for
// every request on all interfaces (`listen(0)`); another process can bind the
// more specific 127.0.0.1 on that same port, and the request then reaches a
// foreign server (socket hang up, or a status Divvy cannot produce; #97,
// #105). A server that is already listening is used as is.
//
// `close()` drops keep-alive sockets before closing, so the server never
// outlives its test, and does nothing if the server is not listening, so it
// is safe to call twice. This helper does not touch the database.
export async function serveOnLoopback(httpApp: Express): Promise<LoopbackApi> {
  const httpServer = createServer(httpApp)
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const address = httpServer.address()
  if (address === null || typeof address !== 'object') {
    throw new Error(`Expected a TCP address, got ${JSON.stringify(address)}`)
  }
  return {
    api: request(httpServer),
    address,
    async close() {
      if (!httpServer.listening) return
      httpServer.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}

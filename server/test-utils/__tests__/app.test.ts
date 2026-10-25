import { readdirSync } from 'node:fs'
import { Agent, get as httpGet } from 'node:http'
import { connect } from 'node:net'
import * as Path from 'node:path'
import * as URL from 'node:url'
import express from 'express'
import knex from 'knex'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import connection from '../../db/connection.ts'
import {
  assertInMemory,
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../app.ts'

const __dirname = Path.dirname(URL.fileURLToPath(import.meta.url))
const migrationsDir = Path.join(__dirname, '../../db/migrations')

afterAll(closeDb)

describe('freshApp', () => {
  it('applies every migration in server/db/migrations', async () => {
    await freshApp()

    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.js'))
    const [completed, pending] = await connection.migrate.list()

    expect(pending).toHaveLength(0)
    expect(
      completed.map((m: { name: string }) => m.name).sort(),
    ).toEqual(files.sort())
  })

  it('starts every call from an empty database', async () => {
    // Setup needs a migrated schema, not a full rollback: only the later
    // freshApp() call is under test. Rolling everything back in setup as
    // well made this test the slowest in the file, and it timed out under
    // load, where every SQLite query waits on a shared thread pool (#368,
    // #367).
    // latest() does nothing once an earlier test has migrated, and migrates
    // from scratch when this test runs alone. The guard comes first, as in
    // freshApp(), so setup never writes to a database on disk.
    assertInMemory(connection)
    await connection.migrate.latest()
    await connection('transactions').insert({ description: 'left over' })
    expect(await connection('transactions').count({ n: '*' })).toEqual([
      { n: 1 },
    ])

    await freshApp()

    expect(await connection('transactions').count({ n: '*' })).toEqual([
      { n: 0 },
    ])
  })

  it('empties a database whose migrations span two batches, not only the last', async () => {
    // The row goes in `transactions`, which the first migration creates, so
    // it sits in batch 1. Rolling back only the last batch would keep it.
    // Setup stays cheap (#368): latest() migrates from scratch only when this
    // test runs alone. down({ name }) then rolls back just the last migration,
    // and up() re-applies it as a batch of its own, so the rest stay in batch 1.
    // The guard comes first, as in freshApp(), so setup never writes to a
    // database on disk.
    assertInMemory(connection)
    await connection.migrate.latest()
    const [completed] = await connection.migrate.list()
    const names = completed.map((m: { name: string }) => m.name).sort()
    await connection.migrate.down({ name: names[names.length - 1] })
    await connection.migrate.up()
    const batches = new Set(
      (await connection('knex_migrations').select('batch')).map(
        (row: { batch: number }) => row.batch,
      ),
    )
    expect(batches.size).toBe(2)
    await connection('transactions').insert({ description: 'left over' })
    expect(await connection('transactions').count({ n: '*' })).toEqual([
      { n: 1 },
    ])

    await freshApp()

    expect(await connection('transactions').count({ n: '*' })).toEqual([
      { n: 0 },
    ])
    const [, pending] = await connection.migrate.list()
    expect(pending).toHaveLength(0)
  })
})

describe('assertInMemory', () => {
  it('accepts the connection the tests run on', () => {
    expect(() => assertInMemory(connection)).not.toThrow()
  })

  it('refuses a database backed by a file', async () => {
    // knex connects lazily, so no file is created by building this instance.
    const onDisk = knex({
      client: 'sqlite3',
      useNullAsDefault: true,
      connection: { filename: './dev.sqlite3' },
    })
    try {
      expect(() => assertInMemory(onDisk)).toThrow(
        /Refusing to run tests against "\.\/dev\.sqlite3"/,
      )
    } finally {
      await onDisk.destroy()
    }
  })
})

// Opens a TCP connection and drops it again; rejects with the socket error
// (e.g. ECONNREFUSED when nothing listens on that port).
function connectTo(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
  })
}

describe('serveOnLoopback', () => {
  // A failing assertion must not leak a listening server into later tests.
  // close() is idempotent, so closing an already-closed server here is fine.
  let served: LoopbackApi | undefined
  afterEach(async () => {
    await served?.close()
    served = undefined
  })

  it('binds the server to 127.0.0.1 over IPv4', async () => {
    served = await serveOnLoopback(express())

    expect(served.address.address).toBe('127.0.0.1')
    expect(served.address.family).toBe('IPv4')
  })

  it('close() stops the server, so the bound port refuses connections', async () => {
    served = await serveOnLoopback(express())
    const { port } = served.address

    await served.close()

    await expect(connectTo('127.0.0.1', port)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
  })

  it('close() called twice resolves both times', async () => {
    served = await serveOnLoopback(express())

    await served.close()

    await expect(served.close()).resolves.toBeUndefined()
  })

  // Node >= 19 already drops idle keep-alive sockets on close(), so only a
  // request still in flight shows whether closeAllConnections() is called.
  it('close() ends a request in flight, so the client sees its socket close', async () => {
    // The route takes the request and never answers it.
    let onReceived: () => void = () => {}
    const received = new Promise<void>((resolve) => {
      onReceived = resolve
    })
    const app = express()
    app.get('/never-answered', () => {
      onReceived()
    })
    served = await serveOnLoopback(app)
    const agent = new Agent({ keepAlive: true })
    const req = httpGet({
      host: '127.0.0.1',
      port: served.address.port,
      path: '/never-answered',
      agent,
    })
    // Settles with the error the client sees once the server drops the socket.
    const clientError = new Promise<NodeJS.ErrnoException>((resolve) => {
      req.on('error', (err: NodeJS.ErrnoException) => resolve(err))
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await received
      const closing = served.close()
      const timedOut = new Promise<'still open'>((resolve) => {
        deadline = setTimeout(() => resolve('still open'), 1000)
      })
      const outcome = await Promise.race([
        closing.then(() => 'closed' as const),
        timedOut,
      ])
      expect(outcome, 'close() waited on the request in flight').toBe('closed')
      expect((await clientError).code).toBe('ECONNRESET')
    } finally {
      // Destroying the client lets a close() that is still waiting finish,
      // so a failing run leaves no open server or timer behind.
      clearTimeout(deadline)
      req.destroy()
      agent.destroy()
    }
  })
})

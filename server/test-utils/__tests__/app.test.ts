import { readdirSync } from 'node:fs'
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
    await freshApp()
    await connection('transactions').insert({ description: 'left over' })
    expect(await connection('transactions').count({ n: '*' })).toEqual([
      { n: 1 },
    ])

    await freshApp()

    expect(await connection('transactions').count({ n: '*' })).toEqual([
      { n: 0 },
    ])
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
})

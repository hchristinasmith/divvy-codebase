import { readdirSync } from 'node:fs'
import * as Path from 'node:path'
import * as URL from 'node:url'
import knex from 'knex'
import { afterAll, describe, expect, it } from 'vitest'

import connection from '../../db/connection.ts'
import { assertInMemory, closeDb, freshApp } from '../app.ts'

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

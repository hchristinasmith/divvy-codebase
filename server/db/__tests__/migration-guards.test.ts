// #134: no migration after 20261024100004_category_corrections.js may
// rebuild `transactions`. knex rebuilds a SQLite table to drop or alter a
// column (`dropColumn`, `.alter()`), and the rebuild runs inside knex's
// migration transaction, where PRAGMA foreign_keys = OFF is ignored, so the
// ON DELETE CASCADE on `category_corrections.transaction_id` deletes every
// correction. `migrate:latest` runs on every boot with no backup before it,
// so the loss would be silent. See the hazard notes in
// 20261023120000_money_as_cents.js and 20261024100004_category_corrections.js.
//
// The guard seeds a correction in the schema 100004 leaves and runs every
// later migration over it, so it also covers migrations not written yet. The
// canary runs the same flow with one extra in-test migration that rebuilds
// `transactions`, and expects the guard's own check to fail: proof that the
// hazard is real on this knex and that the guard can go red.
import { readdirSync } from 'node:fs'
import * as Path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../knexfile.js'

const CORRECTIONS = '20261024100004_category_corrections.js'
const AT = '2026-10-25T03:00:00.000Z'

type Row = Record<string, unknown>

// What a later migration must leave exactly as it found it. The correction
// rows are compared whole, so a column added to or dropped from
// `category_corrections` also fails here; if that was deliberate, this test
// is the place to say so.
type Survivors = {
  corrections: Row[]
  transactionIds: number[]
  transactionsSequence: number | undefined
}

let db: Knex | undefined

afterEach(async () => {
  await db?.destroy()
  db = undefined
})

// Applies every migration up to and including CORRECTIONS, one step at a
// time, and checks at least one migration is left for `latest` to run, so
// the guard is never vacuously green.
async function migrateThroughCorrections(db: Knex) {
  const [, pending] = (await db.migrate.list()) as [unknown, { file: string }[]]
  const index = pending.findIndex((m) => m.file === CORRECTIONS)
  expect(index, `${CORRECTIONS} is not a pending migration`).toBeGreaterThanOrEqual(0)
  expect(pending.length - index - 1, `no migration runs after ${CORRECTIONS}`).toBeGreaterThan(0)
  for (let i = 0; i <= index; i++) await db.migrate.up()
}

async function survivors(db: Knex, transactionId: number): Promise<Survivors> {
  const seq = await db('sqlite_sequence').where({ name: 'transactions' }).first('seq')
  return {
    corrections: await db('category_corrections').orderBy('id'),
    transactionIds: await db('transactions').where({ id: transactionId }).pluck('id'),
    transactionsSequence: seq?.seq,
  }
}

// A transaction with a user correction on it, plus a later transaction that
// was inserted and deleted, so the AUTOINCREMENT high-water mark sits above
// every live id. A rebuild copies the live rows into a new table, whose
// counter then restarts at the highest live id.
async function seed(db: Knex): Promise<{ transactionId: number; before: Survivors }> {
  const [transactionId] = await db('transactions').insert({
    akahu_id: 'trans_fixture_corrected',
    account_id: 'acc_fixture_everyday',
    amount_cents: -450,
  })
  const [deletedId] = await db('transactions').insert({
    akahu_id: 'trans_fixture_deleted',
    account_id: 'acc_fixture_everyday',
    amount_cents: -100,
  })
  await db('transactions').where({ id: deletedId }).delete()
  await db('category_corrections').insert({
    transaction_id: transactionId,
    from_category: null,
    to_category: 'Bakeries',
    corrected_at: AT,
    source: 'user',
  })

  const before = await survivors(db, transactionId)
  // The seed itself, so a guard over an empty table cannot pass.
  expect(before.corrections).toHaveLength(1)
  expect(before.corrections[0]).toMatchObject({ transaction_id: transactionId, source: 'user' })
  expect(before.transactionIds).toEqual([transactionId])
  expect(before.transactionsSequence).toBe(deletedId)
  return { transactionId, before }
}

// The guard's check, shared with the canary so the canary exercises it
// rather than a copy.
async function expectSurvivedLatest(db: Knex, transactionId: number, before: Survivors) {
  expect(
    await survivors(db, transactionId),
    'category corrections, their transaction and its id counter after migrate:latest',
  ).toStrictEqual(before)
}

// Every real migration, by file name as knex's directory source orders
// them, then one that rebuilds `transactions` the way a careless later
// migration would. Nothing is written to server/db/migrations/.
const MIGRATIONS = config.test.migrations.directory
const REBUILD = '99999999999999_canary_rebuild_transactions.js'
const rebuildTransactions: Knex.Migration = {
  up: (knex) =>
    knex.schema.alterTable('transactions', (table) => {
      table.dropColumn('logo')
    }),
  down: (knex) =>
    knex.schema.alterTable('transactions', (table) => {
      table.string('logo')
    }),
}
const withRebuild: Knex.MigrationSource<{ file: string }> = {
  async getMigrations() {
    const real = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith('.js'))
      .sort()
    return [...real, REBUILD].map((file) => ({ file }))
  },
  getMigrationName: (migration) => migration.file,
  async getMigration(migration) {
    if (migration.file === REBUILD) return rebuildTransactions
    return (await import(Path.join(MIGRATIONS, migration.file))) as Knex.Migration
  },
}

describe('migrations after category_corrections (#134)', () => {
  it('leave every category correction, its transaction and the transactions id counter untouched', async () => {
    db = knex(config.test)
    await migrateThroughCorrections(db)
    const { transactionId, before } = await seed(db)

    await db.migrate.latest()

    await expectSurvivedLatest(db, transactionId, before)
  })

  it('canary: a migration that rebuilds transactions cascades the corrections away, and the guard catches it', async () => {
    db = knex({ ...config.test, migrations: { migrationSource: withRebuild } })
    await migrateThroughCorrections(db)
    const { transactionId, before } = await seed(db)

    await db.migrate.latest()

    // The reason the guard goes red: the rebuild kept the transaction but
    // the cascade took its correction.
    expect(await db('transactions').where({ id: transactionId }).pluck('id')).toEqual([
      transactionId,
    ])
    expect(await db('category_corrections').count('* as n').first()).toEqual({ n: 0 })
    await expect(expectSurvivedLatest(db, transactionId, before)).rejects.toThrow(
      'category corrections, their transaction and its id counter after migrate:latest',
    )
  })
})

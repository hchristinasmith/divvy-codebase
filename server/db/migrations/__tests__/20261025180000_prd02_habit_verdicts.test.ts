// Issue #52 (prd-02 Done-when 4): `habit_verdicts`, Hannah's "worth it" tag
// per transaction. Pins the table's columns and constraints, that it has no
// foreign key (so sync's delete of the pending mirror can never throw on a
// verdict), and that creating and dropping it never touches `transactions`
// or `category_corrections`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../knexfile.js'
import { migrateToJustBefore } from '../../__tests__/migrateToJustBefore.ts'
import {
  columns,
  count,
  notNullColumns,
  sequence,
} from '../../__tests__/schemaInfo.ts'

const MIGRATION = '20261025180000_prd02_habit_verdicts.js'
const TABLE = 'habit_verdicts'
const COLUMNS = [
  'id',
  'transaction_id',
  'verdict',
  'created_at',
  'updated_at',
]
const AT = '2026-10-25T05:00:00.000Z'

type Row = Record<string, unknown>

let db: Knex

let settledId: number
let transactionsBefore: Row[]
let correctionsBefore: Row[]
let sequenceBefore: number | undefined
let rootpageBefore: number

async function rootpage(): Promise<number> {
  const row = await db('sqlite_master')
    .where({ type: 'table', name: 'transactions' })
    .first('rootpage')
  return row.rootpage
}

async function tableExists(): Promise<boolean> {
  const row = await db('sqlite_master')
    .where({ type: 'table', name: TABLE })
    .first('name')
  return row !== undefined
}

const verdict = (fields: Row = {}): Row => ({
  transaction_id: settledId,
  verdict: 'worth_it',
  created_at: AT,
  updated_at: AT,
  ...fields,
})

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, MIGRATION)

  // One insert per row: a multi-row insert binds NULL for a key a row leaves
  // out, which would skip the column defaults.
  for (const row of [
    {
      akahu_id: 'trans_fixture_52_a',
      account_id: 'acc_fixture_52',
      amount_cents: -2350,
      date: '2026-10-20T00:00:00.000Z',
      description: 'EXAMPLE BOOKSHOP',
    },
    { akahu_id: 'trans_fixture_52_discarded', amount_cents: 1 },
  ]) {
    await db('transactions').insert(row)
  }
  // Leave the AUTOINCREMENT high-water mark above max(id), so a rebuild,
  // which resets it to max(id), is visible.
  await db('transactions')
    .where({ akahu_id: 'trans_fixture_52_discarded' })
    .del()
  const { id } = await db('transactions')
    .where({ akahu_id: 'trans_fixture_52_a' })
    .first('id')
  settledId = id
  await db('category_corrections').insert({
    transaction_id: settledId,
    from_category: null,
    to_category: 'Books',
    corrected_at: AT,
    source: 'user',
  })

  transactionsBefore = await db('transactions').orderBy('id')
  correctionsBefore = await db('category_corrections').orderBy('id')
  sequenceBefore = await sequence(db, 'transactions')
  rootpageBefore = await rootpage()
})

afterEach(async () => {
  await db.destroy()
})

describe(MIGRATION, () => {
  it('seeds a counter above max(id) and a correction to lose', () => {
    expect(sequenceBefore).toBeGreaterThan(
      Math.max(...transactionsBefore.map((r) => Number(r.id))),
    )
    expect(correctionsBefore).toHaveLength(1)
  })

  it('creates habit_verdicts with exactly its columns, every one NOT NULL with no default', async () => {
    expect(await tableExists()).toBe(false)

    await db.migrate.up()

    expect((await columns(db, TABLE)).sort()).toStrictEqual(
      [...COLUMNS].sort(),
    )
    expect(await notNullColumns(db, TABLE)).toStrictEqual([
      { name: 'transaction_id', dflt_value: null },
      { name: 'verdict', dflt_value: null },
      { name: 'created_at', dflt_value: null },
      { name: 'updated_at', dflt_value: null },
    ])
  })

  it('accepts each verdict and reads a row back with exactly its columns', async () => {
    await db.migrate.up()

    await db(TABLE).insert(verdict())
    await db(TABLE).insert(
      verdict({ transaction_id: settledId + 100, verdict: 'not_really' }),
    )

    const rows: Row[] = await db(TABLE).orderBy('id')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toStrictEqual([...COLUMNS].sort())
    }
    expect(rows.map((r) => [r.transaction_id, r.verdict])).toStrictEqual([
      [settledId, 'worth_it'],
      [settledId + 100, 'not_really'],
    ])
  })

  it('refuses a NULL transaction_id, verdict, created_at or updated_at', async () => {
    await db.migrate.up()

    for (const column of [
      'transaction_id',
      'verdict',
      'created_at',
      'updated_at',
    ]) {
      await expect(
        db(TABLE).insert(verdict({ [column]: null })),
        column,
      ).rejects.toThrow(
        new RegExp(`NOT NULL constraint failed: ${TABLE}.${column}`),
      )
    }
    expect(await count(db, TABLE)).toBe(0)
  })

  it('refuses a verdict that is not worth_it or not_really', async () => {
    await db.migrate.up()

    for (const v of ['maybe', 'Worth_it', 'worth it', '']) {
      await expect(
        db(TABLE).insert(verdict({ verdict: v })),
        v,
      ).rejects.toThrow(/CHECK constraint failed: verdict/)
    }
    expect(await count(db, TABLE)).toBe(0)
  })

  it.each([[0], [-1], ['abc'], [1.5]])(
    'refuses transaction_id %j',
    async (transaction_id) => {
      await db.migrate.up()

      await expect(
        db(TABLE).insert(verdict({ transaction_id })),
      ).rejects.toThrow(
        /CHECK constraint failed: habit_verdicts_transaction_id_positive_integer/,
      )
      expect(await count(db, TABLE)).toBe(0)
    },
  )

  it('holds one row per transaction', async () => {
    await db.migrate.up()

    await db(TABLE).insert(verdict())
    await expect(
      db(TABLE).insert(verdict({ verdict: 'not_really' })),
    ).rejects.toThrow(
      /UNIQUE constraint failed: habit_verdicts.transaction_id/,
    )

    expect(await db(TABLE).pluck('verdict')).toStrictEqual(['worth_it'])
  })

  it('references no table and no table references it', async () => {
    await db.migrate.up()

    expect(await db.raw('PRAGMA foreign_key_list(??)', [TABLE])).toStrictEqual(
      [],
    )
    const tables: string[] = await db('sqlite_master')
      .where({ type: 'table' })
      .pluck('name')
    for (const table of tables) {
      const keys: { table: string }[] = await db.raw(
        'PRAGMA foreign_key_list(??)',
        [table],
      )
      expect(
        keys.filter((k) => k.table === TABLE),
        `${table} references ${TABLE}`,
      ).toStrictEqual([])
    }
  })

  it("lets sync delete a pending row that has a verdict, and keeps the verdict's row", async () => {
    await db.migrate.up()

    await db('transactions').insert({
      account_id: 'acc_fixture_52',
      amount_cents: -880,
      status: 'pending',
      source: 'akahu',
    })
    const { id: pendingId } = await db('transactions')
      .where({ status: 'pending' })
      .first('id')
    await db(TABLE).insert(verdict({ transaction_id: pendingId }))

    // What `replacePending` in server/sync/upsert.ts does, with
    // foreign_keys ON (knexfile.js).
    await db('transactions').where({ status: 'pending', source: 'akahu' }).del()

    expect(await db(TABLE).pluck('transaction_id')).toStrictEqual([pendingId])
  })

  it('does not rebuild transactions or touch category_corrections, up or down', async () => {
    await db.migrate.up()

    expect(await db('transactions').orderBy('id')).toStrictEqual(
      transactionsBefore,
    )
    expect(await db('category_corrections').orderBy('id')).toStrictEqual(
      correctionsBefore,
    )
    expect(await sequence(db, 'transactions')).toBe(sequenceBefore)
    expect(await rootpage()).toBe(rootpageBefore)

    await db(TABLE).insert(verdict())
    await db.migrate.down()

    expect(await tableExists()).toBe(false)
    expect(await db('transactions').orderBy('id')).toStrictEqual(
      transactionsBefore,
    )
    expect(await db('category_corrections').orderBy('id')).toStrictEqual(
      correctionsBefore,
    )
    expect(await sequence(db, 'transactions')).toBe(sequenceBefore)
    expect(await rootpage()).toBe(rootpageBefore)
  })

  it('runs up, down and up again, and the second up starts empty', async () => {
    await db.migrate.up()
    await db(TABLE).insert(verdict())
    await db.migrate.down()
    await db.migrate.up()

    expect((await columns(db, TABLE)).sort()).toStrictEqual(
      [...COLUMNS].sort(),
    )
    expect(await count(db, TABLE)).toBe(0)
    expect(await db('category_corrections').orderBy('id')).toStrictEqual(
      correctionsBefore,
    )
  })
})

// Issue #229 (prd-02 Ruling 14): `subscription_marks`, Hannah's answer and
// cancel date per scope and merchant key. Pins the table's columns and
// constraints, that it references nothing, and that creating and dropping
// it never touches `transactions` or `category_corrections`. The row type
// is pinned to these columns in server/db/__tests__/subscriptions.test.ts.
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

const MIGRATION = '20261025170000_subscription_marks.js'
const TABLE = 'subscription_marks'
const COLUMNS = [
  'id',
  'scope',
  'merchant_key',
  'answer',
  'cancelled_on',
  'created_at',
  'updated_at',
]
const AT = '2026-10-25T03:00:00.000Z'

// As in server/db/__tests__/prd02-tables.test.ts.
const NOT_DATES: unknown[] = [
  '2026-02-29',
  '2026-02-30',
  '2026-13-01',
  '2026-2-3',
  20261025,
  '',
  'bogus',
  '2026-10-25 ',
  '2026-10-25T03:00:00Z',
]
const REAL_DATES = ['2026-10-25', '2028-02-29']

type Row = Record<string, unknown>

let db: Knex

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

const mark = (fields: Row = {}): Row => ({
  scope: 'personal',
  merchant_key: 'm:merchant_fixture_1',
  answer: null,
  cancelled_on: null,
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
      akahu_id: 'trans_fixture_229_a',
      account_id: 'acc_fixture_229',
      amount_cents: -1599,
      date: '2026-10-01T00:00:00.000Z',
      description: 'EXAMPLE STREAMING',
      merchant_id: 'merchant_fixture_1',
    },
    { akahu_id: 'trans_fixture_229_discarded', amount_cents: 1 },
  ]) {
    await db('transactions').insert(row)
  }
  // Leave the AUTOINCREMENT high-water mark above max(id), so a rebuild,
  // which resets it to max(id), is visible.
  await db('transactions')
    .where({ akahu_id: 'trans_fixture_229_discarded' })
    .del()
  const { id: firstId } = await db('transactions')
    .where({ akahu_id: 'trans_fixture_229_a' })
    .first('id')
  await db('category_corrections').insert({
    transaction_id: firstId,
    from_category: null,
    to_category: 'Entertainment',
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

  it('creates subscription_marks with exactly its columns', async () => {
    expect(await tableExists()).toBe(false)

    await db.migrate.up()

    expect(await columns(db, TABLE)).toEqual(COLUMNS)
    expect(await notNullColumns(db, TABLE)).toStrictEqual([
      { name: 'scope', dflt_value: null },
      { name: 'merchant_key', dflt_value: null },
      { name: 'created_at', dflt_value: null },
      { name: 'updated_at', dflt_value: null },
    ])
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

  it('accepts a full row, NULL answer and NULL cancelled_on, and real dates', async () => {
    await db.migrate.up()

    await db(TABLE).insert(mark())
    await db(TABLE).insert(
      mark({ merchant_key: 'd:example streaming', answer: 'subscription' }),
    )
    await db(TABLE).insert(
      mark({
        merchant_key: 'm:merchant_fixture_2',
        answer: 'not_subscription',
      }),
    )
    for (const [i, cancelled_on] of REAL_DATES.entries()) {
      await db(TABLE).insert(
        mark({ merchant_key: `m:dated_${i}`, cancelled_on }),
      )
    }
    await db(TABLE).insert(mark({ merchant_key: `m:${'x'.repeat(253)}` }))

    expect(await count(db, TABLE)).toBe(3 + REAL_DATES.length + 1)
    expect(
      await db(TABLE)
        .whereNotNull('cancelled_on')
        .orderBy('id')
        .pluck('cancelled_on'),
    ).toStrictEqual(REAL_DATES)
  })

  it.each([['all'], ['family'], ['']])('refuses scope %j', async (scope) => {
    await db.migrate.up()

    await expect(db(TABLE).insert(mark({ scope }))).rejects.toThrow(
      /CHECK constraint failed: scope/,
    )
    expect(await count(db, TABLE)).toBe(0)
  })

  it('refuses a NULL scope, merchant_key, created_at or updated_at', async () => {
    await db.migrate.up()

    for (const column of [
      'scope',
      'merchant_key',
      'created_at',
      'updated_at',
    ]) {
      await expect(
        db(TABLE).insert(mark({ [column]: null })),
        column,
      ).rejects.toThrow(
        new RegExp(`NOT NULL constraint failed: ${TABLE}.${column}`),
      )
    }
    expect(await count(db, TABLE)).toBe(0)
  })

  it('refuses an answer that is not subscription or not_subscription', async () => {
    await db.migrate.up()

    for (const answer of ['maybe', 'Subscription', '']) {
      await expect(db(TABLE).insert(mark({ answer })), answer).rejects.toThrow(
        /CHECK constraint failed: answer/,
      )
    }
    expect(await count(db, TABLE)).toBe(0)
  })

  it('refuses a cancelled_on that is not a real YYYY-MM-DD date', async () => {
    await db.migrate.up()

    for (const cancelled_on of NOT_DATES) {
      await expect(
        db(TABLE).insert(mark({ cancelled_on })),
        String(cancelled_on),
      ).rejects.toThrow(
        /CHECK constraint failed: subscription_marks_cancelled_on_is_date/,
      )
    }
    expect(await count(db, TABLE)).toBe(0)
  })

  it('refuses a merchant key that is not 3 to 255 characters starting m: or d:', async () => {
    await db.migrate.up()

    for (const merchant_key of [
      '',
      'm:',
      'd:',
      'x:abc',
      'abc',
      'M:abc',
      `m:${'x'.repeat(254)}`,
    ]) {
      await expect(
        db(TABLE).insert(mark({ merchant_key })),
        merchant_key.slice(0, 12),
      ).rejects.toThrow(
        /CHECK constraint failed: subscription_marks_merchant_key_shape/,
      )
    }
    expect(await count(db, TABLE)).toBe(0)
  })

  it('holds one row per scope and merchant key; the other scope is a separate row', async () => {
    await db.migrate.up()

    await db(TABLE).insert(mark())
    await expect(
      db(TABLE).insert(mark({ answer: 'subscription' })),
    ).rejects.toThrow(
      /UNIQUE constraint failed: subscription_marks.scope, subscription_marks.merchant_key/,
    )
    await db(TABLE).insert(mark({ scope: 'strawb' }))

    expect(await db(TABLE).orderBy('id').pluck('scope')).toStrictEqual([
      'personal',
      'strawb',
    ])
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

    await db(TABLE).insert(mark())
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
    await db(TABLE).insert(mark())
    await db.migrate.down()
    await db.migrate.up()

    expect(await columns(db, TABLE)).toEqual(COLUMNS)
    expect(await count(db, TABLE)).toBe(0)
    expect(await db('category_corrections').orderBy('id')).toStrictEqual(
      correctionsBefore,
    )
  })
})

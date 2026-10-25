// Issue #191 (prd-01 Ruling 4): `transactions.posted_date` and
// `transactions.merchant_nzbn`. The migration only adds and drops columns
// natively, so these tests pin that it never rebuilds `transactions`: a
// rebuild would reset the AUTOINCREMENT counter, move the table to a new
// root page and cascade into `category_corrections`. The index check only
// catches a hand-written rebuild that forgets the index: knex's rebuild
// recreates it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../knexfile.js'
import { migrateToJustBefore } from '../../__tests__/migrateToJustBefore.ts'
import { columns, count, sequence } from '../../__tests__/schemaInfo.ts'

const MIGRATION = '20261025140000_transactions_posted_date_nzbn.js'
const NEW_COLUMNS = ['posted_date', 'merchant_nzbn']
const INDEX = 'transactions_account_status_idx'
const AT = '2026-10-25T03:00:00.000Z'

type Row = Record<string, unknown>

let db: Knex

// The pre-migration state, recorded in beforeEach.
let transactionsBefore: Row[]
let correctionsBefore: Row[]
let accountSettingsBefore: Row[]
let billsBefore: Row[]
let columnsBefore: string[]
let sequenceBefore: number | undefined
let rootpageBefore: number

async function rootpage(): Promise<number> {
  const row = await db('sqlite_master')
    .where({ type: 'table', name: 'transactions' })
    .first('rootpage')
  return row.rootpage
}

async function indexNames(): Promise<string[]> {
  return db('sqlite_master')
    .where({ type: 'index', tbl_name: 'transactions' })
    .pluck('name')
}

async function columnInfo(
  names: string[],
): Promise<{ name: string; type: string; notnull: number; dflt_value: unknown }[]> {
  const info: { name: string; type: string; notnull: number; dflt_value: unknown }[] =
    await db.raw('PRAGMA table_info(??)', ['transactions'])
  return info
    .filter((c) => names.includes(c.name))
    .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }))
}

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, MIGRATION)

  // One insert per row: a multi-row insert binds NULL for a key a row leaves
  // out, which would skip the column defaults.
  for (const row of [
    {
      akahu_id: 'trans_fixture_191_a',
      account_id: 'acc_fixture_191',
      amount_cents: -450,
      date: '2026-10-22T00:00:00.000Z',
      description: 'EXAMPLE BAKERY',
      category: 'Bakeries',
      category_source: 'user',
    },
    {
      akahu_id: 'trans_fixture_191_b',
      account_id: 'acc_fixture_191',
      amount_cents: 250000,
      date: '2026-10-22T00:00:00.000Z',
      description: 'EXAMPLE PAYROLL',
    },
    { akahu_id: 'trans_fixture_191_discarded', amount_cents: 1 },
  ]) {
    await db('transactions').insert(row)
  }
  // Leave the AUTOINCREMENT high-water mark above max(id), so a rebuild,
  // which resets it to max(id), is visible.
  await db('transactions').where({ akahu_id: 'trans_fixture_191_discarded' }).del()
  const { id: firstId } = await db('transactions')
    .where({ akahu_id: 'trans_fixture_191_a' })
    .first('id')
  await db('category_corrections').insert({
    transaction_id: firstId,
    from_category: null,
    to_category: 'Bakeries',
    corrected_at: AT,
    source: 'user',
  })

  const [accountId] = await db('accounts').insert({
    akahu_id: 'acc_fixture_191',
    name: 'Fixture Everyday',
    created_at: AT,
    updated_at: AT,
  })
  await db('account_settings').insert({
    account_id: accountId,
    role: 'credit_card',
    updated_at: AT,
  })
  await db('bills').insert({
    scope: 'personal',
    name: 'Power',
    amount_cents: 18450,
    repeat: 'monthly',
    first_due_date: '2026-10-31',
    account_id: accountId,
    created_at: AT,
    updated_at: AT,
  })

  transactionsBefore = await db('transactions').orderBy('id')
  correctionsBefore = await db('category_corrections').orderBy('id')
  accountSettingsBefore = await db('account_settings').orderBy('id')
  billsBefore = await db('bills').orderBy('id')
  columnsBefore = await columns(db, 'transactions')
  sequenceBefore = await sequence(db, 'transactions')
  rootpageBefore = await rootpage()
})

afterEach(async () => {
  await db.destroy()
})

describe(MIGRATION, () => {
  it('seeds a counter above max(id), a correction and account links to lose', () => {
    expect(sequenceBefore).toBeGreaterThan(
      Math.max(...transactionsBefore.map((r) => Number(r.id))),
    )
    expect(correctionsBefore).toHaveLength(1)
    expect(accountSettingsBefore).toHaveLength(1)
    expect(billsBefore).toHaveLength(1)
    expect(billsBefore[0].account_id).not.toBeNull()
  })

  it('adds exactly posted_date and merchant_nzbn, as nullable text with no default', async () => {
    for (const column of NEW_COLUMNS) expect(columnsBefore).not.toContain(column)

    await db.migrate.up()

    expect(await columns(db, 'transactions')).toEqual([...columnsBefore, ...NEW_COLUMNS])
    expect(await columnInfo(NEW_COLUMNS)).toStrictEqual([
      { name: 'posted_date', type: 'TEXT', notnull: 0, dflt_value: null },
      { name: 'merchant_nzbn', type: 'TEXT', notnull: 0, dflt_value: null },
    ])
  })

  it('keeps every row as it was, with NULL in both new columns', async () => {
    await db.migrate.up()

    const after: Row[] = await db('transactions').orderBy('id')
    for (const row of after) {
      expect(Object.keys(row).sort()).toEqual([...columnsBefore, ...NEW_COLUMNS].sort())
    }
    expect(after).toStrictEqual(
      transactionsBefore.map((row) => ({ ...row, posted_date: null, merchant_nzbn: null })),
    )
  })

  it('does not rebuild transactions or cascade into category_corrections', async () => {
    await db.migrate.up()

    expect(await db('category_corrections').orderBy('id')).toStrictEqual(correctionsBefore)
    expect(await count(db, 'category_corrections')).toBe(1)
    expect(await sequence(db, 'transactions')).toBe(sequenceBefore)
    expect(await rootpage()).toBe(rootpageBefore)
    expect(await indexNames()).toContain(INDEX)
  })

  it('leaves account_settings and the bill linked to the account alone', async () => {
    await db.migrate.up()

    expect(await db('account_settings').orderBy('id')).toStrictEqual(accountSettingsBefore)
    expect(await db('bills').orderBy('id')).toStrictEqual(billsBefore)
  })

  it('stores both columns as SQLite text, a digit-only NZBN included, and accepts NULL', async () => {
    await db.migrate.up()

    await db('transactions')
      .where({ akahu_id: 'trans_fixture_191_a' })
      .update({ posted_date: '2026-10-23T00:00:00.000Z', merchant_nzbn: '9400000000001' })

    expect(
      await db('transactions')
        .orderBy('id')
        .select(
          db.raw('posted_date'),
          db.raw('merchant_nzbn'),
          db.raw('typeof(posted_date) AS posted_date_type'),
          db.raw('typeof(merchant_nzbn) AS merchant_nzbn_type'),
        ),
    ).toStrictEqual([
      {
        posted_date: '2026-10-23T00:00:00.000Z',
        merchant_nzbn: '9400000000001',
        posted_date_type: 'text',
        merchant_nzbn_type: 'text',
      },
      {
        posted_date: null,
        merchant_nzbn: null,
        posted_date_type: 'null',
        merchant_nzbn_type: 'null',
      },
    ])
  })

  it('rolls back to exactly the previous columns without rebuilding transactions', async () => {
    await db.migrate.up()
    await db('transactions')
      .where({ akahu_id: 'trans_fixture_191_a' })
      .update({ posted_date: '2026-10-23T00:00:00.000Z', merchant_nzbn: 'fixture-nzbn-191' })

    await db.migrate.down()

    expect(await columns(db, 'transactions')).toEqual(columnsBefore)
    expect(await db('transactions').orderBy('id')).toStrictEqual(transactionsBefore)
    expect(await db('category_corrections').orderBy('id')).toStrictEqual(correctionsBefore)
    expect(await sequence(db, 'transactions')).toBe(sequenceBefore)
    expect(await rootpage()).toBe(rootpageBefore)
    expect(await indexNames()).toContain(INDEX)
  })

  it('runs up, down and up again', async () => {
    await db.migrate.up()
    await db.migrate.down()
    await db.migrate.up()

    expect(await columns(db, 'transactions')).toEqual([...columnsBefore, ...NEW_COLUMNS])
    expect(await db('category_corrections').orderBy('id')).toStrictEqual(correctionsBefore)
  })
})

// issue 46: 20261025150000_settings_drop_user_id.js. Covers the migration
// from the schema just before it (holding legacy `settings` rows under a
// `users` row), through `migrate:latest`, and back down. Every value is
// invented.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../knexfile.js'
import { migrateToJustBefore } from './migrateToJustBefore.ts'
import { columns, count, notNullColumns } from './schemaInfo.ts'

const OURS = '20261025150000_settings_drop_user_id.js'

// Two rows for `currency`: the numeric one (epoch ms, as the sqlite3 driver
// stores a JS Date) is later than the old `CURRENT_TIMESTAMP` text one, so
// it must win although its rowid is lower. The two `tax_rate_bp` rows share
// a time, so the later rowid wins.
const OLD_TEXT = '2026-01-02 03:04:05'
const OLD_TEXT_ISO = '2026-01-02T03:04:05.000Z'
const NEWER_MS = Date.parse('2026-06-01T00:00:00.000Z')
const NEWER_ISO = '2026-06-01T00:00:00.000Z'

let db: Knex

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, OURS)

  await db('users').insert({ id: 1, email: 'fixture@example.com', password: 'x' })
  await db('settings').insert([
    { id: 's1', user_id: 1, key: 'currency', value: 'NZ$', updated_at: NEWER_MS },
    { id: 's2', user_id: 1, key: 'currency', value: '£', updated_at: OLD_TEXT },
    { id: 's3', user_id: 1, key: 'dark_mode', value: 'true', updated_at: OLD_TEXT },
    { id: 's4', user_id: 1, key: 'notifications', value: null, updated_at: OLD_TEXT },
    { id: 's5', user_id: 1, key: 'tax_rate_bp', value: '1000', updated_at: OLD_TEXT },
    { id: 's6', user_id: 1, key: 'tax_rate_bp', value: '1500', updated_at: OLD_TEXT },
    { id: 's7', user_id: 1, key: 'profit_cents', value: '500', updated_at: 'not a date' },
  ])
})

afterEach(async () => {
  await db.destroy()
})

async function up() {
  await db.migrate.up()
}

describe('up', () => {
  it('keeps one row per key, the latest by updated_at, then by rowid', async () => {
    // A covering index with `value` descending makes SQLite read the legacy
    // rows in index order, so `tax_rate_bp` '1500' (s6) comes back before
    // '1000' (s5). Without the rowid tie-break, the last row read would win.
    await db.raw('CREATE INDEX settings_probe ON settings (key, value DESC, updated_at)')
    await up()

    const rows = await db('settings').orderBy('key').select('key', 'value', 'updated_at')
    const keyed = Object.fromEntries(rows.map((r) => [r.key, r]))

    expect(Object.keys(keyed).sort()).toEqual(
      ['currency', 'dark_mode', 'profit_cents', 'tax_rate_bp'].sort(),
    )
    expect(keyed.currency).toStrictEqual({
      key: 'currency',
      value: 'NZ$',
      updated_at: NEWER_ISO,
    })
    expect(keyed.tax_rate_bp.value).toBe('1500')
  })

  it('keeps keys nothing reads yet and skips a NULL value', async () => {
    await up()

    expect(await db('settings').where({ key: 'dark_mode' }).first('value')).toEqual({
      value: 'true',
    })
    expect(await db('settings').where({ key: 'notifications' })).toEqual([])
  })

  it('drops a key whose newest row is NULL, rather than bringing back an older value', async () => {
    await db('settings').insert([
      { id: 's8', user_id: 1, key: 'payday_weekday', value: '3', updated_at: OLD_TEXT },
      { id: 's9', user_id: 1, key: 'payday_weekday', value: null, updated_at: NEWER_MS },
    ])
    await up()

    expect(await db('settings').where({ key: 'payday_weekday' })).toEqual([])
  })

  it.each([
    ['NULL', null],
    ['unparseable', 'not a date'],
  ])('ranks an undated row (%s updated_at) below a dated row for the same key', async (_label, undated) => {
    // The undated row is written last, so neither its rowid nor a "now"
    // stand-in may carry it past the dated row.
    await db('settings').insert([
      { id: 's8', user_id: 1, key: 'personal_tax_owed_cents', value: '100', updated_at: OLD_TEXT },
      { id: 's9', user_id: 1, key: 'personal_tax_owed_cents', value: '999', updated_at: undated },
    ])
    await up()

    expect(
      await db('settings').where({ key: 'personal_tax_owed_cents' }).select('value', 'updated_at'),
    ).toStrictEqual([{ value: '100', updated_at: OLD_TEXT_ISO }])
  })

  it('names the unique index settings_key_unique, not after the copy it was built on', async () => {
    await up()

    const indexes = await db('sqlite_master')
      .where({ type: 'index', tbl_name: 'settings' })
      .whereNotNull('sql')
      .pluck('name')
    expect(indexes).toEqual(['settings_key_unique'])
  })

  it('writes every updated_at as ISO-8601 UTC with a Z', async () => {
    const before = new Date().toISOString()
    await up()
    const after = new Date().toISOString()

    const rows = await db('settings').select('key', 'updated_at')
    for (const row of rows) {
      expect(row.updated_at, row.key).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    const at = Object.fromEntries(rows.map((r) => [r.key, r.updated_at]))
    expect(at.dark_mode).toBe(OLD_TEXT_ISO)
    // Unparseable: the migration's own time.
    expect(at.profit_cents >= before && at.profit_cents <= after).toBe(true)
  })

  it('leaves exactly id, key, value and updated_at, all NOT NULL with no default', async () => {
    await up()

    expect(await columns(db, 'settings')).toEqual(['id', 'key', 'value', 'updated_at'])
    expect(await notNullColumns(db, 'settings')).toEqual([
      { name: 'key', dflt_value: null },
      { name: 'value', dflt_value: null },
      { name: 'updated_at', dflt_value: null },
    ])
    expect(await db.schema.hasTable('settings_next')).toBe(false)
  })

  it('refuses a second row for a key', async () => {
    await up()

    await expect(
      db('settings').insert({ key: 'currency', value: '$', updated_at: NEWER_ISO }),
    ).rejects.toThrow(/UNIQUE constraint failed: settings\.key/)
  })

  it('refuses a row with no key', async () => {
    await up()

    await expect(
      db('settings').insert({ value: '$', updated_at: NEWER_ISO }),
    ).rejects.toThrow(/NOT NULL constraint failed: settings\.key/)
  })

  it('takes a row with no users row, with foreign keys on', async () => {
    await up()
    await db('users').delete()

    expect((await db.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
    await db('settings').insert({ key: 'payday_weekday', value: '2', updated_at: NEWER_ISO })
    expect(await db('settings').where({ key: 'payday_weekday' }).first('value')).toEqual({
      value: '2',
    })
  })

  it('leaves users untouched', async () => {
    const before = await db('users').orderBy('id')
    await up()

    expect(await db('users').orderBy('id')).toStrictEqual(before)
  })
})

describe('down', () => {
  it("recreates the old shape, empty, with user_id NOT NULL, and leaves users", async () => {
    const usersBefore = await db('users').orderBy('id')
    await up()
    await db.migrate.down()

    expect(await columns(db, 'settings')).toEqual([
      'id',
      'user_id',
      'key',
      'value',
      'updated_at',
    ])
    expect(await notNullColumns(db, 'settings')).toContainEqual({
      name: 'user_id',
      dflt_value: null,
    })
    expect(await count(db, 'settings')).toBe(0)
    expect(await db('users').orderBy('id')).toStrictEqual(usersBefore)
  })

  it('rolls all the way back and up to latest again', async () => {
    await db.migrate.latest()
    await db.migrate.rollback(undefined, true)
    expect(await db.schema.hasTable('settings')).toBe(false)

    await db.migrate.latest()
    expect(await columns(db, 'settings')).toEqual(['id', 'key', 'value', 'updated_at'])
  })
})

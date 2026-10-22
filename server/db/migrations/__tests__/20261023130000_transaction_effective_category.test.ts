import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../knexfile.js'
import { migrateToJustBefore } from '../../__tests__/migrateToJustBefore.ts'

const MIGRATION = '20261023130000_transaction_effective_category.js'

let db: Knex

const AKAHU_CATEGORY = {
  category_id: 'nzfcc_ckouvvy98001a08ml3l180boh',
  category_name: 'Bakeries',
  category_group_id: 'group_clasr0ysw000xhk4mf7mg2j1z',
  category_group_name: 'Food',
}

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, MIGRATION)
})

afterEach(async () => {
  await db.destroy()
})

describe(MIGRATION, () => {
  it("backfills the effective category from Akahu's and marks it akahu-sourced", async () => {
    await db('transactions').insert([
      { akahu_id: 'with', amount_cents: -980, ...AKAHU_CATEGORY },
      { akahu_id: 'without', amount_cents: 425000 },
    ])

    await db.migrate.up()

    expect(
      await db('transactions')
        .select('akahu_id', 'category', 'category_source')
        .orderBy('akahu_id'),
    ).toEqual([
      { akahu_id: 'with', category: 'Bakeries', category_source: 'akahu' },
      { akahu_id: 'without', category: null, category_source: 'akahu' },
    ])
  })

  it("leaves Akahu's category columns exactly as they were", async () => {
    await db('transactions').insert({ akahu_id: 'a', amount_cents: 1, ...AKAHU_CATEGORY })

    await db.migrate.up()

    expect(
      await db('transactions')
        .where({ akahu_id: 'a' })
        .first(
          'category_id',
          'category_name',
          'category_group_id',
          'category_group_name',
        ),
    ).toEqual(AKAHU_CATEGORY)
  })

  it('defaults new rows to akahu and refuses an unknown source', async () => {
    await db.migrate.up()

    await db('transactions').insert({ akahu_id: 'new', amount_cents: 1 })
    expect(
      await db('transactions').where({ akahu_id: 'new' }).first('category_source'),
    ).toEqual({ category_source: 'akahu' })

    for (const ok of ['user', 'rule', 'claude', 'akahu']) {
      await db('transactions').where({ akahu_id: 'new' }).update({ category_source: ok })
    }
    await expect(
      db('transactions').where({ akahu_id: 'new' }).update({ category_source: 'bogus' }),
    ).rejects.toThrow(/CHECK constraint failed/)
    await expect(
      db('transactions').where({ akahu_id: 'new' }).update({ category_source: null }),
    ).rejects.toThrow(/NOT NULL/)
  })

  it('rolls back to the previous columns with Akahu data intact', async () => {
    await db('transactions').insert({ akahu_id: 'a', amount_cents: 1, ...AKAHU_CATEGORY })
    await db.migrate.up()

    await db.migrate.down()

    const row = await db('transactions').where({ akahu_id: 'a' }).first()
    expect(Object.keys(row)).not.toContain('category')
    expect(Object.keys(row)).not.toContain('category_source')
    expect(row).toMatchObject(AKAHU_CATEGORY)
  })
})

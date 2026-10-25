import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import { setUserCategory } from '../transactions.ts'
import { TRANSACTION_COLUMNS } from './transactionColumns.ts'

// Direct tests of the db layer, with the connection passed explicitly. The
// connection is the in-memory `test` config under vitest (NODE_ENV=test);
// `assertInMemory` refuses anything else before a table is touched. Each
// test starts from a freshly migrated and seeded database.
beforeEach(async () => {
  delete process.env.DIVVY_SEED_TRANSACTIONS
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  await connection.seed.run()
})

afterAll(async () => {
  await connection.destroy()
})

const LEGACY_AKAHU_CATEGORY = [
  'category_id',
  'category_name',
  'category_group_id',
  'category_group_name',
] as const

const AKAHU_CATEGORY = [
  'akahu_category_id',
  'akahu_category_name',
  'akahu_category_group_id',
  'akahu_category_group_name',
] as const

async function rowFor(akahuId: string) {
  return connection('transactions').where({ akahu_id: akahuId }).first()
}

async function allRows() {
  return connection('transactions').select().orderBy('id')
}

describe('setUserCategory', () => {
  it('returns the updated row with every transactions column', async () => {
    const before = await rowFor('trans_fixture_002')

    const row = await setUserCategory(before.id, 'Convenience stores', connection)

    expect(row).toMatchObject({
      id: before.id,
      category: 'Convenience stores',
      category_source: 'user',
    })
    expect(Object.keys(row!).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
    // The returned row is what is stored, not a hand-built copy.
    expect(row).toEqual(await rowFor('trans_fixture_002'))
  })

  it('returns undefined for an id no transaction has and writes nothing', async () => {
    const before = await allRows()
    expect(before.length).toBeGreaterThan(0)

    const row = await setUserCategory(999_999, 'Bakeries', connection)

    expect(row).toBeUndefined()
    expect(await allRows()).toEqual(before)
  })

  it('changes only the row with that id', async () => {
    const before = await allRows()
    const target = await rowFor('trans_fixture_003')

    await setUserCategory(target.id, 'Bakeries', connection)

    const after = await allRows()
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    for (const [i, row] of after.entries()) {
      if (row.id === target.id) {
        expect(row).toEqual({
          ...before[i],
          category: 'Bakeries',
          category_source: 'user',
        })
      } else {
        expect(row).toEqual(before[i])
      }
    }
  })

  it("leaves Akahu's category columns, legacy and akahu_*, exactly as received", async () => {
    const { id } = await rowFor('trans_fixture_002')
    // The seed leaves akahu_category_* NULL; give them values so an
    // overwrite (or a null-out) is visible.
    await connection('transactions').where({ id }).update({
      akahu_category_id: 'nzfcc_invented_id',
      akahu_category_name: 'Invented category',
      akahu_category_group_id: 'group_invented_id',
      akahu_category_group_name: 'Invented group',
    })
    const before = await connection('transactions').where({ id }).first()
    for (const column of [...LEGACY_AKAHU_CATEGORY, ...AKAHU_CATEGORY]) {
      expect(before[column]).not.toBeNull()
    }

    const row = await setUserCategory(id, 'Convenience stores', connection)

    for (const column of [...LEGACY_AKAHU_CATEGORY, ...AKAHU_CATEGORY]) {
      expect(row![column]).toBe(before[column])
    }
    const stored = await connection('transactions').where({ id }).first()
    for (const column of [...LEGACY_AKAHU_CATEGORY, ...AKAHU_CATEGORY]) {
      expect(stored[column]).toBe(before[column])
    }
  })

  it('leaves status and source as they were', async () => {
    const { id } = await rowFor('trans_fixture_002')
    await connection('transactions').where({ id }).update({ source: 'xero' })
    const before = await connection('transactions').where({ id }).first()
    expect(before).toMatchObject({ status: 'settled', source: 'xero' })

    const row = await setUserCategory(id, 'Bakeries', connection)

    expect(row).toMatchObject({ status: 'settled', source: 'xero' })
  })

  it('sets a category on a row Akahu never categorised', async () => {
    const before = await rowFor('trans_fixture_001')
    expect(before.category).toBeNull()

    const row = await setUserCategory(before.id, 'Bakeries', connection)

    expect(row).toMatchObject({ category: 'Bakeries', category_source: 'user' })
    expect(row!.category_name).toBeNull()
  })

  it('works again on a row that is already category_source = user', async () => {
    const { id } = await rowFor('trans_fixture_002')
    await setUserCategory(id, 'Bakeries', connection)

    const row = await setUserCategory(id, 'Convenience stores', connection)

    expect(row).toMatchObject({
      id,
      category: 'Convenience stores',
      category_source: 'user',
    })
    expect((await rowFor('trans_fixture_002')).category).toBe('Convenience stores')
  })

  it('marks the row user-owned even when the category is unchanged', async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category_source).toBe('akahu')

    const row = await setUserCategory(before.id, before.category, connection)

    expect(row).toMatchObject({
      category: before.category,
      category_source: 'user',
    })
  })
})

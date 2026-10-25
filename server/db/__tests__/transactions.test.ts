import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import { getTransactionCategory, setUserCategory } from '../transactions.ts'
import { TRANSACTION_COLUMNS } from './transactionColumns.ts'
import type { Transaction } from '../../../models/transactions.ts'

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

async function allCorrections() {
  return connection('category_corrections').select().orderBy('id')
}

// Narrows setUserCategory's result to the updated row, failing the test if
// it was either refusal instead.
function updatedRow(
  result: Awaited<ReturnType<typeof setUserCategory>>,
): Transaction {
  if (result === undefined || result === 'pending') {
    throw new Error(`expected the updated row, got ${String(result)}`)
  }
  return result
}

// Every column of `category_corrections`.
const CORRECTION_COLUMNS = [
  'id',
  'transaction_id',
  'from_category',
  'to_category',
  'corrected_at',
  'source',
]

// The exact form `new Date().toISOString()` produces: UTC, milliseconds, Z.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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
      expect(updatedRow(row)[column]).toBe(before[column])
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
    expect(updatedRow(row).category_name).toBeNull()
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

// prd-01 Rulings 1 and 4, #129: every category change appends a correction
// in the same database transaction, and a pending row is refused.
describe('setUserCategory corrections and pending rows', () => {
  it('appends exactly one correction from the previous effective category', async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category_source).toBe('akahu')
    const startedAt = new Date().toISOString()

    updatedRow(await setUserCategory(before.id, 'Bakeries', connection))

    const corrections = await allCorrections()
    expect(corrections).toHaveLength(1)
    const [correction] = corrections
    expect(Object.keys(correction).sort()).toEqual([...CORRECTION_COLUMNS].sort())
    expect(correction).toMatchObject({
      transaction_id: before.id,
      from_category: before.category,
      to_category: 'Bakeries',
      source: 'user',
    })
    expect(correction.corrected_at).toMatch(ISO_UTC)
    expect(correction.corrected_at >= startedAt).toBe(true)
    expect(correction.corrected_at <= new Date().toISOString()).toBe(true)
  })

  it('appends a correction even when the category is unchanged, from and to the same category', async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category).toBe('Supermarkets and grocery stores')

    updatedRow(await setUserCategory(before.id, before.category, connection))

    const corrections = await allCorrections()
    expect(corrections).toHaveLength(1)
    expect(corrections[0]).toMatchObject({
      transaction_id: before.id,
      from_category: 'Supermarkets and grocery stores',
      to_category: 'Supermarkets and grocery stores',
      source: 'user',
    })
  })

  it('writes no correction for an id no transaction has', async () => {
    expect(await setUserCategory(999_999, 'Bakeries', connection)).toBeUndefined()

    expect(await allCorrections()).toEqual([])
  })

  it("returns 'pending' for a pending row and writes neither the category nor a correction", async () => {
    const { id } = await rowFor('trans_fixture_002')
    await connection('transactions').where({ id }).update({ status: 'pending' })
    const before = await allRows()

    const result = await setUserCategory(id, 'Bakeries', connection)

    expect(result).toBe('pending')
    expect(await allRows()).toEqual(before)
    expect(await allCorrections()).toEqual([])
  })

  it('rolls the category write back when the correction cannot be written', async () => {
    const { id } = await rowFor('trans_fixture_002')
    const before = await allRows()
    // Dropped with the table by the next beforeEach's rollback; no migration
    // is involved.
    await connection.raw(`
      CREATE TRIGGER refuse_corrections BEFORE INSERT ON category_corrections
      BEGIN SELECT RAISE(ABORT, 'invented correction failure'); END
    `)

    await expect(setUserCategory(id, 'Bakeries', connection)).rejects.toThrow(
      'invented correction failure',
    )

    expect(await allRows()).toEqual(before)
    expect(await allCorrections()).toEqual([])
  })

  // The mirror of the test above: it fails an implementation that writes the
  // correction first and the category second outside one transaction.
  it('writes no correction when the category write fails', async () => {
    const { id } = await rowFor('trans_fixture_002')
    const before = await allRows()
    // Dropped with the table by the next beforeEach's rollback.
    await connection.raw(`
      CREATE TRIGGER refuse_category_writes BEFORE UPDATE ON transactions
      BEGIN SELECT RAISE(ABORT, 'invented category write failure'); END
    `)

    await expect(setUserCategory(id, 'Bakeries', connection)).rejects.toThrow(
      'invented category write failure',
    )

    expect(await allRows()).toEqual(before)
    expect(await allCorrections()).toEqual([])
  })

  it("runs inside a caller's transaction, and that transaction's rollback undoes both writes", async () => {
    const { id } = await rowFor('trans_fixture_002')
    const before = await allRows()

    await expect(
      connection.transaction(async (trx) => {
        updatedRow(await setUserCategory(id, 'Bakeries', trx))
        expect(await trx('category_corrections').count({ n: '*' })).toEqual([{ n: 1 }])
        throw new Error('invented caller failure')
      }),
    ).rejects.toThrow('invented caller failure')

    expect(await allRows()).toEqual(before)
    expect(await allCorrections()).toEqual([])
  })

  it("commits with the caller's transaction", async () => {
    const { id } = await rowFor('trans_fixture_002')

    await connection.transaction(async (trx) => {
      updatedRow(await setUserCategory(id, 'Bakeries', trx))
    })

    expect((await rowFor('trans_fixture_002')).category).toBe('Bakeries')
    expect(await allCorrections()).toHaveLength(1)
  })
})

// Decision 3cb449c6 (#51): setUserCategory takes the source it marks, in
// both `category_source` and the correction. Its default must stay `user`,
// which PATCH /transactions relies on by passing no source at all; `rule` is
// what the agent accept route writes (prd-04 Ruling 7).
describe('setUserCategory source', () => {
  it('with no source argument, writes `user` in both category_source and the correction source', async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category_source).toBe('akahu')

    const row = updatedRow(await setUserCategory(before.id, 'Bakeries', connection))

    expect(row.category_source).toBe('user')
    const stored = await rowFor('trans_fixture_002')
    expect(stored).toMatchObject({ category: 'Bakeries', category_source: 'user' })
    const corrections = await allCorrections()
    expect(corrections).toHaveLength(1)
    expect(corrections[0]).toMatchObject({
      transaction_id: before.id,
      from_category: before.category,
      to_category: 'Bakeries',
      source: 'user',
    })
  })

  it("with an explicit 'user', writes exactly what the default writes", async () => {
    const { id } = await rowFor('trans_fixture_002')

    // Each call runs in a transaction that is then rolled back, so both start
    // from the same row. The correction's id and timestamp are left out: they
    // differ by construction, not by source.
    async function outcome(source?: 'user') {
      let seen: { stored: Transaction; correction: Record<string, unknown> } | undefined
      await expect(
        connection.transaction(async (trx) => {
          const row = updatedRow(
            source === undefined
              ? await setUserCategory(id, 'Bakeries', trx)
              : await setUserCategory(id, 'Bakeries', trx, source),
          )
          const corrections = await trx('category_corrections').select()
          expect(corrections).toHaveLength(1)
          const [c] = corrections
          const correction = {
            transaction_id: c.transaction_id,
            from_category: c.from_category,
            to_category: c.to_category,
            source: c.source,
          }
          seen = { stored: row, correction }
          throw new Error('invented rollback')
        }),
      ).rejects.toThrow('invented rollback')
      return seen
    }

    const byDefault = await outcome()
    const explicit = await outcome('user')

    expect(byDefault).toBeDefined()
    expect(explicit).toEqual(byDefault)
    expect(explicit?.stored.category_source).toBe('user')
    expect(explicit?.correction.source).toBe('user')
  })

  it("with 'rule', writes rule in the stored and returned row and one rule correction", async () => {
    const before = await rowFor('trans_fixture_002')
    expect(before.category_source).toBe('akahu')
    const startedAt = new Date().toISOString()

    const row = updatedRow(
      await setUserCategory(before.id, 'Bakeries', connection, 'rule'),
    )

    expect(row).toMatchObject({ category: 'Bakeries', category_source: 'rule' })
    const stored = await rowFor('trans_fixture_002')
    expect(stored).toMatchObject({ category: 'Bakeries', category_source: 'rule' })
    expect(row).toEqual(stored)

    const corrections = await allCorrections()
    expect(corrections).toHaveLength(1)
    const [correction] = corrections
    expect(Object.keys(correction).sort()).toEqual([...CORRECTION_COLUMNS].sort())
    expect(correction).toMatchObject({
      transaction_id: before.id,
      from_category: before.category,
      to_category: 'Bakeries',
      source: 'rule',
    })
    expect(correction.corrected_at).toMatch(ISO_UTC)
    expect(correction.corrected_at >= startedAt).toBe(true)
    expect(correction.corrected_at <= new Date().toISOString()).toBe(true)
  })

  it("with 'rule' on a pending row, returns 'pending' and writes nothing", async () => {
    const { id } = await rowFor('trans_fixture_002')
    await connection('transactions').where({ id }).update({ status: 'pending' })
    const before = await allRows()

    const result = await setUserCategory(id, 'Bakeries', connection, 'rule')

    expect(result).toBe('pending')
    expect(await allRows()).toEqual(before)
    expect(await allCorrections()).toEqual([])
  })

  it("with 'rule' through a caller's transaction, commits with it", async () => {
    const { id } = await rowFor('trans_fixture_002')

    await connection.transaction(async (trx) => {
      updatedRow(await setUserCategory(id, 'Bakeries', trx, 'rule'))
    })

    expect(await rowFor('trans_fixture_002')).toMatchObject({
      category: 'Bakeries',
      category_source: 'rule',
    })
    const corrections = await allCorrections()
    expect(corrections).toHaveLength(1)
    expect(corrections[0]).toMatchObject({ transaction_id: id, source: 'rule' })
  })

  it("with 'rule' through a caller's transaction, is undone by its rollback in both columns", async () => {
    const { id } = await rowFor('trans_fixture_002')
    const before = await allRows()

    await expect(
      connection.transaction(async (trx) => {
        const row = updatedRow(await setUserCategory(id, 'Bakeries', trx, 'rule'))
        expect(row.category_source).toBe('rule')
        expect(await trx('category_corrections').select('source')).toEqual([
          { source: 'rule' },
        ])
        throw new Error('invented caller failure')
      }),
    ).rejects.toThrow('invented caller failure')

    expect(await allRows()).toEqual(before)
    expect((await rowFor('trans_fixture_002')).category_source).toBe('akahu')
    expect(await allCorrections()).toEqual([])
  })
})

describe('getTransactionCategory', () => {
  it('a known id gives exactly the category and who set it', async () => {
    const { id } = await rowFor('trans_fixture_002')
    await setUserCategory(id, 'Bakeries', connection)

    const got = await getTransactionCategory(id, connection)

    expect(got).toBeDefined()
    expect(Object.keys(got ?? {}).sort()).toEqual(['category', 'category_source'])
    expect(got).toEqual({ category: 'Bakeries', category_source: 'user' })
  })

  it('a null category gives category null', async () => {
    const { id } = await rowFor('trans_fixture_002')
    await connection('transactions').where({ id }).update({ category: null })

    const got = await getTransactionCategory(id, connection)

    expect(got).toStrictEqual({ category: null, category_source: 'akahu' })
  })

  it('an unknown id gives undefined', async () => {
    expect(await getTransactionCategory(999_999, connection)).toBeUndefined()
  })
})

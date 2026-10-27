import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import {
  CategoriseDataError,
  applyGroup,
  listGroups,
  validateApplyRequest,
} from '../categorise.ts'

// The Sort screen's data module (prd-02 Ruling 17, issue #259), against a
// fresh in-memory database. The route tests cover the Done-when bullets over
// HTTP; this file covers what the loader reads and what the totals refuse.
// Every value below is invented, in integer cents.

const STAMP = '2026-10-20T00:00:00.000Z'
const EVERYDAY = 'acc_fixture_everyday'
const TRADING = 'acc_fixture_trading'
const CAFES = 'Cafes and restaurants'

type Row = Record<string, unknown>

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

// A copy of the account/transaction builders in
// server/routes/__tests__/categorise.test.ts and its siblings.
async function insertAll(table: string, rows: Row[]) {
  for (const row of rows) await connection(table).insert(row)
}

function account(id: number, akahuId: string, scope: string, fields: Row = {}): Row {
  return {
    id,
    akahu_id: akahuId,
    source: 'akahu',
    scope,
    name: `Invented ${id}`,
    balance_cents: 100000,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

function tx(
  id: number,
  accountId: string,
  date: string,
  amountCents: number,
  fields: Row = {},
): Row {
  return {
    id,
    akahu_id: `trans_fixture_${id}`,
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: 'EXAMPLE CAFE',
    type: 'EFTPOS',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

async function seedAccounts() {
  await insertAll('accounts', [
    account(1, EVERYDAY, 'personal'),
    account(2, TRADING, 'strawb'),
  ])
}

describe('listGroups reads', () => {
  it('nothing when no account is stored', async () => {
    expect(await listGroups('all')).toStrictEqual({ groups: [] })
  })

  it('no row on an account that is not stored', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, 'acc_fixture_unknown', '2026-10-01T01:00:00.000Z', -500),
    ])

    expect(await listGroups('all')).toStrictEqual({ groups: [] })
  })

  it('no row on a Xero account, nor a Xero row', async () => {
    await insertAll('accounts', [
      account(1, EVERYDAY, 'personal'),
      account(3, 'acc_fixture_ledger', 'personal', { source: 'xero' }),
    ])
    await insertAll('transactions', [
      tx(1, 'acc_fixture_ledger', '2026-10-01T01:00:00.000Z', -500),
      tx(2, EVERYDAY, '2026-10-01T01:00:00.000Z', -500, { source: 'xero' }),
    ])

    // Fails if the loader drops `source = 'akahu'` on either side.
    expect(await listGroups('all')).toStrictEqual({ groups: [] })
  })

  it('no row with no amount or no date', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -500, { amount_cents: null }),
      tx(2, EVERYDAY, '2026-10-01T01:00:00.000Z', -500, { date: null }),
    ])

    expect(await listGroups('all')).toStrictEqual({ groups: [] })
  })
})

describe('the totals', () => {
  it('count money out as spend and money in apart, never netting them', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -1001),
      tx(2, EVERYDAY, '2026-10-02T01:00:00.000Z', 400),
      tx(3, EVERYDAY, '2026-10-03T01:00:00.000Z', -2),
      tx(4, EVERYDAY, '2026-10-04T01:00:00.000Z', 0),
    ])

    const [group] = (await listGroups('personal')).groups

    // Fails if the total nets money in against money out (603) or sums
    // signed amounts.
    expect([group.totalCents, group.receivedCents, group.count]).toEqual([
      1003, 400, 4,
    ])
  })

  it('refuse a sum that is not a safe integer, with the constant text', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -Number.MAX_SAFE_INTEGER),
      tx(2, EVERYDAY, '2026-10-02T01:00:00.000Z', -1),
    ])

    const err = await listGroups('personal').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CategoriseDataError)
    expect((err as Error).message).toBe('a total is out of range')
  })

  it('refuse a stored amount that is not whole cents', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -12.5),
    ])

    const err = await listGroups('personal').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CategoriseDataError)
    expect((err as Error).message).toBe('a transaction is incomplete')
  })
})

describe('the card fields', () => {
  it('answer a null latest date when the stored date is not an instant', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, 'not a date', -500),
    ])

    const [group] = (await listGroups('personal')).groups
    expect(group.latestDate).toBeNull()
    expect(group.latestAmountCents).toBe(-500)
  })

  it('name a card Unnamed merchant when its rows have only a merchant id', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -500, {
        merchant_id: 'merchant_fixture_quiet',
        merchant_name: null,
        description: '   ',
      }),
    ])

    expect((await listGroups('personal')).groups.map((g) => g.name)).toEqual([
      'Unnamed merchant',
    ])
  })

  it('take the latest row by date, then by id', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(2, EVERYDAY, '2026-10-05T01:00:00.000Z', -200, {
        merchant_name: 'EXAMPLE LATER ID',
      }),
      tx(1, EVERYDAY, '2026-10-05T01:00:00.000Z', -100, {
        merchant_name: 'EXAMPLE EARLIER ID',
      }),
      tx(3, EVERYDAY, '2026-10-01T01:00:00.000Z', -300, {
        merchant_name: 'EXAMPLE OLDEST',
      }),
    ])

    const [group] = (await listGroups('personal')).groups
    expect([group.name, group.latestAmountCents]).toEqual([
      'EXAMPLE LATER ID',
      -200,
    ])
  })
})

describe('applyGroup', () => {
  it('changes only the rows of the named key in the named scope', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -500),
      tx(2, TRADING, '2026-10-01T01:00:00.000Z', -500),
      tx(3, EVERYDAY, '2026-10-01T01:00:00.000Z', -500, {
        description: 'EXAMPLE BAKERY',
      }),
    ])

    expect(
      await applyGroup({
        scope: 'personal',
        merchant_key: 'd:example cafe',
        category: CAFES,
      }),
    ).toStrictEqual({ changed: 1 })
    expect(
      await connection('transactions').orderBy('id').pluck('category'),
    ).toEqual([CAFES, null, null])
  })

  it('writes nothing when one row of the group fails: one transaction', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      tx(1, EVERYDAY, '2026-10-01T01:00:00.000Z', -500),
      tx(2, EVERYDAY, '2026-10-02T01:00:00.000Z', -500),
      tx(3, EVERYDAY, '2026-10-03T01:00:00.000Z', -500),
    ])
    // The third row's correction insert fails, after the first two rows
    // were written.
    await connection.raw(
      `CREATE TRIGGER fail_row_3 BEFORE INSERT ON category_corrections
       WHEN NEW.transaction_id = 3
       BEGIN SELECT RAISE(ABORT, 'invented failure'); END`,
    )

    await expect(
      applyGroup({
        scope: 'personal',
        merchant_key: 'd:example cafe',
        category: CAFES,
      }),
    ).rejects.toThrow()

    // Without the transaction, rows 1 and 2 keep the category and their
    // corrections.
    expect(
      await connection('transactions').orderBy('id').pluck('category'),
    ).toEqual([null, null, null])
    expect(await connection('category_corrections').count('* as n')).toEqual([
      { n: 0 },
    ])
  })

  it('answers 0 for a key with no rows', async () => {
    await seedAccounts()

    expect(
      await applyGroup({
        scope: 'all',
        merchant_key: 'm:merchant_fixture_none',
        category: CAFES,
      }),
    ).toStrictEqual({ changed: 0 })
  })
})

describe('validateApplyRequest', () => {
  const valid = {
    scope: 'strawb',
    merchant_key: 'd:example cafe',
    category: CAFES,
  }

  it('answers the request for a valid body, with exactly its keys', () => {
    const result = validateApplyRequest(valid)
    expect(result).toStrictEqual({ request: valid })
    if ('request' in result) {
      expect(Object.keys(result.request).sort()).toEqual([
        'category',
        'merchant_key',
        'scope',
      ])
    }
  })

  it.each([null, 'scope=all', 7, [valid]])('refuses %j as a body', (body) => {
    expect(validateApplyRequest(body)).toStrictEqual({ error: 'Invalid body' })
  })

  it('refuses the request type’s camelCase spelling', () => {
    expect(
      validateApplyRequest({
        scope: 'strawb',
        merchantKey: 'd:example cafe',
        category: CAFES,
      }),
    ).toStrictEqual({ error: 'Invalid body' })
  })

  it('accepts Drawings, which Hannah can pick, and refuses a group name', () => {
    expect(
      validateApplyRequest({ ...valid, category: 'Drawings' }),
    ).toStrictEqual({ request: { ...valid, category: 'Drawings' } })
    expect(validateApplyRequest({ ...valid, category: 'Food' })).toStrictEqual({
      error: 'category is not in the category list',
    })
  })
})

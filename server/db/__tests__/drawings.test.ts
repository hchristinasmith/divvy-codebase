// Imported first, before anything that imports overview.ts: drawings.ts and
// overview.ts import each other, and this file proves the cycle loads from
// the drawings side (the route tests load it from the overview side).
import { applyDrawings, loadDrawingIds } from '../drawings.ts'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../connection.ts'
import { nzCalendarDate } from '../overview.ts'
import { assertInMemory } from '../../test-utils/app.ts'

// Drawings on read (prd-02 Ruling 15, issue #264): server/db/drawings.ts
// against a fresh in-memory database. Every value below is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

const TRADING = 'acc_fixture_trading'
const SPARE_STRAWB = 'acc_fixture_strawb_spare'
const EVERYDAY = 'acc_fixture_everyday'

async function seedAccounts() {
  await connection('accounts').insert(
    (
      [
        [1, TRADING, 'strawb'],
        [2, SPARE_STRAWB, 'strawb'],
        [3, EVERYDAY, 'personal'],
      ] as const
    ).map(([id, akahuId, scope]) => ({
      id,
      akahu_id: akahuId,
      source: 'akahu',
      scope,
      name: 'Invented account',
      balance_cents: 100000,
      created_at: STAMP,
      updated_at: STAMP,
    })),
  )
}

function tx(
  id: number,
  accountId: string | null,
  date: string | null,
  amountCents: number | null,
  fields: Row = {},
): Row {
  return {
    id,
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: `Invented ${id}`,
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

const sorted = (ids: Set<number>) => [...ids].sort((a, b) => a - b)

describe('loadDrawingIds', () => {
  it('finds both halves of a strawb outflow and an equal personal inflow a day later (DW1)', async () => {
    await seedAccounts()
    await connection('transactions').insert([
      tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
      tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 30000),
    ])
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([1, 2])
  })

  it('counts pending halves like settled ones', async () => {
    await seedAccounts()
    await connection('transactions').insert([
      tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000, { status: 'pending' }),
      tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 30000, { status: 'pending' }),
    ])
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([1, 2])
  })

  it('reads all time, not a window: a pair a year old is found', async () => {
    await seedAccounts()
    await connection('transactions').insert([
      tx(1, TRADING, '2025-10-27T01:00:00.000Z', -30000),
      tx(2, EVERYDAY, '2025-10-29T01:00:00.000Z', 30000),
    ])
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([1, 2])
  })

  it('is blind to category: a categorised half is still a half', async () => {
    await seedAccounts()
    await connection('transactions').insert([
      tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000, {
        category: 'Contractors',
        category_source: 'user',
      }),
      tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 30000, {
        category: 'Salary',
      }),
    ])
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([1, 2])
  })

  it.each<[string, Row[]]>([
    [
      'a 1-cent mismatch (DW3)',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 29999),
      ],
    ],
    [
      'personal to strawb (DW5)',
      [
        tx(1, EVERYDAY, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, TRADING, '2026-10-28T01:00:00.000Z', 30000),
      ],
    ],
    [
      'strawb to another strawb account',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, SPARE_STRAWB, '2026-10-28T01:00:00.000Z', 30000),
      ],
    ],
    [
      'an inflow on an account that is not stored',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, 'acc_nobody', '2026-10-28T01:00:00.000Z', 30000),
      ],
    ],
    [
      'an inflow that is a Xero row',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 30000, { source: 'xero' }),
      ],
    ],
    [
      'an inflow with no date',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, EVERYDAY, null, 30000),
      ],
    ],
    [
      'an inflow whose date is not an instant',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, EVERYDAY, 'not a date', 30000),
      ],
    ],
    [
      'an inflow with no amount',
      [
        tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
        tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', null),
      ],
    ],
  ])('finds no drawing for %s', async (_why, rows) => {
    await seedAccounts()
    await connection('transactions').insert(rows)
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([])
  })

  it('a Xero-sourced account with a matching akahu_id is not read', async () => {
    await seedAccounts()
    await connection('accounts')
      .where({ akahu_id: EVERYDAY })
      .update({ source: 'xero' })
    await connection('transactions').insert([
      tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
      tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 30000),
    ])
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([])
  })

  it('places each half on its NZ calendar date, not its UTC one', async () => {
    await seedAccounts()
    // Out 11:30 UTC on 27 Oct is 00:30 NZDT on the 28th; in 10:30 UTC on 31
    // Oct is 23:30 NZDT on the 31st: 3 NZ days, though 4 UTC days.
    const out = '2026-10-27T11:30:00.000Z'
    const inAt = '2026-10-31T10:30:00.000Z'
    expect(nzCalendarDate(new Date(out))).toBe('2026-10-28')
    expect(nzCalendarDate(new Date(inAt))).toBe('2026-10-31')
    // Out 10:30 UTC on 27 Oct is 23:30 NZDT on the 27th; in 11:30 UTC on 30
    // Oct is 00:30 NZDT on the 31st: 4 NZ days, though 3 UTC days.
    const lateOut = '2026-10-27T10:30:00.000Z'
    const earlyIn = '2026-10-30T11:30:00.000Z'
    expect(nzCalendarDate(new Date(lateOut))).toBe('2026-10-27')
    expect(nzCalendarDate(new Date(earlyIn))).toBe('2026-10-31')
    await connection('transactions').insert([
      tx(1, TRADING, out, -30000),
      tx(2, EVERYDAY, inAt, 30000),
      tx(3, TRADING, lateOut, -45000),
      tx(4, EVERYDAY, earlyIn, 45000),
    ])
    expect(sorted(await loadDrawingIds(connection))).toStrictEqual([1, 2])
  })

  it('writes nothing', async () => {
    await seedAccounts()
    await connection('transactions').insert([
      tx(1, TRADING, '2026-10-27T01:00:00.000Z', -30000),
      tx(2, EVERYDAY, '2026-10-28T01:00:00.000Z', 30000),
    ])
    const before = {
      transactions: await connection('transactions').orderBy('id').select(),
      accounts: await connection('accounts').orderBy('id').select(),
      corrections: await connection('category_corrections').select(),
    }
    await loadDrawingIds(connection)
    expect({
      transactions: await connection('transactions').orderBy('id').select(),
      accounts: await connection('accounts').orderBy('id').select(),
      corrections: await connection('category_corrections').select(),
    }).toStrictEqual(before)
    expect(
      (await connection('transactions').select('category')).map(
        (r) => r.category,
      ),
    ).toStrictEqual([null, null])
  })
})

describe('applyDrawings', () => {
  const row = (id: number | string, fields: Row = {}) => ({
    id,
    description: `Invented ${id}`,
    amount_cents: -100,
    category: null as string | null,
    category_source: 'akahu' as const,
    ...fields,
  })

  it('shows a half as Drawings, set by rule, keeping every other key (DW1)', () => {
    const [shown] = applyDrawings(
      [row(1, { category: 'Software' })],
      new Set([1]),
    )
    expect(Object.keys(shown).sort()).toStrictEqual(
      [
        'id',
        'description',
        'amount_cents',
        'category',
        'category_source',
      ].sort(),
    )
    expect(shown).toStrictEqual({
      id: 1,
      description: 'Invented 1',
      amount_cents: -100,
      category: 'Drawings',
      category_source: 'rule',
    })
  })

  it('keeps the category Hannah set by hand on a half (DW4)', () => {
    const [shown] = applyDrawings(
      [row(1, { category: 'Contractors', category_source: 'user' })],
      new Set([1]),
    )
    expect(shown).toMatchObject({
      category: 'Contractors',
      category_source: 'user',
    })
  })

  it('returns a row that is not a half as it was', () => {
    const plain = row(3, { category: 'Software' })
    const [shown] = applyDrawings([plain], new Set([1, 2]))
    expect(shown).toBe(plain)
  })

  it('reads a text id as the number it holds', () => {
    const [shown] = applyDrawings([row('7')], new Set([7]))
    expect(shown).toMatchObject({
      id: '7',
      category: 'Drawings',
      category_source: 'rule',
    })
  })
})

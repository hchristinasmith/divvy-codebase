import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { runSync } from '../run.ts'
import {
  at,
  closeDb,
  db,
  fakeAkahu,
  fixture,
  freshDb,
  MINUTE_MS,
  page,
  replaceOnce,
  snapshot,
} from './harness.ts'
import type { Route, Routes } from './harness.ts'

// Issue #155 (prd-01 Ruling 4: "Every Akahu transaction is stored in full").
//
// The optional fields sync already stores follow Akahu on every run: a run
// over unchanged data writes nothing, and a field Akahu stops sending is
// written back as NULL rather than left at its last value. These tests pin
// that behaviour for the fields sync stored before #155, so the fields #155
// adds can be held to the same rule.

beforeEach(async () => {
  await freshDb()
})
afterAll(closeDb)

const fixed = (date: Date) => () => date

/**
 * A transactions route serving `text` as page 1 and an empty last page for
 * the cursor it names, as the harness's default route does for the fixture.
 */
function transactionsRoute(text: string): Route {
  return (url) => (url.searchParams.has('cursor') ? page([]) : text)
}

/**
 * `text` without the JSON member `pair` and the comma before it; throws
 * unless `pair` occurs exactly once and is not the first member of its
 * object, so a fixture edit cannot make the removal a no-op.
 */
function withoutMember(text: string, pair: string): string {
  const first = text.indexOf(pair)
  if (first === -1 || text.indexOf(pair, first + 1) !== -1) {
    throw new Error(`expected exactly one ${JSON.stringify(pair)} in fixture`)
  }
  const before = text.slice(0, first).trimEnd()
  if (!before.endsWith(',')) {
    throw new Error(`${JSON.stringify(pair)} is the first member of its object`)
  }
  return before.slice(0, -1) + text.slice(first + pair.length)
}

function syncAt(minutes: number, routes: Routes = {}) {
  return runSync({
    client: fakeAkahu(routes).client,
    db,
    now: fixed(at(minutes * MINUTE_MS)),
  })
}

describe('the optional fields sync stored before #155', () => {
  it('a second run over unchanged data writes nothing', async () => {
    const first = await syncAt(0)
    expect(first).toMatchObject({ outcome: 'success', insertedCount: 8 })
    const before = await snapshot()

    const second = await syncAt(15)

    expect(second).toMatchObject({
      outcome: 'success',
      insertedCount: 0,
      updatedCount: 0,
    })
    expect(await snapshot()).toEqual(before)
  })

  it('writes NULL when Akahu stops sending merchant.website or meta.logo', async () => {
    await syncAt(0)
    const before = await snapshot()
    const row = await db('transactions')
      .where({ akahu_id: 'trans_fixture0001' })
      .first('merchant_website', 'logo')
    expect(row).toEqual({
      merchant_website: 'https://example.com/cafe',
      logo: 'https://example.com/fixture-cafe-logo.png',
    })

    let text = fixture('akahu-transactions.json')
    text = withoutMember(text, '"website": "https://example.com/cafe"')
    text = withoutMember(
      text,
      '"logo": "https://example.com/fixture-cafe-logo.png"',
    )
    const second = await syncAt(15, { transactions: transactionsRoute(text) })

    expect(second).toMatchObject({
      outcome: 'success',
      insertedCount: 0,
      updatedCount: 1,
    })
    const after = await snapshot()
    const changed = after.settled.find(
      (r) => r.akahu_id === 'trans_fixture0001',
    )
    const original = before.settled.find(
      (r) => r.akahu_id === 'trans_fixture0001',
    )
    expect(changed).toEqual({
      ...original,
      merchant_website: null,
      logo: null,
    })
    // Every other row, and every other table, is as it was.
    expect(after.settled.filter((r) => r !== changed)).toEqual(
      before.settled.filter((r) => r !== original),
    )
    expect({ ...after, settled: [] }).toEqual({ ...before, settled: [] })
  })

  it('writes NULL on a pending row when Akahu stops sending meta.logo', async () => {
    await syncAt(0)
    const logos = async () =>
      (
        await db('transactions')
          .where({ status: 'pending' })
          .orderBy('amount_cents')
          .select('amount_cents', 'logo')
      ).map((r: { amount_cents: number; logo: string | null }) => [
        r.amount_cents,
        r.logo,
      ])
    expect(await logos()).toEqual([
      [-6420, 'https://example.com/fixture-fuel-logo.png'],
      [-850, null],
    ])

    const pending = withoutMember(
      fixture('akahu-pending.json'),
      '"logo": "https://example.com/fixture-fuel-logo.png"',
    )
    const second = await syncAt(15, { pending })

    expect(second).toMatchObject({
      outcome: 'success',
      pendingMirroredCount: 2,
    })
    expect(await logos()).toEqual([
      [-6420, null],
      [-850, null],
    ])
  })
})

// The fields #155 adds: card_suffix, the conversion and merchant.logo, on
// settled and pending rows alike.

const FULL_COLUMNS = [
  'card_suffix',
  'conversion_amount_cents',
  'conversion_currency',
  'conversion_rate',
  'merchant_logo',
] as const

type FullColumns = Record<(typeof FULL_COLUMNS)[number], unknown>

const NO_FULL_FIELDS: FullColumns = {
  card_suffix: null,
  conversion_amount_cents: null,
  conversion_currency: null,
  conversion_rate: null,
  merchant_logo: null,
}

const ITEM_A: FullColumns = {
  card_suffix: '0042',
  conversion_amount_cents: 1234,
  conversion_currency: 'USD',
  conversion_rate: 0.6123,
  merchant_logo: 'https://example.com/fixture-store-logo.png',
}

const PENDING_FULL: FullColumns = {
  card_suffix: '0077',
  conversion_amount_cents: 456,
  conversion_currency: 'GBP',
  conversion_rate: 0.4565,
  merchant_logo: 'https://example.com/fixture-streaming-logo.png',
}

/** The full-fields routes: `transactions` and `pending` as given. */
function full(
  transactions = fixture('akahu-transactions-full.json'),
  pending = fixture('akahu-pending-full.json'),
): Routes {
  return { transactions: transactionsRoute(transactions), pending }
}

async function fullColumnsOf(akahuId: string): Promise<FullColumns> {
  const row: FullColumns | undefined = await db('transactions')
    .where({ akahu_id: akahuId })
    .first(...FULL_COLUMNS)
  if (row === undefined) throw new Error(`no row for ${akahuId}`)
  return row
}

async function pendingFullColumns(): Promise<FullColumns[]> {
  return db('transactions')
    .where({ status: 'pending' })
    .orderBy('amount_cents')
    .select(...FULL_COLUMNS)
}

describe('the fields #155 adds', () => {
  it('stores each field a fixture item carries, and NULL for each it does not', async () => {
    const result = await syncAt(0, full())

    expect(result).toMatchObject({
      outcome: 'success',
      insertedCount: 3,
      pendingMirroredCount: 1,
    })
    const a = await fullColumnsOf('trans_fixture_full_a')
    expect(Object.keys(a).sort()).toEqual([...FULL_COLUMNS].sort())
    expect(a).toEqual(ITEM_A)
    expect(await fullColumnsOf('trans_fixture_full_b')).toEqual({
      ...NO_FULL_FIELDS,
      conversion_currency: 'AUD',
    })
    expect(await fullColumnsOf('trans_fixture_full_c')).toEqual(NO_FULL_FIELDS)
    expect(await pendingFullColumns()).toEqual([PENDING_FULL])
  })

  it('stores each value with the SQLite type it will be read back as', async () => {
    // conversion_currency is a float column, so a code must stay text and a
    // card suffix must keep its leading zero. Rate text would be turned into
    // a real here by the column itself; what catches a rate left as text is
    // the second-run test below, where it would read as a change every run.
    await syncAt(0, full())

    const types = await db.raw(
      `SELECT status,
              typeof(card_suffix) AS card_suffix,
              typeof(conversion_amount_cents) AS conversion_amount_cents,
              typeof(conversion_currency) AS conversion_currency,
              typeof(conversion_rate) AS conversion_rate,
              typeof(merchant_logo) AS merchant_logo
         FROM transactions
        WHERE akahu_id = 'trans_fixture_full_a' OR status = 'pending'
        ORDER BY status`,
    )
    const expected = {
      card_suffix: 'text',
      conversion_amount_cents: 'integer',
      conversion_currency: 'text',
      conversion_rate: 'real',
      merchant_logo: 'text',
    }
    expect(types).toEqual([
      { status: 'pending', ...expected },
      { status: 'settled', ...expected },
    ])
  })

  it('writes nothing on a second run over the same data', async () => {
    await syncAt(0, full())
    const before = await snapshot()

    const second = await syncAt(15, full())

    expect(second).toMatchObject({
      outcome: 'success',
      insertedCount: 0,
      updatedCount: 0,
    })
    expect(await snapshot()).toEqual(before)
  })

  it('writes NULL when Akahu stops sending the fields', async () => {
    await syncAt(0, full())
    let text = fixture('akahu-transactions-full.json')
    text = withoutMember(
      text,
      '"logo": "https://example.com/fixture-store-logo.png"',
    )
    text = withoutMember(
      text,
      '"conversion": {\n          "amount": 12.34,\n          "currency": "USD",\n          "rate": 0.6123\n        }',
    )
    // The first member of its object, so its own comma goes with it.
    text = replaceOnce(text, '"card_suffix": "0042",', '')

    const second = await syncAt(15, full(text))

    expect(second).toMatchObject({ outcome: 'success', updatedCount: 1 })
    expect(await fullColumnsOf('trans_fixture_full_a')).toEqual(NO_FULL_FIELDS)
  })

  it.each([
    [
      'rate',
      '"rate": 0.6123',
      '"rate": 0.6125',
      { ...ITEM_A, conversion_rate: 0.6125 },
    ],
    [
      'card suffix',
      '"card_suffix": "0042"',
      '"card_suffix": "0043"',
      { ...ITEM_A, card_suffix: '0043' },
    ],
    [
      'conversion amount',
      '"amount": 12.34',
      '"amount": 12.35',
      { ...ITEM_A, conversion_amount_cents: 1235 },
    ],
  ])('updates the row when Akahu changes the %s', async (_label, from, to, columns) => {
    await syncAt(0, full())
    const text = replaceOnce(fixture('akahu-transactions-full.json'), from, to)

    const second = await syncAt(15, full(text))

    expect(second).toMatchObject({ outcome: 'success', updatedCount: 1 })
    expect(await fullColumnsOf('trans_fixture_full_a')).toEqual(columns)
  })

  it('changes only the card suffix of a row whose category the user set (Ruling 4)', async () => {
    await syncAt(0, full())
    const { id } = await db('transactions')
      .where({ akahu_id: 'trans_fixture_full_a' })
      .first('id')
    await db('transactions')
      .where({ id })
      .update({ category: 'Bakeries', category_source: 'user' })
    await db('category_corrections').insert({
      transaction_id: id,
      from_category: null,
      to_category: 'Bakeries',
      corrected_at: at(5 * MINUTE_MS).toISOString(),
      source: 'user',
    })
    const before = await snapshot()
    const text = replaceOnce(
      fixture('akahu-transactions-full.json'),
      '"card_suffix": "0042"',
      '"card_suffix": "0099"',
    )

    const second = await syncAt(15, full(text))

    expect(second).toMatchObject({ outcome: 'success', updatedCount: 1 })
    const after = await snapshot()
    const row = before.settled.find((r) => r.id === id)
    expect(after.settled.find((r) => r.id === id)).toEqual({
      ...row,
      card_suffix: '0099',
    })
    expect(after.corrections).toEqual(before.corrections)
    expect(after.settled.filter((r) => r.id !== id)).toEqual(
      before.settled.filter((r) => r.id !== id),
    )
  })

  it('fails the run and changes nothing when a conversion is malformed', async () => {
    await syncAt(0, full())
    const before = await snapshot()
    const text = replaceOnce(
      fixture('akahu-transactions-full.json'),
      '"currency": "USD"',
      '"currency": "978"',
    )

    const second = await syncAt(15, full(text))

    expect(second.outcome).toBe('failed')
    expect(await snapshot()).toEqual(before)
  })

  it('leaves NULL and no leftover row when pending items stop carrying the fields', async () => {
    await syncAt(0, full())
    expect(await pendingFullColumns()).toEqual([PENDING_FULL])

    const second = await syncAt(15, {
      transactions: transactionsRoute(fixture('akahu-transactions-full.json')),
    })

    expect(second).toMatchObject({
      outcome: 'success',
      pendingMirroredCount: 2,
    })
    expect(await pendingFullColumns()).toEqual([
      NO_FULL_FIELDS,
      NO_FULL_FIELDS,
    ])
  })
})

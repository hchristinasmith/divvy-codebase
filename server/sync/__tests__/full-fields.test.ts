import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { runSync } from '../run.ts'
import {
  closeDb,
  db,
  fakeAkahu,
  fixture,
  MINUTE_MS,
  at,
  freshDb,
  page,
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

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import { SpendingDataError, readSpendingByCategory } from '../spending.ts'
import * as drawings from '../drawings.ts'

// The real drawing loader, behind a spy, so a test can make it throw what
// the shared matcher throws.
vi.mock('../drawings.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../drawings.ts')>()
  return { ...real, loadDrawingIds: vi.fn(real.loadDrawingIds) }
})

// The spending data module (#271), against a fresh in-memory database: how
// drawings are laid over the rows it hands the shared module, and which
// failures become which fixed text. The route test covers the rest. Every
// value below is invented. The clock is passed in: 23:30 UTC on 27 October
// 2026 is 12:30 NZDT on the 28th.

const NOW = new Date('2026-10-27T23:30:00Z')
const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await connection.destroy()
})

const EVERYDAY = 'acc_sentinel_everyday'
const TRADING = 'acc_sentinel_trading'

function tx(
  accountId: string,
  date: string | null,
  amountCents: number,
  fields: Row = {},
): Row {
  return {
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: 'SENTINEL SHOP',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

async function seed(rows: Row[]) {
  for (const row of [
    { id: 1, akahu_id: EVERYDAY, scope: 'personal' },
    { id: 2, akahu_id: TRADING, scope: 'strawb' },
  ]) {
    await connection('accounts').insert({
      source: 'akahu',
      name: 'Invented account',
      created_at: STAMP,
      updated_at: STAMP,
      ...row,
    })
  }
  // One insert per row, so a left-out key takes its column default.
  for (const row of rows) await connection('transactions').insert(row)
}

describe('readSpendingByCategory', () => {
  it('lays drawings over the category, so the shared module leaves them out', async () => {
    await seed([
      tx(TRADING, '2026-10-15T00:00:00.000Z', -25000, {
        category: 'Transfers Invented',
      }),
      tx(EVERYDAY, '2026-10-16T00:00:00.000Z', 25000),
      // An Akahu-set Drawings category on a row that matched nothing is
      // still Drawings.
      tx(TRADING, '2026-10-18T00:00:00.000Z', -900, { category: 'Drawings' }),
      tx(TRADING, '2026-10-17T00:00:00.000Z', -4400, {
        category: 'Software Invented',
      }),
    ])

    const r = await readSpendingByCategory({ scope: 'strawb' }, NOW, connection)

    expect(r).toStrictEqual({
      scope: 'strawb',
      month: '2026-10',
      totalCents: 4400,
      categories: [{ category: 'Software Invented', spentCents: 4400 }],
      otherCents: 0,
      uncategorisedCents: 0,
    })
    expect(vi.mocked(drawings.loadDrawingIds)).toHaveBeenCalledTimes(1)
  })

  it('a half the user categorised by hand keeps her category', async () => {
    await seed([
      tx(TRADING, '2026-10-15T00:00:00.000Z', -25000, {
        category: 'Software Invented',
        category_source: 'user',
      }),
      tx(EVERYDAY, '2026-10-16T00:00:00.000Z', 25000),
    ])

    const r = await readSpendingByCategory({ scope: 'all' }, NOW, connection)

    expect(r.categories).toStrictEqual([
      { category: 'Software Invented', spentCents: 25000 },
    ])
  })

  it('passes month and top through', async () => {
    await seed([
      tx(EVERYDAY, '2026-08-05T00:00:00.000Z', -300, { category: 'A Invented' }),
      tx(EVERYDAY, '2026-08-05T00:00:00.000Z', -200, { category: 'B Invented' }),
      tx(EVERYDAY, '2026-08-05T00:00:00.000Z', -100, { category: 'C Invented' }),
    ])

    const r = await readSpendingByCategory(
      { scope: 'personal', month: '2026-08', top: 1 },
      NOW,
      connection,
    )

    expect(r.month).toBe('2026-08')
    expect(r.categories).toStrictEqual([
      { category: 'A Invented', spentCents: 300 },
    ])
    // B 200 + C 100.
    expect(r.otherCents).toBe(300)
  })
})

describe('errors become fixed text', () => {
  it.each([
    ['RangeError', new RangeError('candidate 7 appears twice')],
    ['TypeError', new TypeError('amountCents of candidate 7 must be …')],
  ])('the matcher’s %s is spending input invalid', async (_name, thrown) => {
    await seed([])
    vi.mocked(drawings.loadDrawingIds).mockRejectedValueOnce(thrown)

    const run = readSpendingByCategory({ scope: 'all' }, NOW, connection)

    await expect(run).rejects.toStrictEqual(
      new SpendingDataError('spending input invalid'),
    )
  })

  it('any other loader failure passes through unchanged', async () => {
    await seed([])
    const thrown = new Error('disk gone')
    vi.mocked(drawings.loadDrawingIds).mockRejectedValueOnce(thrown)

    await expect(
      readSpendingByCategory({ scope: 'all' }, NOW, connection),
    ).rejects.toBe(thrown)
  })

  it('an amount that is not whole cents is spending input invalid', async () => {
    await seed([tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -10.5)])

    await expect(
      readSpendingByCategory({ scope: 'all' }, NOW, connection),
    ).rejects.toStrictEqual(new SpendingDataError('spending input invalid'))
  })

  it.each([
    ['no date', null],
    ['a date that is not an instant', '2026-10-garbage'],
  ])('a row with %s is a transaction is incomplete', async (_why, date) => {
    await seed([tx(EVERYDAY, date, -100)])

    await expect(
      readSpendingByCategory({ scope: 'all' }, NOW, connection),
    ).rejects.toStrictEqual(new SpendingDataError('a transaction is incomplete'))
  })

  it('a row in the month with no amount is a transaction is incomplete, not left out', async () => {
    await seed([
      tx(EVERYDAY, '2026-10-05T00:00:00.000Z', -500),
      { ...tx(EVERYDAY, '2026-10-06T00:00:00.000Z', 0), amount_cents: null },
    ])

    await expect(
      readSpendingByCategory({ scope: 'all' }, NOW, connection),
    ).rejects.toStrictEqual(new SpendingDataError('a transaction is incomplete'))
  })

  it('a month that is not YYYY-MM is spending input invalid, before any read', async () => {
    await seed([])

    await expect(
      readSpendingByCategory(
        { scope: 'all', month: '2026-13' },
        NOW,
        connection,
      ),
    ).rejects.toStrictEqual(new SpendingDataError('spending input invalid'))
    expect(vi.mocked(drawings.loadDrawingIds)).not.toHaveBeenCalled()
  })
})

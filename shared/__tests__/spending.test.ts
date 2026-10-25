// Spending by category (#271, prd-02 Ruling 1 note of 2026-10-25): the
// month's outflow per category, all from `shared/spending.ts`. Every
// expected figure is worked by hand in the comment beside it and written as
// a literal; none is computed by the code under test. Categories and
// amounts are invented, in integer cents.

import { describe, expect, it } from 'vitest'
import type {
  Scope,
  SpendingByCategoryResponse,
  SpendingCategoryLine,
} from '../contracts.ts'
import { DRAWINGS_CATEGORY } from '../drawings.ts'
import {
  SPENDING_TOP_MAX,
  countsAsSpending,
  isYearMonth,
  spendingByCategory,
  type SpendingTransaction,
} from '../spending.ts'

const MONTH = '2026-10'

function tx(fields: Partial<SpendingTransaction> = {}): SpendingTransaction {
  return {
    scope: 'personal',
    date: '2026-10-14',
    amountCents: -1000,
    category: 'Groceries Invented',
    ...fields,
  }
}

function run(
  transactions: SpendingTransaction[],
  fields: { scope?: Scope; month?: string; top?: number } = {},
): SpendingByCategoryResponse {
  return spendingByCategory({
    scope: fields.scope ?? 'all',
    month: fields.month ?? MONTH,
    top: fields.top,
    transactions,
  })
}

/** The response's own figures add up: lines, other and uncategorised. */
function addsUp(r: SpendingByCategoryResponse): number {
  let sum = r.otherCents + r.uncategorisedCents
  for (const line of r.categories) sum += line.spentCents
  return sum
}

const RESPONSE_KEYS: Record<keyof SpendingByCategoryResponse, true> = {
  scope: true,
  month: true,
  totalCents: true,
  categories: true,
  otherCents: true,
  uncategorisedCents: true,
}
const LINE_KEYS: Record<keyof SpendingCategoryLine, true> = {
  category: true,
  spentCents: true,
}

// Seven categories, each a different amount, so the top-n fold has a tail.
const SEVEN = [
  tx({ category: 'A Invented', amountCents: -700 }),
  tx({ category: 'B Invented', amountCents: -600 }),
  tx({ category: 'C Invented', amountCents: -500 }),
  tx({ category: 'D Invented', amountCents: -400 }),
  tx({ category: 'E Invented', amountCents: -300 }),
  tx({ category: 'F Invented', amountCents: -200 }),
  tx({ category: 'G Invented', amountCents: -100 }),
]

describe('spendingByCategory', () => {
  it('sums each category and lists the largest first', () => {
    const r = run([
      tx({ category: 'Cafes Invented', amountCents: -450 }),
      tx({ category: 'Groceries Invented', amountCents: -2310 }),
      tx({ category: 'Cafes Invented', amountCents: -615 }),
      tx({ category: 'Groceries Invented', amountCents: -1205 }),
    ])

    // Groceries 2310 + 1205 = 3515; Cafes 450 + 615 = 1065.
    expect(r.categories).toStrictEqual([
      { category: 'Groceries Invented', spentCents: 3515 },
      { category: 'Cafes Invented', spentCents: 1065 },
    ])
    expect(r.totalCents).toBe(4580)
    expect(r.otherCents).toBe(0)
    expect(r.uncategorisedCents).toBe(0)
  })

  it('pins the response and line key sets', () => {
    const r = run([tx()], { top: 1 })

    expect(Object.keys(r).sort()).toEqual(Object.keys(RESPONSE_KEYS).sort())
    expect(Object.keys(r.categories[0]).sort()).toEqual(
      Object.keys(LINE_KEYS).sort(),
    )
  })

  it('orders equal amounts by category in code-point order, whatever the input order', () => {
    const rows = [
      tx({ category: 'b Invented', amountCents: -500 }),
      tx({ category: 'B Invented', amountCents: -500 }),
      tx({ category: 'a Invented', amountCents: -500 }),
    ]
    // 'B' (U+0042) before 'a' (U+0061) before 'b' (U+0062): not a locale order.
    const expected = ['B Invented', 'a Invented', 'b Invented']

    expect(run(rows).categories.map((l) => l.category)).toEqual(expected)
    expect(
      run([...rows].reverse()).categories.map((l) => l.category),
    ).toEqual(expected)
  })

  it('compares code points, not UTF-16 code units', () => {
    // U+FF66 is below U+1F600 as a code point, but its single code unit
    // (0xFF66) is above the emoji's first one (0xD83D).
    const rows = [
      tx({ category: '\u{1F600}', amountCents: -500 }),
      tx({ category: 'ｦ', amountCents: -500 }),
    ]

    expect(run(rows).categories.map((l) => l.category)).toEqual([
      'ｦ',
      '\u{1F600}',
    ])
  })

  it('counts a row with no category as uncategorised only', () => {
    const r = run([
      tx({ category: null, amountCents: -830 }),
      tx({ category: null, amountCents: -170 }),
      tx({ amountCents: -2000 }),
    ])

    // 830 + 170 = 1000, never a line and never in other.
    expect(r.uncategorisedCents).toBe(1000)
    expect(r.categories).toStrictEqual([
      { category: 'Groceries Invented', spentCents: 2000 },
    ])
    expect(r.otherCents).toBe(0)
    expect(r.totalCents).toBe(3000)
  })

  it('leaves Drawings out entirely (prd-02 Ruling 15)', () => {
    const r = run([
      tx({ scope: 'strawb', category: DRAWINGS_CATEGORY, amountCents: -50000 }),
      tx({ amountCents: -1200 }),
    ])

    expect(r.categories.map((l) => l.category)).toEqual(['Groceries Invented'])
    expect(r.totalCents).toBe(1200)
  })

  it('ignores money in, which never offsets an outflow', () => {
    const r = run([
      tx({ amountCents: -3000 }),
      // A refund in the same category, and income with none.
      tx({ amountCents: 2500 }),
      tx({ category: null, amountCents: 90000 }),
      tx({ amountCents: 0 }),
    ])

    expect(r.categories).toStrictEqual([
      { category: 'Groceries Invented', spentCents: 3000 },
    ])
    expect(r.uncategorisedCents).toBe(0)
    expect(r.totalCents).toBe(3000)
  })

  it('all sums both scopes; personal and strawb keep to their own', () => {
    const rows = [
      tx({ scope: 'personal', amountCents: -1100 }),
      tx({ scope: 'strawb', amountCents: -2200 }),
      tx({ scope: 'strawb', category: 'Software Invented', amountCents: -330 }),
    ]

    // all: Groceries 1100 + 2200 = 3300, Software 330.
    expect(run(rows, { scope: 'all' }).categories).toStrictEqual([
      { category: 'Groceries Invented', spentCents: 3300 },
      { category: 'Software Invented', spentCents: 330 },
    ])
    expect(run(rows, { scope: 'personal' }).categories).toStrictEqual([
      { category: 'Groceries Invented', spentCents: 1100 },
    ])
    expect(run(rows, { scope: 'strawb' }).categories).toStrictEqual([
      { category: 'Groceries Invented', spentCents: 2200 },
      { category: 'Software Invented', spentCents: 330 },
    ])
    expect(run(rows, { scope: 'strawb' }).scope).toBe('strawb')
  })

  it('counts only rows whose NZ date is in the month, both edges included', () => {
    const r = run([
      tx({ date: '2026-09-30', amountCents: -1 }),
      tx({ date: '2026-10-01', amountCents: -20 }),
      tx({ date: '2026-10-31', amountCents: -300 }),
      tx({ date: '2026-11-01', amountCents: -4000 }),
      tx({ date: '2025-10-15', amountCents: -50000 }),
    ])

    // 20 + 300: the day before, the day after and last year are out.
    expect(r.totalCents).toBe(320)
    expect(r.month).toBe(MONTH)
  })

  it('top 5 of 7 lists five and folds the other two into otherCents', () => {
    const r = run(SEVEN, { top: 5 })

    expect(r.categories.map((l) => l.category)).toEqual([
      'A Invented',
      'B Invented',
      'C Invented',
      'D Invented',
      'E Invented',
    ])
    // F 200 + G 100.
    expect(r.otherCents).toBe(300)
    // 700 + 600 + 500 + 400 + 300 + 200 + 100.
    expect(r.totalCents).toBe(2800)
  })

  it('top above the number of categories lists them all with other 0', () => {
    const r = run(SEVEN, { top: SPENDING_TOP_MAX })

    expect(r.categories).toHaveLength(7)
    expect(r.otherCents).toBe(0)
  })

  it('with no top lists every category and other is 0', () => {
    const r = run(SEVEN)

    expect(r.categories).toHaveLength(7)
    expect(r.otherCents).toBe(0)
  })

  it('lines, other and uncategorised add up to the total', () => {
    const rows = [
      ...SEVEN,
      tx({ category: null, amountCents: -999 }),
      tx({ scope: 'strawb', category: DRAWINGS_CATEGORY, amountCents: -7777 }),
      tx({ amountCents: 4444 }),
    ]
    for (const top of [undefined, 1, 3, 5, 7, SPENDING_TOP_MAX]) {
      const r = run(rows, { top })
      // 2800 + 999; the drawing and the inflow are out.
      expect(r.totalCents, `top ${top}`).toBe(3799)
      expect(addsUp(r), `top ${top}`).toBe(3799)
    }
  })

  it('an empty month is zeros', () => {
    expect(run([tx({ date: '2026-09-14' })], { top: 5 })).toStrictEqual({
      scope: 'all',
      month: MONTH,
      totalCents: 0,
      categories: [],
      otherCents: 0,
      uncategorisedCents: 0,
    })
  })

  it.each([['2026-13'], ['2026-1'], [''], ['0999-01']])(
    'refuses the month %j with a RangeError',
    (month) => {
      expect(() => run([], { month })).toThrow(RangeError)
    },
  )

  it.each([[0], [1.5], [SPENDING_TOP_MAX + 1], [-1], [Number.NaN]])(
    'refuses top %d with a RangeError',
    (top) => {
      expect(() => run([], { top })).toThrow(RangeError)
    },
  )

  it('accepts top from 1 to the maximum', () => {
    expect(run(SEVEN, { top: 1 }).categories).toHaveLength(1)
    expect(run(SEVEN, { top: SPENDING_TOP_MAX }).categories).toHaveLength(7)
  })

  it('refuses an amount that is not whole cents with a TypeError', () => {
    expect(() => run([tx({ amountCents: -10.5 })])).toThrow(TypeError)
  })

  it.each([['2026-10-14T00:00:00.000Z'], ['2026-10-32'], ['14/10/2026']])(
    'refuses the row date %j with a RangeError',
    (date) => {
      expect(() => run([tx({ date })])).toThrow(RangeError)
    },
  )

  it('checks every row, even one outside the month or scope', () => {
    expect(() =>
      run([tx({ scope: 'strawb', date: '2025-01-01', amountCents: 0.5 })], {
        scope: 'personal',
      }),
    ).toThrow(TypeError)
  })

  it('refuses a view scope it does not know with a RangeError', () => {
    expect(() =>
      spendingByCategory({
        scope: 'business' as Scope,
        month: MONTH,
        transactions: [],
      }),
    ).toThrow(RangeError)
  })
})

describe('countsAsSpending', () => {
  it('is false for Drawings, whoever set it, and true otherwise', () => {
    expect(countsAsSpending(tx({ category: DRAWINGS_CATEGORY }))).toBe(false)
    expect(countsAsSpending(tx({ category: 'Groceries Invented' }))).toBe(true)
    expect(countsAsSpending(tx({ category: null }))).toBe(true)
  })

  it('does not judge the sign: that is the aggregate’s check', () => {
    expect(countsAsSpending(tx({ amountCents: 5000 }))).toBe(true)
  })
})

describe('isYearMonth', () => {
  it.each(['2026-10', '2026-01', '2026-12', '1000-01', '9999-12'])(
    'accepts %j',
    (value) => {
      expect(isYearMonth(value)).toBe(true)
    },
  )

  it.each([
    '2026-13',
    '2026-00',
    '2026-1',
    '0999-01',
    '',
    '20261',
    '2026-10-01',
    ' 2026-10',
  ])('rejects %j', (value) => {
    expect(isYearMonth(value)).toBe(false)
  })

  it('rejects what is not text', () => {
    expect(isYearMonth(202610)).toBe(false)
    expect(isYearMonth(['2026-10'])).toBe(false)
    expect(isYearMonth(undefined)).toBe(false)
  })
})

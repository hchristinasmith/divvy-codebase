// Drawings (prd-02 Ruling 15, issue #264): the matcher and the effective-
// category overlay in shared/drawings.ts. Every id, date and amount below
// is invented. Dates are NZ calendar dates, as the server hands them over;
// the instant-to-NZ-date step (and so the NZ-midnight straddle) is tested
// against the database in server/db/__tests__/drawings.test.ts.
//
// Done-when mapping (issue #264):
// - DW1 "a strawb outflow of 30000 and a personal inflow of 30000 a day
//   later are both Drawings": `pairs a strawb outflow with the equal
//   personal inflow a day later (DW1)`.
// - DW3 "unmatched, and a 1-cent mismatch, are not drawings": the `(DW3)`
//   cases.
// - DW4 "a row categorised by hand keeps its category": the
//   `effectiveCategory` `(DW4)` cases.
// - DW5 "personal→strawb is not a drawing": the `(DW5)` case.
// - DW7 "pure-function tests with integer-cent fixtures": this file.

import { describe, expect, it } from 'vitest'

import {
  DRAWING_DAYS_AFTER,
  DRAWING_DAYS_BEFORE,
  DRAWINGS_CATEGORY,
  effectiveCategory,
  findDrawingIds,
  isDrawingCategory,
  type DrawingCandidate,
} from '../drawings.ts'

const out = (id: number, date: string, cents = 30000): DrawingCandidate => ({
  id,
  scope: 'strawb',
  date,
  amountCents: -cents,
})
const into = (id: number, date: string, cents = 30000): DrawingCandidate => ({
  id,
  scope: 'personal',
  date,
  amountCents: cents,
})

const ids = (candidates: DrawingCandidate[]): number[] =>
  [...findDrawingIds(candidates)].sort((a, b) => a - b)

describe('the window and the category name', () => {
  it('is one NZ day before to three after, and the category is Drawings', () => {
    expect(DRAWING_DAYS_BEFORE).toBe(1)
    expect(DRAWING_DAYS_AFTER).toBe(3)
    expect(DRAWINGS_CATEGORY).toBe('Drawings')
  })
})

describe('findDrawingIds: what is a pair', () => {
  it('pairs a strawb outflow with the equal personal inflow a day later (DW1)', () => {
    expect(ids([out(1, '2026-10-27'), into(2, '2026-10-28')])).toStrictEqual([
      1, 2,
    ])
  })

  it('answers a Set holding both halves', () => {
    const result = findDrawingIds([out(1, '2026-10-27'), into(2, '2026-10-28')])
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(2)
  })

  it.each<[string, DrawingCandidate[]]>([
    ['an unmatched strawb outflow (DW3)', [out(1, '2026-10-27')]],
    [
      'a personal inflow 1 cent short (DW3)',
      [out(1, '2026-10-27'), into(2, '2026-10-28', 29999)],
    ],
    [
      'a personal inflow 1 cent over (DW3)',
      [out(1, '2026-10-27'), into(2, '2026-10-28', 30001)],
    ],
    [
      'a personal outflow and an equal strawb inflow: money put in (DW5)',
      [
        { id: 1, scope: 'personal', date: '2026-10-27', amountCents: -30000 },
        { id: 2, scope: 'strawb', date: '2026-10-28', amountCents: 30000 },
      ],
    ],
    [
      'strawb to strawb',
      [
        out(1, '2026-10-27'),
        { id: 2, scope: 'strawb', date: '2026-10-28', amountCents: 30000 },
      ],
    ],
    [
      'personal to personal',
      [
        { id: 1, scope: 'personal', date: '2026-10-27', amountCents: -30000 },
        into(2, '2026-10-28'),
      ],
    ],
    [
      'two strawb outflows and no inflow',
      [out(1, '2026-10-27'), out(2, '2026-10-28')],
    ],
    [
      'zero-amount rows',
      [
        { id: 1, scope: 'strawb', date: '2026-10-27', amountCents: 0 },
        { id: 2, scope: 'personal', date: '2026-10-27', amountCents: 0 },
      ],
    ],
    ['nothing at all', []],
  ])('finds no drawing in %s', (_why, candidates) => {
    expect(ids(candidates)).toStrictEqual([])
  })
})

describe('findDrawingIds: the window, in NZ calendar days', () => {
  it.each<[string, string, boolean]>([
    ['on the same day', '2026-10-27', true],
    ['3 days after (the last day in)', '2026-10-30', true],
    ['4 days after (the first day out)', '2026-10-31', false],
    ['1 day before (the last day in)', '2026-10-26', true],
    ['2 days before (the first day out)', '2026-10-25', false],
  ])('an inflow %s the outflow is a pair: %s', (_why, inDate, paired) => {
    expect(ids([out(1, '2026-10-27'), into(2, inDate)])).toStrictEqual(
      paired ? [1, 2] : [],
    )
  })

  it('counts across a month end, a year end and 29 February', () => {
    expect(ids([out(1, '2026-10-31'), into(2, '2026-11-03')])).toStrictEqual([
      1, 2,
    ])
    expect(ids([out(1, '2026-12-30'), into(2, '2027-01-02')])).toStrictEqual([
      1, 2,
    ])
    // 2028 is a leap year: 28 Feb to 2 Mar is 3 days.
    expect(ids([out(1, '2028-02-28'), into(2, '2028-03-02')])).toStrictEqual([
      1, 2,
    ])
    // 2027 is not: 28 Feb to 4 Mar is 4 days.
    expect(ids([out(1, '2027-02-28'), into(2, '2027-03-04')])).toStrictEqual([])
  })

  it.each<[string, string, string]>([
    // 2000 is a leap year: divisible by 400, though also by 100.
    ['29 February 2000', '2000-02-29', '2000-03-01'],
    // A two-digit year is accepted as written. Date.UTC would read it as
    // 1950 and still find this pair; the next row is the one it fails.
    ['a date in the year 0050', '0050-03-01', '0050-03-02'],
    // Read by Date.UTC as 1999 and the year 100, these are centuries apart.
    ['the end of the year 0099', '0099-12-31', '0100-01-01'],
  ])('accepts %s as a calendar date', (_why, outDate, inDate) => {
    expect(ids([out(1, outDate), into(2, inDate)])).toStrictEqual([1, 2])
  })

  it('weekly equal draws seven days apart never cross-match', () => {
    // Tuesdays, each arriving 3 days later. A cross-match would need a gap
    // of 7 − 3 = 4 or 7 + 3 = 10 days.
    const candidates = [
      out(1, '2026-10-06'),
      out(2, '2026-10-13'),
      out(3, '2026-10-20'),
      into(11, '2026-10-09'),
      into(12, '2026-10-16'),
      into(13, '2026-10-23'),
    ]
    expect(ids(candidates)).toStrictEqual([1, 2, 3, 11, 12, 13])
    // Dropping the middle inflow leaves the middle outflow unmatched.
    expect(ids(candidates.filter((c) => c.id !== 12))).toStrictEqual([
      1, 3, 11, 13,
    ])
  })
})

describe('findDrawingIds: one-to-one, greedy, fixed tie-breaks', () => {
  it('two outflows, one inflow: the smaller gap wins', () => {
    // Gaps: 1 → 10 is +1, 2 → 10 is 0.
    expect(
      ids([out(1, '2026-10-27'), out(2, '2026-10-28'), into(10, '2026-10-28')]),
    ).toStrictEqual([2, 10])
  })

  it('two outflows, one inflow, equal |gap|: the inflow after the outflow wins', () => {
    // Gaps: 1 → 10 is +1, 2 → 10 is −1.
    expect(
      ids([out(1, '2026-10-27'), out(2, '2026-10-29'), into(10, '2026-10-28')]),
    ).toStrictEqual([1, 10])
    // The same with the ids swapped, so the id order cannot be what decides.
    expect(
      ids([out(2, '2026-10-27'), out(1, '2026-10-29'), into(10, '2026-10-28')]),
    ).toStrictEqual([2, 10])
  })

  it('one outflow, two inflows at equal |gap|: the inflow after wins, whatever the ids', () => {
    // Gaps: 1 → 10 is −1, 1 → 11 is +1. The out date and out id are the
    // same for both, and 10 is the lower in id, so only the sign rule picks
    // 11.
    expect(
      ids([
        out(1, '2026-10-28'),
        into(10, '2026-10-27'),
        into(11, '2026-10-29'),
      ]),
    ).toStrictEqual([1, 11])
  })

  it('two outflows on one day, one inflow: the lower outflow id wins', () => {
    expect(
      ids([out(5, '2026-10-27'), out(3, '2026-10-27'), into(10, '2026-10-28')]),
    ).toStrictEqual([3, 10])
  })

  it('one outflow, two inflows on one day: the lower inflow id wins', () => {
    expect(
      ids([
        out(1, '2026-10-27'),
        into(12, '2026-10-28'),
        into(11, '2026-10-28'),
      ]),
    ).toStrictEqual([1, 11])
  })

  it('two equal drawings in one week are both found, each half used once', () => {
    // Gaps: 1 → 10 +1, 1 → 11 +3, 2 → 10 −1, 2 → 11 +1. The two +1 pairs are
    // taken; the −1 and +3 pairs then find a half already used.
    expect(
      ids([
        out(1, '2026-10-27'),
        out(2, '2026-10-29'),
        into(10, '2026-10-28'),
        into(11, '2026-10-30'),
      ]),
    ).toStrictEqual([1, 2, 10, 11])
  })

  it('a third outflow with no inflow left stays a charge', () => {
    expect(
      ids([
        out(1, '2026-10-27'),
        out(2, '2026-10-27'),
        out(3, '2026-10-27'),
        into(10, '2026-10-28'),
        into(11, '2026-10-28'),
      ]),
    ).toStrictEqual([1, 2, 10, 11])
  })

  it('pairs only equal amounts, even when another amount sits closer', () => {
    expect(
      ids([
        out(1, '2026-10-27', 30000),
        out(2, '2026-10-27', 45000),
        into(10, '2026-10-27', 45000),
        into(11, '2026-10-30', 30000),
      ]),
    ).toStrictEqual([1, 2, 10, 11])
  })

  it('gives the same answer whatever order the rows come in', () => {
    const candidates: DrawingCandidate[] = [
      out(1, '2026-10-27'),
      out(2, '2026-10-28'),
      out(3, '2026-10-28'),
      out(4, '2026-10-30'),
      out(5, '2026-10-27', 12345),
      into(10, '2026-10-28'),
      into(11, '2026-10-29'),
      into(12, '2026-10-27'),
      into(13, '2026-10-28', 12345),
      into(14, '2026-10-29', 12345),
      { id: 20, scope: 'personal', date: '2026-10-28', amountCents: -30000 },
      { id: 21, scope: 'strawb', date: '2026-10-28', amountCents: 30000 },
    ]
    // Worked by hand, gap = in date − out date, in window −1 to +3.
    //   30000: 1 (27th) → 12 is 0, → 10 +1, → 11 +2; 2 and 3 (28th) → 10
    //   are 0, → 11 +1, → 12 −1; 4 (30th) → 11 is −1. 12345: 5 → 13 +1,
    //   → 14 +2. Rows 20 and 21 run the other way and are never halves.
    // Taken in order: 1 ↔ 12 (gap 0, earliest out), 2 ↔ 10 (gap 0, lower
    //   id than 3); 3 → 10 and 1 → 10 find 10 used; 5 ↔ 13 (+1); 2 → 11
    //   finds 2 used, so 3 ↔ 11 (+1); 4 → 11 (−1) finds 11 used. Left: 4
    //   and 14.
    const expected = [1, 2, 3, 5, 10, 11, 12, 13]
    expect(ids(candidates)).toStrictEqual(expected)

    // A fixed-seed shuffle (mulberry32), so a failure is reproducible.
    let seed = 0x2645
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let round = 0; round < 50; round += 1) {
      const shuffled = [...candidates]
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      expect(ids(shuffled)).toStrictEqual(expected)
    }
  })
})

describe('findDrawingIds: refusals', () => {
  it.each<[string, DrawingCandidate[], ErrorConstructor, string]>([
    [
      'a fractional amount',
      [{ ...out(1, '2026-10-27'), amountCents: -300.5 }],
      TypeError,
      'amountCents of candidate 1 must be an integer number of cents',
    ],
    [
      'a NaN amount',
      [{ ...into(1, '2026-10-27'), amountCents: Number.NaN }],
      TypeError,
      'amountCents of candidate 1 must be an integer number of cents',
    ],
    [
      'a date that is not a calendar date',
      [out(1, '2026-02-30')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      'a date with month 00',
      [out(1, '2026-00-10')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      'a date with month 13',
      [out(1, '2026-13-01')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      'a date with day 00',
      [out(1, '2026-10-00')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      '31 November',
      [out(1, '2026-11-31')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      '29 February 1900, a century that is not a leap year',
      [out(1, '1900-02-29')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      'a date with a time',
      [into(1, '2026-10-27T00:00:00Z')],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
    [
      'an id that appears twice',
      [out(1, '2026-10-27'), into(1, '2026-10-28')],
      RangeError,
      'candidate 1 appears twice',
    ],
    [
      'an id that is not a whole number',
      [out(1.5, '2026-10-27')],
      RangeError,
      'a candidate id must be a safe integer',
    ],
    [
      'a scope that is not personal or strawb',
      [{ ...out(1, '2026-10-27'), scope: 'all' as 'strawb' }],
      RangeError,
      'scope of candidate 1 must be personal or strawb',
    ],
    [
      'a bad date on a row that could never be a half',
      [{ id: 1, scope: 'personal', date: 'yesterday', amountCents: -100 }],
      RangeError,
      'date of candidate 1 must be a YYYY-MM-DD calendar date',
    ],
  ])('refuses %s', (_why, candidates, type, message) => {
    const run = () => findDrawingIds(candidates)
    expect(run).toThrow(type)
    expect(run).toThrow(message)
  })
})

describe('isDrawingCategory', () => {
  it('is Drawings exactly', () => {
    expect(isDrawingCategory('Drawings')).toBe(true)
    expect(isDrawingCategory('drawings')).toBe(false)
    expect(isDrawingCategory('Drawings ')).toBe(false)
    expect(isDrawingCategory(null)).toBe(false)
  })
})

describe('effectiveCategory', () => {
  it('a half of a drawing shows Drawings, set by rule (DW1)', () => {
    const shown = effectiveCategory(
      { category: null, categorySource: 'akahu' },
      true,
    )
    expect(Object.keys(shown).sort()).toStrictEqual([
      'category',
      'categorySource',
    ])
    expect(shown).toStrictEqual({
      category: 'Drawings',
      categorySource: 'rule',
    })
  })

  it.each(['akahu', 'rule', 'claude'] as const)(
    'Drawings wins over a category set by %s',
    (categorySource) => {
      expect(
        effectiveCategory({ category: 'Software', categorySource }, true),
      ).toStrictEqual({ category: 'Drawings', categorySource: 'rule' })
    },
  )

  it('a half Hannah categorised by hand keeps her category (DW4)', () => {
    expect(
      effectiveCategory(
        { category: 'Contractors', categorySource: 'user' },
        true,
      ),
    ).toStrictEqual({ category: 'Contractors', categorySource: 'user' })
  })

  it('a row that is not a half keeps its own category and source', () => {
    expect(
      effectiveCategory(
        { category: 'Software', categorySource: 'akahu' },
        false,
      ),
    ).toStrictEqual({ category: 'Software', categorySource: 'akahu' })
    expect(
      effectiveCategory({ category: null, categorySource: 'akahu' }, false),
    ).toStrictEqual({ category: null, categorySource: 'akahu' })
    // Drawings Hannah set on an unmatched row stays hers.
    expect(
      effectiveCategory(
        { category: 'Drawings', categorySource: 'user' },
        false,
      ),
    ).toStrictEqual({ category: 'Drawings', categorySource: 'user' })
  })
})

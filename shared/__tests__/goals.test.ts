// A goal's pace (prd-02, issue #50; Hannah's decision 0d881e4c, option A:
// what is needed per month to hit the by-date). Every expected figure is
// worked by hand and written as a literal; none is computed by the code
// under test, except in the property loop, which checks the rounding rule
// itself rather than a figure. Amounts are invented, in integer cents.

import { describe, expect, it } from 'vitest'

import { goalPace, monthsUntil } from '../goals.ts'

const TODAY = '2026-10-25'

describe('monthsUntil', () => {
  it.each([
    // Exactly a month: one.
    ['2026-11-25', 1],
    // A day past a whole month starts the next one.
    ['2026-11-26', 2],
    ['2026-11-24', 1],
    ['2026-12-24', 2],
    // Tomorrow is a partial month, counted whole.
    ['2026-10-26', 1],
    // Today, earlier this month and last month: one, never zero or less.
    ['2026-10-25', 1],
    ['2026-10-01', 1],
    ['2026-09-01', 1],
    ['2027-10-25', 12],
    ['2027-10-26', 13],
  ])(`from ${TODAY} to %s is %i`, (target, months) => {
    expect(monthsUntil(TODAY, target)).toBe(months)
  })

  it.each([
    // Across a year end.
    ['2026-12-31', '2027-01-01', 1],
    // Into a shorter month: the 28th is before the 31st, so no extra month.
    ['2026-01-31', '2026-02-28', 1],
    ['2026-01-31', '2026-03-01', 2],
  ])('from %s to %s is %i', (today, target, months) => {
    expect(monthsUntil(today, target)).toBe(months)
  })

  it.each([
    ['a short month', TODAY, '2026-1-01'],
    ['a timestamp', TODAY, '2026-11-01T00:00:00Z'],
    ['month 13', TODAY, '2026-13-01'],
    ['day 0', TODAY, '2026-11-00'],
    ['a malformed today', '25/10/2026', '2026-11-01'],
  ])('refuses %s with a RangeError', (_why, today, target) => {
    expect(() => monthsUntil(today, target)).toThrow(RangeError)
  })
})

describe('goalPace', () => {
  // Three months out from TODAY: 25 January.
  const THREE_MONTHS = '2027-01-25'

  it('splits what is left evenly when it divides', () => {
    expect(
      goalPace({
        targetCents: 120000,
        savedCents: 0,
        targetDate: THREE_MONTHS,
        today: TODAY,
      }),
    ).toStrictEqual({ paceCents: 40000, monthsToGo: 3 })
  })

  it('rounds up once when it does not: 100000 over 3 is 33334', () => {
    expect(
      goalPace({
        targetCents: 100000,
        savedCents: 0,
        targetDate: THREE_MONTHS,
        today: TODAY,
      }),
    ).toStrictEqual({ paceCents: 33334, monthsToGo: 3 })
  })

  it('one cent left over twelve months is one cent a month', () => {
    expect(
      goalPace({
        targetCents: 50001,
        savedCents: 50000,
        targetDate: '2027-10-25',
        today: TODAY,
      }),
    ).toStrictEqual({ paceCents: 1, monthsToGo: 12 })
  })

  it.each([
    ['saved equals the target', 80000, 80000, THREE_MONTHS],
    ['saved is over the target', 80000, 95000, THREE_MONTHS],
    ['funded with no target date', 80000, 80000, null],
    ['overfunded with no target date', 80000, 80001, null],
  ])('%s: funded, 0 and 0', (_why, targetCents, savedCents, targetDate) => {
    expect(
      goalPace({ targetCents, savedCents, targetDate, today: TODAY }),
    ).toStrictEqual({ paceCents: 0, monthsToGo: 0 })
  })

  it('an unfunded goal with no target date has no pace', () => {
    expect(
      goalPace({
        targetCents: 80000,
        savedCents: 100,
        targetDate: null,
        today: TODAY,
      }),
    ).toStrictEqual({ paceCents: null, monthsToGo: null })
  })

  it('the largest target due within the month is all of it now', () => {
    expect(
      goalPace({
        targetCents: 1_000_000_000,
        savedCents: 0,
        targetDate: '2026-11-25',
        today: TODAY,
      }),
    ).toStrictEqual({ paceCents: 1_000_000_000, monthsToGo: 1 })
  })

  it('every pace is the smallest whole cent that covers what is left', () => {
    const REMAINING = [1, 2, 3, 7, 11, 99, 100, 101, 33333, 100000, 999999937]
    for (const remaining of REMAINING) {
      for (let months = 1; months <= 30; months += 1) {
        // `months` months out from 2026-10-25, built without the code
        // under test: (10 + months - 1) months past January, on the 25th.
        const index = 10 + months - 1
        const year = 2026 + Math.floor(index / 12)
        const month = (index % 12) + 1
        const targetDate = `${year}-${String(month).padStart(2, '0')}-25`
        const pace = goalPace({
          targetCents: remaining + 500,
          savedCents: 500,
          targetDate,
          today: TODAY,
        })
        expect(pace.monthsToGo, targetDate).toBe(months)
        const p = pace.paceCents
        if (p === null) throw new Error('an unfunded dated goal had no pace')
        expect(Number.isSafeInteger(p)).toBe(true)
        expect(p * months >= remaining, `${remaining}/${months}`).toBe(true)
        expect((p - 1) * months < remaining, `${remaining}/${months}`).toBe(
          true,
        )
      }
    }
  })

  it.each([
    ['a fractional target', { targetCents: 100.5, savedCents: 0 }],
    ['a fractional saved', { targetCents: 100, savedCents: 0.5 }],
    ['a zero target', { targetCents: 0, savedCents: 0 }],
    ['a negative target', { targetCents: -100, savedCents: 0 }],
    ['a negative saved', { targetCents: 100, savedCents: -1 }],
    ['an unsafe target', { targetCents: 2 ** 53, savedCents: 0 }],
    ['an unsafe saved', { targetCents: 100, savedCents: 2 ** 53 }],
    ['a NaN target', { targetCents: Number.NaN, savedCents: 0 }],
  ])('refuses %s with a RangeError', (_why, amounts) => {
    expect(() =>
      goalPace({ ...amounts, targetDate: THREE_MONTHS, today: TODAY }),
    ).toThrow(RangeError)
  })

  it('refuses a malformed target date on an unfunded goal', () => {
    expect(() =>
      goalPace({
        targetCents: 100,
        savedCents: 0,
        targetDate: '2027-1-25',
        today: TODAY,
      }),
    ).toThrow(RangeError)
  })
})

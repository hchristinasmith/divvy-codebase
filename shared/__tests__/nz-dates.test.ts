import { describe, expect, it } from 'vitest'
import {
  addDaysIso,
  billOccurrencesThrough,
  nzCalendarDate,
} from '../nz-dates.ts'

// Calendar dates (#233). Every value below is invented.

describe('nzCalendarDate', () => {
  it('reads the date in Pacific/Auckland, not UTC', () => {
    // 23:30 UTC on the 27th is 12:30 NZDT on the 28th.
    expect(nzCalendarDate(new Date('2026-10-27T23:30:00Z'))).toBe('2026-10-28')
    // NZST in winter (UTC+12): 12:30 UTC on 30 June is 00:30 on 1 July.
    expect(nzCalendarDate(new Date('2026-06-30T12:30:00Z'))).toBe('2026-07-01')
    // Just before NZ midnight stays on the NZ day.
    expect(nzCalendarDate(new Date('2026-10-26T10:59:00Z'))).toBe('2026-10-26')
    expect(nzCalendarDate(new Date('2026-10-26T11:00:00Z'))).toBe('2026-10-27')
  })

  it('refuses an invalid Date with a RangeError and a fixed text, echoing no value', () => {
    const run = () => nzCalendarDate(new Date('not a date'))
    expect(run).toThrow(RangeError)
    expect(run).toThrow(/^date is not a valid instant$/)
  })

  it('pads a year before 1000 to four digits', () => {
    // Midday in NZ on 15 June in the year 50. Only the year is pinned: the
    // formatter's calendar before 1582 is not one this module chose.
    const at = new Date(0)
    at.setUTCFullYear(50, 5, 15)
    at.setUTCHours(1)
    expect(nzCalendarDate(at)).toMatch(/^0050-\d{2}-\d{2}$/)
  })
})

describe('billOccurrencesThrough', () => {
  const bill = (
    repeat: 'none' | 'weekly' | 'monthly' | 'yearly',
    first: string,
  ) => ({
    repeat,
    first_due_date: first,
  })

  it('weekly: every seventh day from the anchor, through the date given', () => {
    expect(
      billOccurrencesThrough(bill('weekly', '2026-10-07'), '2026-11-03'),
    ).toStrictEqual(['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28'])
  })

  it('weekly: an occurrence on `through` is included, one the day after is not', () => {
    expect(
      billOccurrencesThrough(bill('weekly', '2026-10-14'), '2026-10-28'),
    ).toStrictEqual(['2026-10-14', '2026-10-21', '2026-10-28'])
    expect(
      billOccurrencesThrough(bill('weekly', '2026-10-14'), '2026-10-27'),
    ).toStrictEqual(['2026-10-14', '2026-10-21'])
  })

  it.each(['none', 'weekly', 'monthly', 'yearly'] as const)(
    '%s: an anchor on `through` is the only occurrence; one after it gives none',
    (repeat) => {
      expect(
        billOccurrencesThrough(bill(repeat, '2026-10-30'), '2026-10-30'),
      ).toStrictEqual(['2026-10-30'])
      expect(
        billOccurrencesThrough(bill(repeat, '2026-10-31'), '2026-10-30'),
      ).toStrictEqual([])
    },
  )

  it('monthly on the 31st clamps to each shorter month and returns to the 31st (no drift)', () => {
    expect(
      billOccurrencesThrough(bill('monthly', '2026-01-31'), '2026-05-31'),
    ).toStrictEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ])
  })

  it('monthly on the 31st falls on 29 February in a leap year', () => {
    expect(
      billOccurrencesThrough(bill('monthly', '2028-01-31'), '2028-03-01'),
    ).toStrictEqual(['2028-01-31', '2028-02-29'])
  })

  it('monthly crosses the year end', () => {
    expect(
      billOccurrencesThrough(bill('monthly', '2026-11-15'), '2027-02-15'),
    ).toStrictEqual(['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15'])
  })

  it('yearly on 29 February falls on 28 February outside leap years', () => {
    expect(
      billOccurrencesThrough(bill('yearly', '2028-02-29'), '2032-03-01'),
    ).toStrictEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ])
  })

  it('none: the anchor alone, however far `through` reaches', () => {
    expect(
      billOccurrencesThrough(bill('none', '2026-10-20'), '2027-10-20'),
    ).toStrictEqual(['2026-10-20'])
  })

  it('a far-reaching expansion stays ascending and has no repeats', () => {
    for (const repeat of ['weekly', 'monthly', 'yearly'] as const) {
      const dates = billOccurrencesThrough(
        bill(repeat, '2024-01-31'),
        '2030-12-31',
      )
      expect(new Set(dates).size, repeat).toBe(dates.length)
      expect([...dates].sort(), repeat).toStrictEqual(dates)
      for (const d of dates) expect(d, repeat).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('years 0 to 99 are not read as 1900 to 1999', () => {
    expect(
      billOccurrencesThrough(bill('weekly', '0050-12-28'), '0051-01-04'),
    ).toStrictEqual(['0050-12-28', '0051-01-04'])
  })

  it('refuses a `through` that is not a calendar date, though the anchor is one', () => {
    // A numeric `through`: one the loop's string comparison still ends on.
    const run = () =>
      billOccurrencesThrough(bill('weekly', '2026-10-07'), '2026-13-01')
    expect(run).toThrow(RangeError)
    expect(run).toThrow(/^a bill date is not a YYYY-MM-DD calendar date$/)
  })

  it('refuses a repeat it does not know rather than returning no occurrences', () => {
    const run = () =>
      billOccurrencesThrough(
        { repeat: 'daily' as never, first_due_date: '2026-10-07' },
        '2026-10-30',
      )
    expect(run).toThrow(RangeError)
    expect(run).toThrow(/^a bill has an unknown repeat$/)
  })
})

describe('addDaysIso', () => {
  // The weekly cases above only move forward. The overview moves back a day
  // from the last payday to open its spending window (server/db/overview.ts).
  it('moves back across a month and a year end', () => {
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysIso('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDaysIso('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('refuses a date that is not a calendar date, echoing no value', () => {
    const run = () => addDaysIso('2026-02-30', -1)
    expect(run).toThrow(RangeError)
    expect(run).toThrow(/^a bill date is not a YYYY-MM-DD calendar date$/)
  })

  it.each([
    ['2026-10-00', 'day 0'],
    ['2026-00-10', 'month 0'],
    ['2026-13-01', 'month 13'],
    ['2026-10-30x', 'text after the date'],
    ['x2026-10-30', 'text before the date'],
    ['2026-4-30', 'a one-digit month'],
    ['', 'nothing'],
  ])('refuses %s (%s), echoing no value', (value) => {
    const run = () => addDaysIso(value, 0)
    expect(run).toThrow(RangeError)
    expect(run).toThrow(/^a bill date is not a YYYY-MM-DD calendar date$/)
  })

  it('refuses a move past 9999 or before 0000, echoing no value', () => {
    const after = () => addDaysIso('9999-12-31', 1)
    expect(after).toThrow(RangeError)
    expect(after).toThrow(/^a bill date falls outside the years 0000 to 9999$/)
    const before = () => addDaysIso('0000-01-01', -1)
    expect(before).toThrow(RangeError)
    expect(before).toThrow(/^a bill date falls outside the years 0000 to 9999$/)
  })
})

import { describe, expect, it } from 'vitest'
import { monthLabel, nzMonth, shiftMonth } from '../month.ts'

// The Spending screen's month picker (issue 272).

describe('nzMonth', () => {
  it('is the NZ month, which runs ahead of UTC', () => {
    // 11:30 UTC on 31 October is 00:30 on 1 November in NZ (UTC+13).
    expect(nzMonth(new Date('2026-10-31T11:30:00.000Z'))).toBe('2026-11')
    expect(nzMonth(new Date('2026-10-31T10:59:00.000Z'))).toBe('2026-10')
  })
})

describe('shiftMonth', () => {
  it.each([
    ['2026-10', -1, '2026-09'],
    ['2026-10', 1, '2026-11'],
    ['2026-01', -1, '2025-12'],
    ['2026-12', 1, '2027-01'],
    ['2026-03', -1, '2026-02'],
  ])('%s by %i is %s', (month, by, expected) => {
    expect(shiftMonth(month, by)).toBe(expected)
  })
})

describe('monthLabel', () => {
  it.each([
    ['2026-10', 'October 2026'],
    ['2027-01', 'January 2027'],
  ])('%s is %s', (month, label) => {
    expect(monthLabel(month)).toBe(label)
  })
})

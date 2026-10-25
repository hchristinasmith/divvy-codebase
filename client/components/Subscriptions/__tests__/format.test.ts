import { describe, expect, it } from 'vitest'
import { formatDay } from '../format.ts'

// The Subscriptions' display helpers: labels, never money. This file pins
// `formatDay`, the copy of the Overview's date label.

// The "today" the same-year cases are checked against.
const TODAY = '2026-10-28'

describe('formatDay', () => {
  it('reads the day and month from the string', () => {
    expect(formatDay('2026-11-28', TODAY)).toBe('28 Nov')
    expect(formatDay('2026-01-05', TODAY)).toBe('5 Jan')
    expect(formatDay('2026-12-31', TODAY)).toBe('31 Dec')
  })

  it('returns anything that is not a calendar date unchanged', () => {
    expect(formatDay('28/11/2026', TODAY)).toBe('28/11/2026')
    expect(formatDay('2026-13-01', TODAY)).toBe('2026-13-01')
    expect(formatDay('2026-11-00', TODAY)).toBe('2026-11-00')
    expect(formatDay('', TODAY)).toBe('')
  })
})

describe('formatDay appends the year when the date is not in today\'s year', () => {
  const NOW = '2026-06-15'

  it('leaves the year off the dates in the same year, at both ends of it', () => {
    expect(formatDay('2026-01-01', NOW)).toBe('1 Jan')
    expect(formatDay('2026-12-31', NOW)).toBe('31 Dec')
  })

  it('appends the year to the last day of the year before and the first day after', () => {
    expect(formatDay('2025-12-31', NOW)).toBe('31 Dec 2025')
    expect(formatDay('2027-01-01', NOW)).toBe('1 Jan 2027')
  })

  it('appends the year to a date just before 1 Jan when today is 1 Jan', () => {
    expect(formatDay('2025-12-31', '2026-01-01')).toBe('31 Dec 2025')
  })

  it('appends the year to a date just after 31 Dec when today is 31 Dec', () => {
    expect(formatDay('2026-01-01', '2025-12-31')).toBe('1 Jan 2026')
  })

  it('shows the year when today is not a calendar date', () => {
    expect(formatDay('2026-11-28', '')).toBe('28 Nov 2026')
    expect(formatDay('2026-11-28', '28/10/2026')).toBe('28 Nov 2026')
  })

  it('still returns anything that is not a calendar date unchanged, with a today given', () => {
    expect(formatDay('28/11/2026', '2025-06-15')).toBe('28/11/2026')
    expect(formatDay('', '2025-06-15')).toBe('')
  })
})

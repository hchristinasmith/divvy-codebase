import { describe, expect, it } from 'vitest'
import { barPercent, formatDay, formatRate } from '../format.ts'

// The Overview's display helpers: labels and bar widths, never money.

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
    expect(formatDay('2025-12-31', NOW)).toBe('31 Dec\u00a02025')
    expect(formatDay('2027-01-01', NOW)).toBe('1 Jan\u00a02027')
  })

  it('appends the year to a date just before 1 Jan when today is 1 Jan', () => {
    expect(formatDay('2025-12-31', '2026-01-01')).toBe('31 Dec\u00a02025')
  })

  it('appends the year to a date just after 31 Dec when today is 31 Dec', () => {
    expect(formatDay('2026-01-01', '2025-12-31')).toBe('1 Jan\u00a02026')
  })

  it('shows the year when today is not a calendar date', () => {
    expect(formatDay('2026-11-28', '')).toBe('28 Nov\u00a02026')
    expect(formatDay('2026-11-28', '28/10/2026')).toBe('28 Nov\u00a02026')
  })

  it('joins the year with a non-breaking space and the day and month with a plain one', () => {
    // So a year never wraps onto its own line in a narrow column.
    const label = formatDay('2025-12-31', NOW)
    expect(label.charAt(6)).toBe('\u00a0')
    expect(label.charAt(2)).toBe(' ')
  })

  it('still returns anything that is not a calendar date unchanged, with a today given', () => {
    expect(formatDay('28/11/2026', '2025-06-15')).toBe('28/11/2026')
    expect(formatDay('', '2025-06-15')).toBe('')
  })
})

describe('formatRate', () => {
  it('shows whole percentages without a decimal', () => {
    expect(formatRate(2500)).toBe('25%')
    expect(formatRate(0)).toBe('0%')
  })

  it('shows only the decimals a rate has', () => {
    expect(formatRate(1050)).toBe('10.5%')
    expect(formatRate(1005)).toBe('10.05%')
  })
})

describe('barPercent', () => {
  it('is the floored share of the whole', () => {
    expect(barPercent(1, 3)).toBe(33)
    expect(barPercent(2, 3)).toBe(66)
    expect(barPercent(555000, 850000)).toBe(65)
  })

  it('reads 100 only when the part has reached the whole', () => {
    // Rounding gave 100 for 299999 of 300000 (99.99966 → 100), a full bar
    // on a goal one cent short of its target.
    expect(barPercent(299999, 300000)).toBe(99)
    expect(barPercent(300000, 300000)).toBe(100)
  })

  it('does not drop a whole percent to floating-point error', () => {
    // (29 / 50) * 100 is 57.99999999999999 in floating point; 29 of 50 is 58%.
    expect(barPercent(29, 50)).toBe(58)
    expect(barPercent(57, 100)).toBe(57)
  })

  it('clamps to 0 and 100', () => {
    expect(barPercent(-4250, 10000)).toBe(0)
    expect(barPercent(30000, 10000)).toBe(100)
  })

  it('is 0 when the whole is not positive', () => {
    expect(barPercent(500, 0)).toBe(0)
    expect(barPercent(500, -100)).toBe(0)
  })
})

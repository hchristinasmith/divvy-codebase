import { describe, expect, it } from 'vitest'
import { barPercent, formatDay, formatRate } from '../format.ts'

// The Overview's display helpers: labels and bar widths, never money.

describe('formatDay', () => {
  it('reads the day and month from the string', () => {
    expect(formatDay('2026-11-28')).toBe('28 Nov')
    expect(formatDay('2026-01-05')).toBe('5 Jan')
    expect(formatDay('2026-12-31')).toBe('31 Dec')
  })

  it('returns anything that is not a calendar date unchanged', () => {
    expect(formatDay('28/11/2026')).toBe('28/11/2026')
    expect(formatDay('2026-13-01')).toBe('2026-13-01')
    expect(formatDay('2026-11-00')).toBe('2026-11-00')
    expect(formatDay('')).toBe('')
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
  it('is the rounded share of the whole', () => {
    expect(barPercent(1, 3)).toBe(33)
    expect(barPercent(2, 3)).toBe(67)
    expect(barPercent(555000, 850000)).toBe(65)
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

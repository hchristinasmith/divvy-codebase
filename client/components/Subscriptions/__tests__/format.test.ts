import { describe, expect, it } from 'vitest'
import { formatDay } from '../format.ts'

// The Subscriptions' display helpers: labels, never money. This file pins
// `formatDay`, the copy of the Overview's date label.

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

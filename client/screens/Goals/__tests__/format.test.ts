import { describe, expect, it } from 'vitest'
import { formatByDate, monthsLabel, paceLine } from '../format.ts'
import { goal } from './fixtures.ts'

describe('formatByDate', () => {
  it('names the month and year from the string, not a Date', () => {
    expect(formatByDate('2027-11-15')).toBe('by Nov 2027')
    expect(formatByDate('2027-01-01')).toBe('by Jan 2027')
    expect(formatByDate('2099-12-31')).toBe('by Dec 2099')
  })

  it('shows anything that is not a calendar date as it came', () => {
    expect(formatByDate('2027-13-01')).toBe('by 2027-13-01')
    expect(formatByDate('2027-00-01')).toBe('by 2027-00-01')
    expect(formatByDate('soon')).toBe('by soon')
  })
})

describe('monthsLabel', () => {
  it('says month in the singular for one', () => {
    expect(monthsLabel(1)).toBe('1 month')
    expect(monthsLabel(2)).toBe('2 months')
    expect(monthsLabel(14)).toBe('14 months')
  })
})

describe('paceLine', () => {
  it("shows the route's pace and months to go", () => {
    expect(paceLine(goal({ paceCents: 9000, monthsToGo: 20 }))).toBe(
      '$90.00/mo · 20 months to go',
    )
    expect(paceLine(goal({ paceCents: 123457, monthsToGo: 1 }))).toBe(
      '$1,234.57/mo · 1 month to go',
    )
  })

  it('says funded once saved reaches the target, exactly or over', () => {
    expect(
      paceLine(goal({ savedCents: 300000, targetCents: 300000, paceCents: 0, monthsToGo: 0 })),
    ).toBe('Funded.')
    expect(
      paceLine(
        goal({ savedCents: 300001, targetCents: 300000, targetDate: null, paceCents: 0, monthsToGo: 0 }),
      ),
    ).toBe('Funded.')
  })

  it('is not funded a cent short', () => {
    expect(
      paceLine(goal({ savedCents: 299999, targetCents: 300000, paceCents: 1, monthsToGo: 1 })),
    ).toBe('$0.01/mo · 1 month to go')
  })

  it('has no pace without a by-date', () => {
    expect(
      paceLine(goal({ targetDate: null, paceCents: null, monthsToGo: null })),
    ).toBe('No by-date')
  })
})

import { describe, expect, it } from 'vitest'
import { budgetTone, isNearLimit, paydaySubtitle, statusLabel } from '../format.ts'
import { budget } from './fixtures.ts'

// The Budgets screen's display helpers (issue 53). Every value is invented,
// in integer cents.

describe('isNearLimit', () => {
  it('is true only past 80% of the limit, compared in whole cents', () => {
    expect(isNearLimit(8000, 10000)).toBe(false)
    expect(isNearLimit(8001, 10000)).toBe(true)
    // 80.4%: past 80, though a rounded percentage would read 80.
    expect(isNearLimit(4020, 5000)).toBe(true)
    expect(isNearLimit(10000, 10000)).toBe(true)
  })

  it('is false for a limit of 0 with nothing spent', () => {
    expect(isNearLimit(0, 0)).toBe(false)
  })
})

describe('budgetTone', () => {
  it('is over whenever the route says overCents > 0', () => {
    expect(budgetTone(budget({ limitCents: 5000, spentCents: 6230, remainingCents: 0, overCents: 1230 }))).toBe('over')
  })

  it('is near at the limit with nothing over, and left below 80%', () => {
    expect(budgetTone(budget({ limitCents: 5000, spentCents: 5000, remainingCents: 0, overCents: 0 }))).toBe('near')
    expect(budgetTone(budget({ limitCents: 15000, spentCents: 4520, remainingCents: 10480, overCents: 0 }))).toBe('left')
  })
})

describe('statusLabel', () => {
  it("formats the route's over or remaining field", () => {
    expect(statusLabel(budget({ remainingCents: 0, overCents: 1230 }))).toBe('$12.30 over')
    expect(statusLabel(budget({ remainingCents: 10480, overCents: 0 }))).toBe('$104.80 left')
    expect(statusLabel(budget({ remainingCents: 0, overCents: 0 }))).toBe('$0.00 left')
  })
})

describe('paydaySubtitle', () => {
  const period = { periodStart: '2026-10-27', periodEnd: '2026-11-03' }

  it('uses the days it is given over the period', () => {
    expect(paydaySubtitle(4, period)).toBe('Resets on payday · 4 days left')
    expect(paydaySubtitle(1, period)).toBe('Resets on payday · 1 day left')
  })

  it("falls back to the period's end, with a year only across one", () => {
    expect(paydaySubtitle(undefined, period)).toBe('Resets on payday · 3 Nov')
    expect(
      paydaySubtitle(undefined, { periodStart: '2026-12-29', periodEnd: '2027-01-05' }),
    ).toBe('Resets on payday · 5 Jan 2027')
    expect(paydaySubtitle(undefined, undefined)).toBe('Resets on payday')
  })
})

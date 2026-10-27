import { describe, expect, it } from 'vitest'
import {
  REPEAT_LABELS,
  REPEAT_OPTIONS,
  dateTileParts,
  metaLine,
  nextOneLabel,
  rowTone,
  scopeLabel,
  toRepeat,
} from '../format.ts'
import { bill } from './fixtures.ts'

// The Bills screen's display helpers (issue 54). Every value is invented.

describe('the repeat choices', () => {
  it('are exactly the schema values, in the order the select shows them', () => {
    expect([...REPEAT_OPTIONS]).toEqual(['none', 'weekly', 'monthly', 'yearly'])
    expect(Object.keys(REPEAT_LABELS).sort()).toEqual([...REPEAT_OPTIONS].sort())
    expect(REPEAT_OPTIONS.map((option) => REPEAT_LABELS[option])).toEqual([
      'One-off',
      'Weekly',
      'Monthly',
      'Yearly',
    ])
  })

  it('reads a select value back only when it is one of them', () => {
    expect(toRepeat('weekly')).toBe('weekly')
    expect(toRepeat('fortnightly')).toBeNull()
    expect(toRepeat('')).toBeNull()
  })
})

describe('metaLine', () => {
  it.each([
    ['none', 'Personal · Test Everyday · One-off'],
    ['weekly', 'Personal · Test Everyday · Weekly'],
    ['monthly', 'Personal · Test Everyday · Monthly'],
    ['yearly', 'Personal · Test Everyday · Yearly'],
  ] as const)('names the scope, the account and %s', (repeat, line) => {
    expect(metaLine(bill({ repeat }))).toBe(line)
  })

  it('leaves out an account the bill has none of, and says Strawb', () => {
    expect(metaLine(bill({ scope: 'strawb', accountName: null, repeat: 'none' }))).toBe(
      'Strawb · One-off',
    )
    expect(scopeLabel('personal')).toBe('Personal')
  })
})

describe('dateTileParts', () => {
  it('splits a date into day and month', () => {
    expect(dateTileParts('2026-11-28')).toEqual({ day: '28', month: 'Nov' })
    expect(dateTileParts('2027-01-05')).toEqual({ day: '5', month: 'Jan' })
  })

  it('shows anything that is not a calendar date as it came', () => {
    expect(dateTileParts('soon')).toEqual({ day: 'soon', month: '' })
    expect(dateTileParts('2026-13-01')).toEqual({ day: '2026-13-01', month: '' })
  })
})

describe('nextOneLabel', () => {
  it('is None when nothing is due', () => {
    expect(nextOneLabel(null)).toBe('None')
  })

  it("is the bill's amount and due day", () => {
    expect(nextOneLabel(bill({ amountCents: 120000, dueDate: '2026-11-01' }))).toBe(
      '$1,200.00 · 1 Nov',
    )
  })

  it('shows no year, even for a bill due in another year', () => {
    expect(nextOneLabel(bill({ amountCents: 120000, dueDate: '2027-01-05' }))).toBe(
      '$1,200.00 · 5 Jan',
    )
  })
})

describe('rowTone', () => {
  it('marks the first two unpaid rows as next and the rest as later', () => {
    expect(rowTone(bill(), 0)).toBe('next')
    expect(rowTone(bill(), 1)).toBe('next')
    expect(rowTone(bill(), 2)).toBe('later')
  })

  it('marks a paid row as paid wherever it sits', () => {
    expect(rowTone(bill({ paid: true, repeat: 'none' }), 0)).toBe('paid')
    expect(rowTone(bill({ paid: true, repeat: 'none' }), 5)).toBe('paid')
  })
})

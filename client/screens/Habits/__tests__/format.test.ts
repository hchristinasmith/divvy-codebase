import { describe, expect, it } from 'vitest'
import {
  UNBOUNDED_RUNWAY,
  formatRunway,
  runwayNote,
  streakValue,
  verdictMeta,
  verdictSummary,
} from '../format.ts'
import { nextVerdict } from '../fields.ts'
import { verdictRow } from './fixtures.ts'

describe('formatRunway', () => {
  it("writes the route's tenths with one decimal place", () => {
    expect(formatRunway(78)).toBe('7.8')
    expect(formatRunway(77)).toBe('7.7')
    expect(formatRunway(120)).toBe('12.0')
    expect(formatRunway(1234)).toBe('123.4')
  })

  it('keeps a leading zero under one month', () => {
    expect(formatRunway(5)).toBe('0.5')
    expect(formatRunway(0)).toBe('0.0')
  })

  it('keeps the sign of a negative figure', () => {
    expect(formatRunway(-5)).toBe('-0.5')
    expect(formatRunway(-78)).toBe('-7.8')
  })

  it('shows unbounded runway as the infinity sign, with a note saying why', () => {
    expect(formatRunway(null)).toBe(UNBOUNDED_RUNWAY)
    expect(UNBOUNDED_RUNWAY).toBe('∞')
    expect(runwayNote(null)).toBe(
      'No spending in the last month, so there is nothing to divide by yet.',
    )
    expect(runwayNote(78)).toBe(
      "months you could live with zero income, at this month's spending.",
    )
  })
})

describe('streakValue', () => {
  it('says day in the singular for one', () => {
    expect(streakValue(0)).toBe('0 days')
    expect(streakValue(1)).toBe('1 day')
    expect(streakValue(58)).toBe('58 days')
  })
})

describe('verdictSummary', () => {
  it('counts each verdict from the rows', () => {
    expect(
      verdictSummary([
        verdictRow({ transactionId: '1', verdict: 'not_really' }),
        verdictRow({ transactionId: '2', verdict: 'not_really' }),
        verdictRow({ transactionId: '3', verdict: 'worth_it' }),
        verdictRow({ transactionId: '4', verdict: null }),
      ]),
    ).toBe('2 not worth it · 1 worth it')
    expect(verdictSummary([verdictRow({ verdict: 'worth_it' })])).toBe(
      '0 not worth it · 1 worth it',
    )
  })

  it('says untagged when no row has a verdict, or there are none', () => {
    expect(verdictSummary([verdictRow()])).toBe('Untagged')
    expect(verdictSummary([])).toBe('Untagged')
  })
})

describe('verdictMeta', () => {
  it('is the category, the signed amount and the day', () => {
    expect(verdictMeta(verdictRow())).toBe('Groceries · -$1,280.00 · 20 Oct')
  })

  it('leaves out a missing category', () => {
    expect(verdictMeta(verdictRow({ category: null, amountCents: -64000 }))).toBe(
      '-$640.00 · 20 Oct',
    )
  })
})

describe('nextVerdict', () => {
  it('sets the tapped verdict when it is not the current one', () => {
    expect(nextVerdict(null, 'worth_it')).toBe('worth_it')
    expect(nextVerdict(null, 'not_really')).toBe('not_really')
    expect(nextVerdict('not_really', 'worth_it')).toBe('worth_it')
    expect(nextVerdict('worth_it', 'not_really')).toBe('not_really')
  })

  it('clears it when the tapped verdict is already set', () => {
    expect(nextVerdict('worth_it', 'worth_it')).toBeNull()
    expect(nextVerdict('not_really', 'not_really')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  LIMIT_FLOOR_CENTS,
  LIMIT_STEP_CENTS,
  canStepDown,
  checkDraft,
  emptyDraft,
  stepLimit,
} from '../fields.ts'

// The Budgets screen's input edge (issue 53). Every value is invented, in
// integer cents.

describe('stepLimit', () => {
  it('moves by $10 in integer cents', () => {
    expect(LIMIT_STEP_CENTS).toBe(1000)
    expect(stepLimit(15000, 'up')).toBe(16000)
    expect(stepLimit(15000, 'down')).toBe(14000)
    expect(stepLimit(0, 'up')).toBe(1000)
  })

  it('never steps down under $10', () => {
    expect(LIMIT_FLOOR_CENTS).toBe(1000)
    expect(stepLimit(1500, 'down')).toBe(1000)
    expect(stepLimit(1000, 'down')).toBe(1000)
  })

  it('offers a step down only above the floor', () => {
    expect(canStepDown(1001)).toBe(true)
    expect(canStepDown(1000)).toBe(false)
    expect(canStepDown(0)).toBe(false)
  })
})

describe('checkDraft', () => {
  it('turns typed dollars into cents through the Settings parser', () => {
    const body = checkDraft({ ...emptyDraft('strawb'), category: 'Bakeries', limit: '1,200.50' })
    expect(body).toEqual({ scope: 'strawb', category: 'Bakeries', limitCents: 120050 })
    expect(Object.keys(body).sort()).toEqual(['category', 'limitCents', 'scope'])
  })

  it('allows a limit of 0, as the server does', () => {
    expect(checkDraft({ ...emptyDraft('personal'), category: 'Bakeries', limit: '0' })).toEqual({
      scope: 'personal',
      category: 'Bakeries',
      limitCents: 0,
    })
  })

  it('sends a trimmed note, and no note key for a blank one', () => {
    const draft = { ...emptyDraft('personal'), category: 'Bakeries', limit: '40' }
    expect(checkDraft({ ...draft, note: '  Invented  ' })).toEqual({
      scope: 'personal',
      category: 'Bakeries',
      limitCents: 4000,
      note: 'Invented',
    })
    expect('note' in checkDraft({ ...draft, note: '   ' })).toBe(false)
  })

  it('refuses a missing category and a limit that is not dollars', () => {
    expect(checkDraft(emptyDraft('personal'))).toEqual({
      errors: { category: 'Choose a category', limit: 'Required' },
    })
    expect(
      checkDraft({ ...emptyDraft('personal'), category: 'Bakeries', limit: '1.005' }),
    ).toEqual({ errors: { limit: 'Enter dollars and cents, like 1049.99' } })
    expect(
      checkDraft({ ...emptyDraft('personal'), category: 'Bakeries', limit: '-5' }),
    ).toEqual({ errors: { limit: 'Must be 0 or more' } })
  })
})

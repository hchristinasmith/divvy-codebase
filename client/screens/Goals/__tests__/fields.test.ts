import { describe, expect, it } from 'vitest'
import { checkDraft, emptyDraft, type Draft } from '../fields.ts'

function draft(fields: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(), name: 'Sample Car', target: '1500', ...fields }
}

const REQUEST_KEYS = ['name', 'targetCents', 'targetDate']

describe('checkDraft', () => {
  it('starts empty', () => {
    expect(emptyDraft()).toEqual({ name: '', target: '', targetDate: '' })
  })

  it('turns typed dollars into integer cents by the Settings parser', () => {
    const cases: [string, number][] = [
      ['1500', 150000],
      ['1,500.50', 150050],
      ['$12.5', 1250],
      ['0.01', 1],
      ['10000000', 1_000_000_000],
    ]
    for (const [target, cents] of cases) {
      const checked = checkDraft(draft({ target }))
      expect(checked).toEqual({
        request: { name: 'Sample Car', targetCents: cents, targetDate: null },
      })
    }
  })

  it('always sends the by-date key: null when empty, as typed otherwise', () => {
    const empty = checkDraft(draft())
    if (!('request' in empty)) throw new Error('refused')
    expect(Object.keys(empty.request).sort()).toEqual(REQUEST_KEYS)
    expect(empty.request.targetDate).toBeNull()

    const dated = checkDraft(draft({ targetDate: '2027-03-15' }))
    if (!('request' in dated)) throw new Error('refused')
    expect(Object.keys(dated.request).sort()).toEqual(REQUEST_KEYS)
    expect(dated.request.targetDate).toBe('2027-03-15')
  })

  it('trims the name', () => {
    const checked = checkDraft(draft({ name: '  Sample Car  ' }))
    expect(checked).toEqual({
      request: { name: 'Sample Car', targetCents: 150000, targetDate: null },
    })
  })

  it('needs a name and a target', () => {
    expect(checkDraft(emptyDraft())).toEqual({
      errors: { name: 'Required', target: 'Required' },
    })
    expect(checkDraft(draft({ name: '   ' }))).toEqual({
      errors: { name: 'Required' },
    })
  })

  it('refuses a name longer than the server takes', () => {
    expect(checkDraft(draft({ name: 'x'.repeat(255) }))).toHaveProperty('request')
    expect(checkDraft(draft({ name: 'x'.repeat(256) }))).toEqual({
      errors: { name: 'At most 255 characters' },
    })
  })

  it('refuses a target of nothing, a negative one, too many decimals, or over the cap', () => {
    expect(checkDraft(draft({ target: '0' }))).toEqual({
      errors: { target: 'Must be more than 0' },
    })
    expect(checkDraft(draft({ target: '-5' }))).toEqual({
      errors: { target: 'Must be 0 or more' },
    })
    expect(checkDraft(draft({ target: '12.345' }))).toEqual({
      errors: { target: 'Enter dollars and cents, like 1049.99' },
    })
    expect(checkDraft(draft({ target: '10000000.01' }))).toEqual({
      errors: { target: 'At most $10,000,000.00' },
    })
  })

  it('refuses a by-date that is not a date or outside 2000 to 2099', () => {
    expect(checkDraft(draft({ targetDate: '15/03/2027' }))).toEqual({
      errors: { targetDate: 'Enter a date, like 2027-03-15' },
    })
    expect(checkDraft(draft({ targetDate: '1999-12-31' }))).toEqual({
      errors: { targetDate: 'Pick a date from 2000 to 2099' },
    })
    expect(checkDraft(draft({ targetDate: '2100-01-01' }))).toEqual({
      errors: { targetDate: 'Pick a date from 2000 to 2099' },
    })
    expect(checkDraft(draft({ targetDate: '2000-01-01' }))).toHaveProperty('request')
    expect(checkDraft(draft({ targetDate: '2099-12-31' }))).toHaveProperty('request')
  })

  it('reports every wrong field at once', () => {
    expect(
      checkDraft({ name: '', target: 'lots', targetDate: '2100-01-01' }),
    ).toEqual({
      errors: {
        name: 'Required',
        target: 'Enter dollars and cents, like 1049.99',
        targetDate: 'Pick a date from 2000 to 2099',
      },
    })
  })
})

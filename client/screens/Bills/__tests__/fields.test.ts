import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_DEFAULT,
  ACCOUNT_DETACH,
  billPatch,
  checkDraft,
  createRequest,
  draftFromBill,
  emptyDraft,
  type Draft,
  type ParsedDraft,
} from '../fields.ts'
import { bill } from './fixtures.ts'

// The bill form's input edge (issue 54): typed text to integer cents, and
// the request bodies built from it. Every value is invented, in integer
// cents.

const DRAFT_KEYS = ['account', 'amount', 'firstDueDate', 'name', 'repeat', 'scope']
const CREATE_KEYS = ['amountCents', 'firstDueDate', 'name', 'repeat', 'scope']

function draft(fields: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft('personal'),
    name: 'Invented Water',
    amount: '45.50',
    firstDueDate: '2026-11-15',
    ...fields,
  }
}

function parsed(d: Draft): ParsedDraft {
  const result = checkDraft(d)
  if ('errors' in result) throw new Error(JSON.stringify(result.errors))
  return result
}

describe('emptyDraft and draftFromBill', () => {
  it('starts an add form blank, in the scope given, with no account', () => {
    const start = emptyDraft('strawb')
    expect(Object.keys(start).sort()).toEqual(DRAFT_KEYS)
    expect(start).toEqual({
      name: '',
      amount: '',
      firstDueDate: '',
      repeat: 'none',
      scope: 'strawb',
      account: ACCOUNT_DEFAULT,
    })
  })

  it('starts an edit form from the bill, the amount as dollars', () => {
    const start = draftFromBill(
      bill({ amountCents: 120050, firstDueDate: '2026-09-30', repeat: 'yearly' }),
    )
    expect(Object.keys(start).sort()).toEqual(DRAFT_KEYS)
    expect(start).toEqual({
      name: 'Invented Power Co',
      amount: '1200.50',
      firstDueDate: '2026-09-30',
      repeat: 'yearly',
      scope: 'personal',
      account: ACCOUNT_DEFAULT,
    })
  })
})

describe('checkDraft', () => {
  it('reads a typed amount as integer cents', () => {
    const result = parsed(draft({ amount: '1,200.50', name: '  Invented Water  ' }))
    expect(result).toEqual({
      name: 'Invented Water',
      amountCents: 120050,
      firstDueDate: '2026-11-15',
    })
    expect(Number.isInteger(result.amountCents)).toBe(true)
    expect(parsed(draft({ amount: '0.01' })).amountCents).toBe(1)
  })

  it.each([
    ['', 'Required'],
    ['abc', 'Enter dollars and cents, like 1049.99'],
    ['12.345', 'Enter dollars and cents, like 1049.99'],
    ['0', 'Must be more than 0'],
    ['0.00', 'Must be more than 0'],
    ['-5', 'Must be 0 or more'],
  ])('refuses the amount %j', (amount, message) => {
    expect(checkDraft(draft({ amount }))).toEqual({ errors: { amount: message } })
  })

  it('refuses a blank name and a missing date, alongside the amount', () => {
    expect(checkDraft(draft({ name: '   ', firstDueDate: '', amount: '' }))).toEqual({
      errors: { name: 'Required', amount: 'Required', firstDueDate: 'Required' },
    })
  })
})

describe('createRequest', () => {
  it('sends the five fields and no account when none was chosen', () => {
    const d = draft({ repeat: 'weekly' })
    const body = createRequest(parsed(d), d)
    expect(Object.keys(body).sort()).toEqual(CREATE_KEYS)
    expect('accountId' in body).toBe(false)
    expect(body).toEqual({
      scope: 'personal',
      name: 'Invented Water',
      amountCents: 4550,
      firstDueDate: '2026-11-15',
      repeat: 'weekly',
    })
  })

  it('adds the chosen account as its string id', () => {
    const d = draft({ scope: 'strawb', account: '3' })
    const body = createRequest(parsed(d), d)
    expect(Object.keys(body).sort()).toEqual([...CREATE_KEYS, 'accountId'].sort())
    expect(body.accountId).toBe('3')
    expect(body.scope).toBe('strawb')
  })
})

describe('billPatch', () => {
  const current = bill({
    name: 'Invented Power Co',
    amountCents: 120000,
    firstDueDate: '2026-10-01',
    repeat: 'monthly',
  })

  function patchFor(fields: Partial<Draft>) {
    const d = { ...draftFromBill(current), ...fields }
    return billPatch(current, parsed(d), d)
  }

  it('is empty when nothing changed, even if the text did', () => {
    expect(patchFor({})).toEqual({})
    expect(patchFor({ amount: '1200', name: ' Invented Power Co ' })).toEqual({})
  })

  it('sends only the amount when only the amount changed', () => {
    const patch = patchFor({ amount: '1250.00' })
    expect(Object.keys(patch)).toEqual(['amountCents'])
    expect(patch.amountCents).toBe(125000)
  })

  it('sends each changed field and never the scope', () => {
    const patch = patchFor({
      name: 'Invented Power Ltd',
      firstDueDate: '2026-10-02',
      repeat: 'yearly',
    })
    expect(Object.keys(patch).sort()).toEqual(['firstDueDate', 'name', 'repeat'])
    expect(patch).toEqual({
      name: 'Invented Power Ltd',
      firstDueDate: '2026-10-02',
      repeat: 'yearly',
    })
  })

  it('keeps the account unsaid, detaches it as null, or names the new one', () => {
    expect('accountId' in patchFor({ account: ACCOUNT_DEFAULT })).toBe(false)
    expect(patchFor({ account: ACCOUNT_DETACH })).toEqual({ accountId: null })
    expect(patchFor({ account: '2' })).toEqual({ accountId: '2' })
  })
})

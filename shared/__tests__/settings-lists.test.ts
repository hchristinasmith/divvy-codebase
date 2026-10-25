import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_ROLES,
  CURRENCY_SYMBOLS,
  type AccountRole,
  type CurrencySymbol,
} from '../contracts.ts'

// issue 46: the runtime lists the settings route validates against and the
// settings panel offers, tied to their types. A member added to a type
// without being added here fails tsc (the Record literal lacks a key); a
// member missing from a list fails the key-set test.
const ROLES: Record<AccountRole, true> = {
  current: true,
  savings: true,
  tax_pot: true,
  credit_card: true,
}
const SYMBOLS: Record<CurrencySymbol, true> = {
  $: true,
  NZ$: true,
  '£': true,
}

describe('ACCOUNT_ROLES', () => {
  it('holds every AccountRole, in display order', () => {
    expect([...ACCOUNT_ROLES]).toEqual(['current', 'savings', 'tax_pot', 'credit_card'])
    expect([...ACCOUNT_ROLES].sort()).toEqual(Object.keys(ROLES).sort())
  })

  it('has no duplicates', () => {
    expect(new Set(ACCOUNT_ROLES).size).toBe(ACCOUNT_ROLES.length)
  })
})

describe('CURRENCY_SYMBOLS', () => {
  it('holds every CurrencySymbol, in display order', () => {
    expect([...CURRENCY_SYMBOLS]).toEqual(['$', 'NZ$', '£'])
    expect([...CURRENCY_SYMBOLS].sort()).toEqual(Object.keys(SYMBOLS).sort())
  })

  it('has no duplicates', () => {
    expect(new Set(CURRENCY_SYMBOLS).size).toBe(CURRENCY_SYMBOLS.length)
  })
})

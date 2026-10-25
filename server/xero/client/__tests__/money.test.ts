import { describe, expect, it } from 'vitest'

import { xeroAmountToCents } from '../money.ts'

// Issue #34 done-when 1: the conversion table, and refusal of every shape
// Xero does not send. The inputs are strings because `parseXeroJson` never
// lets an amount become a number (see json.test.ts).

describe('xeroAmountToCents', () => {
  it.each([
    ['19.99', 1999],
    ['0.10', 10],
    ['1234567.89', 123456789],
    ['-5.5', -550],
    ['0', 0],
  ])('converts %s to %i cents exactly', (raw, cents) => {
    expect(xeroAmountToCents(raw)).toBe(cents)
  })

  it.each([
    ['0.1', 10],
    ['100', 10000],
    ['-0.01', -1],
    ['8.00', 800],
  ])('converts %s to %i cents', (raw, cents) => {
    expect(xeroAmountToCents(raw)).toBe(cents)
  })

  it('is exact where a float conversion is a cent out', () => {
    // Math.round(parseFloat('85541708717991.35') * 100) is 8554170871799134.
    expect(xeroAmountToCents('85541708717991.35')).toBe(8554170871799135)
  })

  it('turns "-0" and "-0.00" into plain 0, not -0', () => {
    expect(Object.is(xeroAmountToCents('-0'), 0)).toBe(true)
    expect(Object.is(xeroAmountToCents('-0.00'), 0)).toBe(true)
  })

  // "$5" and "1,000" are accepted by shared parseDollars (what a person
  // types); only this guard refuses them, so these rows go red without it.
  // Leading zeros: the old loose pattern let these through to parseDollars.
  it.each([
    '1e2',
    '$5',
    '1,000',
    '19.999',
    '',
    'abc',
    '1.',
    '.5',
    '+5',
    ' 5',
    '007.50',
    '0019.99',
  ])('refuses %j, which is not an amount Xero sends', (raw) => {
    expect(() => xeroAmountToCents(raw)).toThrow(/is not a Xero amount/)
  })

  // Out of range is not a shape: the shared reader throws a TypeError from
  // parseDollars (the class shared's own test pins; the wording is shared's),
  // not this file's shape RangeError, and nothing rounds or zeroes it.
  it('throws for an amount too large to be exact in cents, rather than zeroing it', () => {
    expect(() => xeroAmountToCents('123456789012345678.99')).toThrow(TypeError)
  })
})

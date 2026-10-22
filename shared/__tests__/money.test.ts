import { describe, expect, it } from 'vitest'
import {
  dollarsToCents,
  formatCents,
  parseDollars,
  sumCents,
} from '../money.ts'

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [550, '$5.50'],
    [-550, '-$5.50'],
    [100000, '$1,000.00'],
    [123456789, '$1,234,567.89'],
    [-99, '-$0.99'],
  ])('%i → %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text)
  })

  it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %s, which is not integer cents',
    (bad) => {
      expect(() => formatCents(bad)).toThrow(/integer number of cents/)
    },
  )
})

describe('dollarsToCents', () => {
  it.each([
    [0, 0],
    [-0, 0],
    [4250, 425000],
    [-64.37, -6437],
    [0.1 + 0.2, 30],
    [1.005, 101],
    [-1.005, -101],
    [19.99, 1999],
    [-18.99, -1899],
  ])('%d → %i', (dollars, cents) => {
    expect(Object.is(dollarsToCents(dollars), cents)).toBe(true)
  })

  it('refuses a non-finite amount', () => {
    expect(() => dollarsToCents(NaN)).toThrow(/finite/)
    expect(() => dollarsToCents(Infinity)).toThrow(/finite/)
  })
})

describe('parseDollars', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.05', 1205],
    ['$1,234.56', 123456],
    ['  -4.20 ', -420],
    ['-$0.99', -99],
    ['-0', 0],
    ['0.00', 0],
  ])('"%s" → %i', (text, cents) => {
    expect(Object.is(parseDollars(text), cents)).toBe(true)
  })

  it.each(['', 'abc', '1.234', '1,23', '12,', '$', '1.', '--1', '1e3'])(
    'refuses "%s"',
    (bad) => {
      expect(() => parseDollars(bad)).toThrow(/is not a dollar amount/)
    },
  )

  it('round-trips with formatCents', () => {
    for (const cents of [0, 7, -7, 1999, -123456, 100000001]) {
      expect(parseDollars(formatCents(cents))).toBe(cents)
    }
  })
})

describe('sumCents', () => {
  it('adds integer cents exactly where float dollars drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(sumCents([10, 20])).toBe(30)
    expect(sumCents([])).toBe(0)
    expect(sumCents([-6437, 425000, -550])).toBe(418013)
  })

  it('refuses a float input', () => {
    expect(() => sumCents([100, 0.5])).toThrow(/sumCents input/)
  })

  it('refuses a total beyond safe-integer range', () => {
    expect(() =>
      sumCents([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]),
    ).toThrow(/sumCents result/)
  })
})

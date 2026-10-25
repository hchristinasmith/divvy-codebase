import { describe, expect, it } from 'vitest'
import {
  basisPointsToPercentField,
  centsToDollarsField,
  parseDollarsField,
  parsePercentField,
} from '../fields.ts'

// The settings panel's input edge (issue 46): typed text to integer cents
// and basis points, exactly. The float traps are the point: 1.15 * 100 is
// 114.99999999999999 and 19.99 * 100 is 1998.9999999999998.

describe('parseDollarsField', () => {
  it.each([
    ['1049.99', 104999],
    ['1.15', 115],
    ['19.99', 1999],
    ['1,500.50', 150050],
    ['0', 0],
    [' 12.5 ', 1250],
  ])('reads %j as %i cents', (input, cents) => {
    expect(parseDollarsField(input)).toStrictEqual({ value: cents })
  })

  it('refuses empty input rather than reading it as 0', () => {
    expect(parseDollarsField('')).toStrictEqual({ error: 'Required' })
    expect(parseDollarsField('   ')).toStrictEqual({ error: 'Required' })
  })

  it('refuses a negative amount', () => {
    expect(parseDollarsField('-5')).toStrictEqual({
      error: 'Must be 0 or more',
    })
  })

  it.each(['abc', '12.345', '1e3', '1.2.3'])('refuses %j', (input) => {
    expect(parseDollarsField(input)).toStrictEqual({
      error: 'Enter dollars and cents, like 1049.99',
    })
  })

  it.each([
    [104999, '1049.99'],
    [0, '0.00'],
    [150050, '1500.50'],
  ])('shows %i cents as %j, which reads back the same', (cents, text) => {
    expect(centsToDollarsField(cents)).toBe(text)
    expect(parseDollarsField(text)).toStrictEqual({ value: cents })
  })
})

describe('parsePercentField', () => {
  it.each([
    ['25', 2500],
    ['25%', 2500],
    ['10.5', 1050],
    ['10.05', 1005],
    ['1.15', 115],
    ['19.99', 1999],
    ['0.29', 29],
    ['0.01', 1],
    ['0', 0],
    ['100', 10000],
    [' 28 % ', 2800],
  ])('reads %j as %i basis points', (input, bp) => {
    expect(parsePercentField(input)).toStrictEqual({ value: bp })
  })

  it('refuses empty input', () => {
    expect(parsePercentField('')).toStrictEqual({ error: 'Required' })
    expect(parsePercentField('%')).toStrictEqual({ error: 'Required' })
  })

  it.each(['abc', '12.345', '-5', '1e3', '1000', '.5'])(
    'refuses %j',
    (input) => {
      expect(parsePercentField(input)).toStrictEqual({
        error: 'Enter a percentage, like 25 or 10.5',
      })
    },
  )

  it.each(['101', '100.01'])('refuses %j as over 100%', (input) => {
    expect(parsePercentField(input)).toStrictEqual({
      error: 'Must be 100% or less',
    })
  })

  it.each([
    [2500, '25'],
    [1050, '10.5'],
    [1005, '10.05'],
    [1, '0.01'],
    [0, '0'],
    [10000, '100'],
  ])('shows %i basis points as %j, which reads back the same', (bp, text) => {
    expect(basisPointsToPercentField(bp)).toBe(text)
    expect(parsePercentField(text)).toStrictEqual({ value: bp })
  })
})

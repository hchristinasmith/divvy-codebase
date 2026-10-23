import { describe, expect, it } from 'vitest'

import { parseXeroJson, readCount } from '../json.ts'
import { XeroClientError } from '../errors.ts'

// Issue #34 done-when 1: no amount passes through a float. parseXeroJson
// hands every number literal back as its source text.

describe('parseXeroJson', () => {
  it('keeps every number literal as its exact text', () => {
    expect(
      parseXeroJson(
        '{"a": 1234567.89, "b": -5.5, "c": 0.10, "d": [0, 19.99], "e": 1e2}',
      ),
    ).toEqual({
      a: '1234567.89',
      b: '-5.5',
      c: '0.10',
      d: ['0', '19.99'],
      e: '1e2',
    })
  })

  it('keeps a digit-heavy amount that a double cannot hold', () => {
    // 0.1 + 0.2 style drift would show here as ...0000001 or ...9999999.
    expect(parseXeroJson('[90071992547409.93]')).toEqual(['90071992547409.93'])
  })

  it('leaves numbers inside strings untouched', () => {
    expect(parseXeroJson('{"Reference": "PO 42, 3.5 hours"}')).toEqual({
      Reference: 'PO 42, 3.5 hours',
    })
  })

  it('does not end a string at an escaped quote', () => {
    expect(
      parseXeroJson('{"Name": "Rimu \\"12\\" Store", "Total": 7.25}'),
    ).toEqual({
      Name: 'Rimu "12" Store',
      Total: '7.25',
    })
  })

  it('handles an escaped backslash right before a closing quote', () => {
    expect(parseXeroJson('{"Path": "C:\\\\", "n": 3}')).toEqual({
      Path: 'C:\\',
      n: '3',
    })
  })

  it('leaves true, false and null alone', () => {
    expect(parseXeroJson('{"a": true, "b": false, "c": null}')).toEqual({
      a: true,
      b: false,
      c: null,
    })
  })

  it('throws on a body that is not JSON', () => {
    expect(() => parseXeroJson('<Response><Invoices/></Response>')).toThrow(
      SyntaxError,
    )
  })
})

describe('readCount', () => {
  it('reads a whole number', () => {
    expect(readCount('12', 'pageCount')).toBe(12)
  })

  it.each(['1.5', '-1', '1e3', ''])('refuses %j as bad_response', (raw) => {
    expect(() => readCount(raw, 'pageCount')).toThrow(XeroClientError)
  })
})

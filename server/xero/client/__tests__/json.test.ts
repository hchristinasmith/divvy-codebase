import { describe, expect, it } from 'vitest'

import { readCount } from '../json.ts'
import { XeroClientError } from '../errors.ts'

// The exact-text reader (`parseExactJson`, which http.ts calls on every Xero
// body) is tested once, in shared/__tests__/exact-json.test.ts (#135). This
// file pins `readCount`, the reader for Xero's page counts.

describe('readCount', () => {
  it('reads a whole number', () => {
    expect(readCount('12', 'pageCount')).toBe(12)
  })

  it.each(['1.5', '-1', '1e3', ''])('refuses %j as bad_response', (raw) => {
    expect(() => readCount(raw, 'pageCount')).toThrow(XeroClientError)
  })
})

import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { fromThisSite, parseScope } from '../http.ts'

// Only the headers fromThisSite reads are built. The cast makes a fake of
// those headers; it does not claim to be a whole Express request.
function request(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request
}

const HOST = 'divvy.example.ts.net:3005'

describe('fromThisSite', () => {
  it.each([
    ['same-origin', true],
    ['none', true],
    ['same-site', false],
    ['cross-site', false],
  ])('Sec-Fetch-Site %s answers %s', (site, expected) => {
    expect(fromThisSite(request({ 'sec-fetch-site': site, host: HOST }))).toBe(
      expected,
    )
  })

  it('passes a request with neither Sec-Fetch-Site nor Origin (curl)', () => {
    expect(fromThisSite(request({ host: HOST }))).toBe(true)
  })

  it('passes an Origin that names this host', () => {
    expect(
      fromThisSite(
        request({ host: '127.0.0.1:3005', origin: 'http://127.0.0.1:3005' }),
      ),
    ).toBe(true)
  })

  it('compares the Host header case-insensitively', () => {
    expect(
      fromThisSite(
        request({
          host: 'Divvy.Example:3005',
          origin: 'https://divvy.example:3005',
        }),
      ),
    ).toBe(true)
  })

  it('refuses an Origin that names another host', () => {
    expect(
      fromThisSite(request({ host: HOST, origin: 'https://evil.example' })),
    ).toBe(false)
  })

  it('refuses an Origin when the request has no Host', () => {
    expect(fromThisSite(request({ origin: 'http://127.0.0.1:3005' }))).toBe(
      false,
    )
  })

  it('refuses Origin: null (a sandboxed frame or a file: page)', () => {
    expect(fromThisSite(request({ host: HOST, origin: 'null' }))).toBe(false)
  })
})

describe('parseScope', () => {
  it.each(['all', 'personal', 'strawb'])('passes %s through', (scope) => {
    expect(parseScope(scope)).toBe(scope)
  })

  it.each(['', 'ALL', 'business', ' strawb', 'all '])('refuses %j', (raw) => {
    expect(parseScope(raw)).toBeNull()
  })

  it('refuses an absent scope', () => {
    expect(parseScope(undefined)).toBeNull()
  })

  it('refuses a repeated scope', () => {
    expect(parseScope(['personal', 'strawb'])).toBeNull()
  })
})

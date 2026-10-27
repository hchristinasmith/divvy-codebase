import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'

import { fromThisSite, parseId, parseScope, writableId } from '../http.ts'

// Only the headers fromThisSite reads are built. The cast makes a fake of
// those headers; it does not claim to be a whole Express request.
function request(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request
}

// The headers writableId reads, plus the one path parameter it takes.
function writeRequest(
  headers: Record<string, string | undefined>,
  id: string,
): Request {
  return { headers, params: { id } } as unknown as Request
}

// A fake that records what was sent. Only status() and json() are built,
// the two calls writableId makes.
function response(): {
  res: Response
  sent: { status?: number; body?: unknown }
} {
  const sent: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      sent.status = code
      return this
    },
    json(body: unknown) {
      sent.body = body
    },
  }
  return { res: res as unknown as Response, sent }
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

describe('parseId', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('passes %j as %i', (raw, expected) => {
    expect(parseId(raw)).toBe(expected)
  })

  // Number() would take most of these; the digit check and the safe-integer
  // check are what refuse them.
  it.each([
    '0',
    '-1',
    '1e3',
    '0x10',
    ' 7',
    '7 ',
    '01',
    '1.5',
    '',
    '9007199254740992',
  ])('refuses %j', (raw) => {
    expect(parseId(raw)).toBeNull()
  })
})

describe('writableId', () => {
  it('refuses a cross-site write with 403 and answers null', () => {
    const { res, sent } = response()
    const id = writableId(
      writeRequest({ 'sec-fetch-site': 'cross-site', host: HOST }, '7'),
      res,
    )
    expect(id).toBeNull()
    expect(sent.status).toBe(403)
    expect(Object.keys(sent.body as Record<string, unknown>).sort()).toEqual([
      'error',
    ])
    expect(sent.body).toEqual({ error: 'Forbidden' })
  })

  it('checks the site before the id, so a cross-site bad id is a 403', () => {
    const { res, sent } = response()
    const id = writableId(
      writeRequest({ 'sec-fetch-site': 'cross-site', host: HOST }, 'abc'),
      res,
    )
    expect(id).toBeNull()
    expect(sent.status).toBe(403)
  })

  it('refuses a same-site id that is not digits with 400 and answers null', () => {
    const { res, sent } = response()
    const id = writableId(
      writeRequest({ 'sec-fetch-site': 'same-origin', host: HOST }, 'abc'),
      res,
    )
    expect(id).toBeNull()
    expect(sent.status).toBe(400)
    expect(Object.keys(sent.body as Record<string, unknown>).sort()).toEqual([
      'error',
    ])
    expect(sent.body).toEqual({ error: 'id must be a positive integer' })
  })

  it('answers the id and sends nothing for a same-site write', () => {
    const { res, sent } = response()
    const id = writableId(
      writeRequest({ 'sec-fetch-site': 'same-origin', host: HOST }, '7'),
      res,
    )
    expect(id).toBe(7)
    expect(sent.status).toBeUndefined()
    expect(sent.body).toBeUndefined()
  })
})

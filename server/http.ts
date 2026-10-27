import type { Request, Response } from 'express'

import type { Scope } from '../shared/contracts.ts'

// The same-site check, the scope parser and the id checks, shared by the
// routes in server/routes/ and by server/agents/routes/ (#236, #420). The
// file sits here, beside error-class.ts, and not under server/routes/: the
// no-money-writes guard counts every module under server/routes/ as a
// writer, and server/agents/ may not import a writer. None of these reads a
// database. Only writableId sends a response, and only the refusal it names
// (a 403 or a 400); the rest only answer from the request they are given.

/**
 * `Sec-Fetch-Site` when the browser sends it; otherwise no `Origin` (curl)
 * passes and an `Origin` must name this host.
 */
export function fromThisSite(req: Request): boolean {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined) return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host.toLowerCase()
  } catch {
    // `Origin: null` (a sandboxed frame, a file: page) and anything else
    // that is not a URL.
    return false
  }
}

/** A plain `all`, `personal` or `strawb`; anything else, a repeated `scope` included, is refused. */
export function parseScope(raw: unknown): Scope | null {
  return raw === 'all' || raw === 'personal' || raw === 'strawb' ? raw : null
}

/**
 * A positive id in digits only. Number() would also accept '1e3', '0x10'
 * and ' 7', so the digits are checked before the number is trusted.
 */
export function parseId(raw: string): number | null {
  const id = Number(raw)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null
}

/**
 * The checks every write by id starts with: this site, then the id. Answers
 * the id, or null once a refusal has been sent.
 */
export function writableId(req: Request, res: Response): number | null {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id must be a positive integer' })
    return null
  }
  return id
}

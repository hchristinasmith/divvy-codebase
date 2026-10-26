import type { Request } from 'express'

import type { Scope } from '../shared/contracts.ts'

// The same-site check and the scope parser, shared by the routes in
// server/routes/ and by server/agents/routes/ (#236). The file sits here,
// beside error-class.ts, and not under server/routes/: the no-money-writes
// guard counts every module under server/routes/ as a writer, and
// server/agents/ may not import a writer. Neither function reads a database
// or changes a response: each only answers from the request it is given.

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

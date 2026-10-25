import express from 'express'
import type { Request } from 'express'

import insights from './insights.ts'
import proposals from './proposals.ts'

// /api/v1/agents (prd-04 w2, #51): the background agents' inbox over HTTP,
// mounted by server/routes/index.ts. The routes read the inbox and decide
// what is in it; nothing here runs an agent or calls a model (Ruling 7).
//
//   GET  /proposals?status=        list category proposals
//   POST /proposals/:id/accept     accept one; writes the category as `rule`
//   POST /proposals/:id/reject     reject one
//   GET  /insights?scope=&kind=    list insights not dismissed
//   POST /insights/:id/dismiss     dismiss one
//
// There is no server-side auth (D4): the app is reachable only over the
// tailnet. So that a page on another site cannot decide a proposal or
// dismiss an insight from Hannah's browser, every request that is not a GET
// or HEAD passes the same check as POST /api/v1/sync/run first, here once
// for every router below, so a write route added later is covered without
// remembering to.

/**
 * A copy of `fromThisSite` in server/routes/sync.ts and
 * server/routes/overview.ts; change every copy together.
 * `Sec-Fetch-Site` when the browser sends it; otherwise no `Origin` (curl)
 * passes and an `Origin` must name this host.
 */
function fromThisSite(req: Request): boolean {
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

const router = express.Router()

router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
})

router.use('/proposals', proposals)
router.use('/insights', insights)

export default router

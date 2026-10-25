import express from 'express'
import type { Request, Response } from 'express'

import type {
  ApplyCategoryResponse,
  CategoriseGroupsResponse,
  Scope,
} from '../../shared/contracts.ts'
import {
  CategoriseDataError,
  applyGroup,
  listGroups,
  validateApplyRequest,
} from '../db/categorise.ts'

const router = express.Router()

// /api/v1/categorise (prd-02 Ruling 16, issue #259): the Sort screen's read
// and its one write. Mounted by ./index.ts.
//
// GET /groups?scope=all|personal|strawb answers `CategoriseGroupsResponse`:
// one group per merchant with uncategorised settled transactions in that
// scope, largest total first. POST /groups/apply sets a category on every
// row of one group, through the one category writer with a correction per
// row, and answers `ApplyCategoryResponse` with how many it changed; a group
// already emptied answers 0. Which rows count, the merchant key and the
// totals all live in ../db/categorise.ts; this router does no arithmetic.
//
// A page on another site must not be able to write from Hannah's browser,
// so the apply first passes the same check as POST /api/v1/sync/run (see
// `fromThisSite`). Then the body, then the data.
//
// Errors are fixed text and never echo what was sent. A
// `CategoriseDataError` carries one of its own constant messages; anything
// else is a generic text. Only the error's class is logged.

/**
 * A copy of `parseScope` in ./bills.ts, ./budgets.ts, ./overview.ts,
 * ./subscriptions.ts and ../agents/routes/insights.ts; change all together
 * (#236 tracks folding the route helpers). A plain `all`, `personal` or
 * `strawb`; anything else, a repeated `scope` included, is refused.
 */
function parseScope(raw: unknown): Scope | null {
  return raw === 'all' || raw === 'personal' || raw === 'strawb' ? raw : null
}

/**
 * A copy of `fromThisSite` in ./sync.ts, ./overview.ts, ./subscriptions.ts,
 * ./bills.ts, ./goals.ts, ./budgets.ts and ../agents/routes/index.ts; change
 * all together (#236 tracks folding them).
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

/**
 * A copy of `errorClass` in ./overview.ts, ./accounts.ts, ./subscriptions.ts,
 * ./transactions.ts, ./bills.ts, ./goals.ts, ./budgets.ts,
 * ../sync/scheduler.ts, ../agents/routes/proposals.ts,
 * ../agents/routes/insights.ts and ../agents/insights/agent.ts; change all
 * together (#236 tracks folding them).
 */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

function failed(
  res: Response,
  what: string,
  generic: string,
  err: unknown,
): void {
  // eslint-disable-next-line no-console
  console.error(`categorise: could not ${what}`, errorClass(err))
  res.status(500).json({
    error: err instanceof CategoriseDataError ? err.message : generic,
  })
}

// GET /api/v1/categorise/groups?scope=
router.get('/groups', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    res.status(400).json({ error: 'scope must be all, personal or strawb' })
    return
  }
  try {
    const body: CategoriseGroupsResponse = await listGroups(scope)
    res.json(body)
  } catch (err) {
    failed(res, 'list groups', 'Could not read the groups', err)
  }
})

// POST /api/v1/categorise/groups/apply  body: { scope, merchant_key,
// category }.
router.post('/groups/apply', async (req, res) => {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const result = validateApplyRequest(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const body: ApplyCategoryResponse = await applyGroup(result.request)
    res.json(body)
  } catch (err) {
    failed(res, 'apply category', 'Could not apply the category', err)
  }
})

export default router

import express from 'express'
import type { Response } from 'express'

import type {
  ApplyCategoryResponse,
  CategoriseGroupsResponse,
} from '../../shared/contracts.ts'
import {
  CategoriseDataError,
  applyGroup,
  listGroups,
  validateApplyRequest,
} from '../db/categorise.ts'
import { errorClass } from '../error-class.ts'
import { fromThisSite, parseScope } from '../http.ts'

const router = express.Router()

// /api/v1/categorise (prd-02 Ruling 17, issue #259): the Sort screen's read
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

import express from 'express'
import type { Request, Response } from 'express'

import type { BudgetResponse, BudgetsResponse } from '../../shared/contracts.ts'
import {
  BudgetsDataError,
  createBudget,
  deleteBudget,
  listBudgets,
  updateBudget,
  validateBudgetPatch,
  validateCreateBudget,
  type BudgetRefusal,
} from '../db/budgets.ts'
import { OverviewDataError } from '../db/overview.ts'
import { errorClass } from '../error-class.ts'
import { fromThisSite, parseScope } from '../http.ts'

const router = express.Router()

// /api/v1/budgets (prd-02, issue #48): the Budgets screen's list and its
// writes. Mounted by ./index.ts.
//
// GET /?scope=all|personal|strawb answers `BudgetsResponse`; POST / creates
// a budget; PATCH /:id adjusts its limit or note; DELETE /:id deletes it.
// Every budget is the line `safeToSpend` computed for it in the overview
// (prd-02 Ruling 1), so spent, remaining and over here are the overview's.
// Every rule lives in ../db/budgets.ts, which answers a refusal code; this
// router maps each to a status and a fixed text. A path not listed here
// falls through to the app's JSON 404.
//
// Status. The contract (`BudgetResponse`) carries no left/over field; a
// budget is over when `overCents > 0` and left otherwise, so spent exactly
// at the limit is "left $0", as the overview's over-budget alert reads it.
//
// A page on another site must not be able to write from Hannah's browser,
// so every write first passes the same check as POST /api/v1/sync/run (see
// `fromThisSite`). Then the id, then the body, then the data.
//
// Errors are fixed text and never echo what was sent. A `BudgetsDataError`
// or an `OverviewDataError` carries one of its own constant messages;
// anything else is a generic text. Only the error's class is logged.

// A copy of `parseId` in ./bills.ts and ./goals.ts; change all together
// (#420 tracks folding them). Digits only: Number() would also
// accept '1e3', '0x10' and ' 7'.
function parseId(raw: string): number | null {
  const id = Number(raw)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null
}

const REFUSALS: Record<BudgetRefusal, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Budget not found' },
  duplicate: {
    status: 409,
    error: 'A budget for that category already exists in this scope',
  },
}

function refused(res: Response, refusal: BudgetRefusal): void {
  const { status, error } = REFUSALS[refusal]
  res.status(status).json({ error })
}

function failed(res: Response, what: string, err: unknown): void {
  console.error(`budgets: could not ${what}`, errorClass(err))
  res.status(500).json({
    error:
      err instanceof BudgetsDataError || err instanceof OverviewDataError
        ? err.message
        : 'Internal server error',
  })
}

/**
 * The checks every write by id starts with: this site, then the id. Answers
 * the id, or null once a refusal has been sent. A copy of `writableId` in
 * ./bills.ts and ./goals.ts; change all together (#420 tracks folding
 * them).
 */
function writableId(req: Request, res: Response): number | null {
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

// GET /api/v1/budgets?scope=
router.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    res.status(400).json({ error: 'scope must be all, personal or strawb' })
    return
  }
  try {
    const body: BudgetsResponse = await listBudgets(scope)
    res.json(body)
  } catch (err) {
    failed(res, 'list budgets', err)
  }
})

// POST /api/v1/budgets  body: CreateBudgetRequest. Answers 201 and the
// budget's line.
router.post('/', async (req, res) => {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const result = validateCreateBudget(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const written = await createBudget(result.budget)
    if (!written.ok) return refused(res, written.refusal)
    const body: BudgetResponse = written.value
    res.status(201).json(body)
  } catch (err) {
    failed(res, 'create budget', err)
  }
})

// PATCH /api/v1/budgets/:id  body: UpdateBudgetRequest. Any subset; `{}` is
// a no-op. Answers the budget's line afterwards.
router.patch('/:id', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  const result = validateBudgetPatch(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const written = await updateBudget(id, result.patch)
    if (!written.ok) return refused(res, written.refusal)
    const body: BudgetResponse = written.value
    res.json(body)
  } catch (err) {
    failed(res, 'update budget', err)
  }
})

// DELETE /api/v1/budgets/:id. Answers 204 with no body.
router.delete('/:id', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  try {
    const written = await deleteBudget(id)
    if (!written.ok) return refused(res, written.refusal)
    res.status(204).end()
  } catch (err) {
    failed(res, 'delete budget', err)
  }
})

export default router

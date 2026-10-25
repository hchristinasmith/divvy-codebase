import express from 'express'
import type { Request, Response } from 'express'

import type {
  AddGoalContributionResponse,
  GoalResponse,
  GoalsResponse,
} from '../../shared/contracts.ts'
import {
  GoalsDataError,
  addContribution,
  createGoal,
  deleteGoal,
  listGoals,
  updateGoal,
  validateContribution,
  validateCreateGoal,
  validateGoalPatch,
  type GoalRefusal,
} from '../db/goals.ts'

const router = express.Router()

// /api/v1/goals (prd-02, issue #50): the Goals screen's list and its
// writes. Mounted by ./index.ts.
//
// GET / answers `GoalsResponse`; POST / creates a goal; PATCH /:id edits
// one; DELETE /:id deletes one and its contributions; POST
// /:id/contributions records a contribution and answers
// `AddGoalContributionResponse`. A contribution is a record (prd-02 Ruling
// 5): it moves no money and never changes safe-to-spend, and the amount is
// the request's. Contributions are append only: no route here edits or
// deletes one, so any other method or path on them falls through to the
// app's JSON 404, as does everything else not listed here.
//
// Every rule lives in ../db/goals.ts, which answers a refusal code; this
// router maps it to a status and a fixed text.
//
// A page on another site must not be able to write from Hannah's browser,
// so every write first passes the same check as POST /api/v1/sync/run (see
// `fromThisSite`). Then the id, then the body, then the data.
//
// Errors are fixed text and never echo what was sent. A `GoalsDataError`
// carries one of its own constant messages; anything else is a generic
// text. Only the error's class is logged.

/**
 * A copy of `fromThisSite` in ./sync.ts, ./overview.ts, ./subscriptions.ts
 * and ./bills.ts; change all together (#236 tracks folding them).
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
 * ./bills.ts and ../sync/scheduler.ts; change all together (#236 tracks
 * folding them).
 */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

// A copy of `parseId` in ./bills.ts; change both together (#236 tracks
// folding the route helpers; its list predates this one). Digits only: Number() would also accept '1e3', '0x10' and
// ' 7'.
function parseId(raw: string): number | null {
  const id = Number(raw)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null
}

const REFUSALS: Record<GoalRefusal, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Goal not found' },
}

function refused(res: Response, refusal: GoalRefusal): void {
  const { status, error } = REFUSALS[refusal]
  res.status(status).json({ error })
}

function failed(res: Response, what: string, err: unknown): void {
  console.error(`goals: could not ${what}`, errorClass(err))
  res.status(500).json({
    error:
      err instanceof GoalsDataError ? err.message : 'Internal server error',
  })
}

/**
 * The checks every write by id starts with: this site, then the id. Answers
 * the id, or null once a refusal has been sent. A copy of `writableId` in
 * ./bills.ts; change both together (#236 tracks folding the route helpers;
 * its list predates this one).
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

// GET /api/v1/goals
router.get('/', async (_req, res) => {
  try {
    const body: GoalsResponse = await listGoals()
    res.json(body)
  } catch (err) {
    failed(res, 'list goals', err)
  }
})

// POST /api/v1/goals  body: CreateGoalRequest. Answers 201 and the goal.
router.post('/', async (req, res) => {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const result = validateCreateGoal(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const body: GoalResponse = await createGoal(result.goal)
    res.status(201).json(body)
  } catch (err) {
    failed(res, 'create goal', err)
  }
})

// PATCH /api/v1/goals/:id  body: UpdateGoalRequest. Any subset; `{}` is a
// no-op. Answers the goal afterwards.
router.patch('/:id', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  const result = validateGoalPatch(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const written = await updateGoal(id, result.patch)
    if (!written.ok) return refused(res, written.refusal)
    const body: GoalResponse = written.value
    res.json(body)
  } catch (err) {
    failed(res, 'update goal', err)
  }
})

// DELETE /api/v1/goals/:id. The goal's contributions go with it. Answers
// 204 with no body.
router.delete('/:id', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  try {
    const written = await deleteGoal(id)
    if (!written.ok) return refused(res, written.refusal)
    res.status(204).end()
  } catch (err) {
    failed(res, 'delete goal', err)
  }
})

// POST /api/v1/goals/:id/contributions  body: AddGoalContributionRequest.
// Records a contribution, which is a record and not a transfer (prd-02
// Ruling 5). Answers 201 and the goal afterwards.
router.post('/:id/contributions', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  const result = validateContribution(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const written = await addContribution(id, result.amountCents)
    if (!written.ok) return refused(res, written.refusal)
    const body: AddGoalContributionResponse = { goal: written.value }
    res.status(201).json(body)
  } catch (err) {
    failed(res, 'add contribution', err)
  }
})

export default router

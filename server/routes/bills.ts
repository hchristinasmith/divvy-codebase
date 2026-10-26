import express from 'express'
import type { Request, Response } from 'express'

import type {
  BillResponse,
  BillsResponse,
  MarkBillPaidResponse,
} from '../../shared/contracts.ts'
import {
  BillsDataError,
  createBill,
  deleteBill,
  listBills,
  markBillPaid,
  updateBill,
  validateBillPatch,
  validateCreateBill,
  type BillRefusal,
} from '../db/bills.ts'
import { errorClass } from '../error-class.ts'
import { fromThisSite, parseScope } from '../http.ts'

const router = express.Router()

// /api/v1/bills (prd-02, issue #49): the Bills screen's list and its
// writes. Mounted by ./index.ts.
//
// GET /?scope=all|personal|strawb answers `BillsResponse`; POST / creates
// a bill; PATCH /:id edits one; DELETE /:id deletes one with no payments;
// POST /:id/payments is "Mark paid" and answers `MarkBillPaidResponse`.
// Every rule lives in ../db/bills.ts, which answers a refusal code; this
// router maps each to a status and a fixed text. A path not listed here
// falls through to the app's JSON 404.
//
// A page on another site must not be able to write from Hannah's browser,
// so every write first passes the same check as POST /api/v1/sync/run (see
// `fromThisSite`). Then the id, then the body, then the data.
//
// Errors are fixed text and never echo what was sent. A `BillsDataError`
// carries one of its own constant messages; anything else is a generic
// text. Only the error's class is logged.

// Digits only: Number() would also accept '1e3', '0x10' and ' 7'.
function parseId(raw: string): number | null {
  const id = Number(raw)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null
}

const REFUSALS: Record<BillRefusal, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Bill not found' },
  cannot_delete_paid: {
    status: 409,
    error: 'Bill has payments, so it cannot be deleted',
  },
  cannot_reschedule_paid: {
    status: 409,
    error:
      'Bill has payments, so its first due date and repeat cannot be changed',
  },
  account_not_found: {
    status: 400,
    error: 'accountId does not match an account',
  },
  account_scope_mismatch: {
    status: 400,
    error: 'accountId must be an account in the same scope as the bill',
  },
  too_many_unpaid: {
    status: 400,
    error: 'That schedule leaves too many unpaid occurrences',
  },
  already_paid: { status: 409, error: 'This bill is already paid' },
  paid_too_far_ahead: {
    status: 409,
    error: 'This bill is paid up to the last date Divvy tracks',
  },
}

function refused(res: Response, refusal: BillRefusal): void {
  const { status, error } = REFUSALS[refusal]
  res.status(status).json({ error })
}

function failed(res: Response, what: string, err: unknown): void {
  console.error(`bills: could not ${what}`, errorClass(err))
  res.status(500).json({
    error:
      err instanceof BillsDataError ? err.message : 'Internal server error',
  })
}

/**
 * The checks every write by id starts with: this site, then the id. Answers
 * the id, or null once a refusal has been sent.
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

// GET /api/v1/bills?scope=
router.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    res.status(400).json({ error: 'scope must be all, personal or strawb' })
    return
  }
  try {
    const body: BillsResponse = await listBills(scope)
    res.json(body)
  } catch (err) {
    failed(res, 'list bills', err)
  }
})

// POST /api/v1/bills  body: CreateBillRequest. Answers 201 and the bill.
router.post('/', async (req, res) => {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const result = validateCreateBill(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const written = await createBill(result.bill)
    if (!written.ok) return refused(res, written.refusal)
    const body: BillResponse = written.value
    res.status(201).json(body)
  } catch (err) {
    failed(res, 'create bill', err)
  }
})

// PATCH /api/v1/bills/:id  body: UpdateBillRequest. Any subset; `{}` is a
// no-op. Answers the bill afterwards.
router.patch('/:id', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  const result = validateBillPatch(req.body)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  try {
    const written = await updateBill(id, result.patch)
    if (!written.ok) return refused(res, written.refusal)
    const body: BillResponse = written.value
    res.json(body)
  } catch (err) {
    failed(res, 'update bill', err)
  }
})

// DELETE /api/v1/bills/:id. Answers 204 with no body.
router.delete('/:id', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  try {
    const written = await deleteBill(id)
    if (!written.ok) return refused(res, written.refusal)
    res.status(204).end()
  } catch (err) {
    failed(res, 'delete bill', err)
  }
})

// POST /api/v1/bills/:id/payments: "Mark paid". The body is empty or `{}`.
// Answers 201 and the bill afterwards.
router.post('/:id/payments', async (req, res) => {
  const id = writableId(req, res)
  if (id === null) return
  // express.json() leaves an absent body as {}.
  const body: unknown = req.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.status(400).json({ error: 'Body must be a JSON object' })
    return
  }
  if (Object.keys(body).length > 0) {
    res.status(400).json({ error: 'Unknown field in body' })
    return
  }
  try {
    const written = await markBillPaid(id)
    if (!written.ok) return refused(res, written.refusal)
    const paid: MarkBillPaidResponse = { bill: written.value }
    res.status(201).json(paid)
  } catch (err) {
    failed(res, 'mark bill paid', err)
  }
})

export default router

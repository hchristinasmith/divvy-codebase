import express from 'express'
import type { Request, Response } from 'express'

import type { Scope, Verdict } from '../../shared/contracts.ts'
import { HabitsDataError, readHabits, setVerdict } from '../db/habits.ts'

// /api/v1/habits (prd-02, issue #52): the Habits screen's read and
// Hannah's "worth it" verdicts. Mounted by ./index.ts.
//
// GET /?scope=all|personal|strawb answers `HabitsResponse` from
// shared/contracts.ts, exactly as `readHabits` got it from
// shared/habits.ts. This router does no arithmetic, defines no streak, has
// no freedom date, never reads Xero and never calls out.
//
// PUT /verdicts/:transactionId stores her verdict (`SetVerdictRequest`) and
// answers the `VerdictRow`; `{ "verdict": null }` clears it. Only a settled
// outflow on a stored Akahu account can be tagged. A page on another site
// must not be able to write from Hannah's browser, so the same check as
// POST /api/v1/sync/run comes first (see `fromThisSite`).
//
// Errors are fixed text and never echo what was sent. A `HabitsDataError`
// carries one of its own constant messages, which name no value; anything
// else is a generic text. Only the error's class is logged.

/**
 * A copy of `parseScope` in ./overview.ts, ./subscriptions.ts and ./bills.ts;
 * change all together (#236 lifts them). A plain scope; anything else is
 * refused.
 */
function parseScope(raw: unknown): Scope | null {
  return raw === 'all' || raw === 'personal' || raw === 'strawb' ? raw : null
}

/**
 * A copy of `fromThisSite` in ./sync.ts, ./overview.ts, ./subscriptions.ts
 * and ./bills.ts; change all together (#236 lifts them).
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
 * A copy of `errorClass` in ./overview.ts, ./accounts.ts, ./subscriptions.ts
 * and ./bills.ts; change all together (#236 lifts them).
 */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

type Body = Record<string, unknown>

/**
 * A copy of `plainBody` in ./subscriptions.ts; change both together. A plain
 * object holding no key but `allowed`; anything else is null.
 */
function plainBody(raw: unknown, allowed: readonly string[]): Body | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return null
  }
  return raw as Body
}

// Digits only, no leading zero, at most 15 so the id is a safe integer:
// Number() would also accept '1e3', '0x10' and ' 7'.
const TRANSACTION_ID = /^[1-9]\d{0,14}$/

function parseVerdict(body: Body): Verdict | null | undefined {
  if (!('verdict' in body)) return undefined
  const { verdict } = body
  return verdict === null || verdict === 'worth_it' || verdict === 'not_really'
    ? verdict
    : undefined
}

function refuse(res: Response, status: number, error: string): void {
  res.status(status).json({ error })
}

const router = express.Router()

// GET /api/v1/habits?scope=
router.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    refuse(res, 400, 'scope must be all, personal or strawb')
    return
  }
  try {
    res.json(await readHabits(scope))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('habits: could not read habits', errorClass(err))
    refuse(
      res,
      500,
      err instanceof HabitsDataError ? err.message : 'Could not read habits',
    )
  }
})

// PUT /api/v1/habits/verdicts/:transactionId
router.put('/verdicts/:transactionId', async (req, res) => {
  if (!fromThisSite(req)) {
    refuse(res, 403, 'Forbidden')
    return
  }
  if (!TRANSACTION_ID.test(req.params.transactionId)) {
    refuse(res, 400, 'transactionId must be a positive integer')
    return
  }
  const body = plainBody(req.body, ['verdict'])
  if (body === null) {
    refuse(res, 400, 'Invalid body')
    return
  }
  const verdict = parseVerdict(body)
  if (verdict === undefined) {
    refuse(res, 400, 'verdict must be worth_it, not_really or null')
    return
  }
  try {
    const stored = await setVerdict(Number(req.params.transactionId), verdict)
    if (stored === 'not_found') {
      refuse(res, 404, 'Transaction not found')
      return
    }
    if (stored === 'pending') {
      refuse(
        res,
        409,
        'Transaction is still pending; it can be tagged once it settles',
      )
      return
    }
    if (stored === 'not_spend') {
      refuse(res, 400, 'Only spending can be tagged')
      return
    }
    res.json(stored)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('habits: could not save verdict', errorClass(err))
    refuse(
      res,
      500,
      err instanceof HabitsDataError ? err.message : 'Could not save verdict',
    )
  }
})

export default router

import express from 'express'
import type { Response } from 'express'

import { SPENDING_TOP_MAX, isYearMonth } from '../../shared/spending.ts'
import { parseScope } from '../http.ts'
import { SpendingDataError, readSpendingByCategory } from '../db/spending.ts'

// /api/v1/spending (#271): spending by category, for the Overview's
// "Spending by category" card and the Spending screen (#272). Mounted by
// ./index.ts.
//
// GET /categories?scope=all|personal|strawb&month=YYYY-MM&top=n answers
// `SpendingByCategoryResponse` from shared/contracts.ts, exactly as
// `readSpendingByCategory` got it from shared/spending.ts. This router does
// no arithmetic, never reads Xero, never writes and never calls out, so it
// needs no same-site check.
//
// `scope` is required. `month` is an NZ calendar month and defaults to
// today's; a month with no rows, past or future, answers zeros. `top` folds
// the categories beyond it into `otherCents`; without it every category is
// listed. Every value must be sent once: a repeated parameter is refused.
//
// No account id, account name or description is in the payload: only
// category names and amounts.
//
// Errors are fixed text. A `SpendingDataError` carries one of its own
// constant messages, which name no value; anything else is a generic text.
// Only the error's class is logged.

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

const TOP = /^[1-9]\d?$/

/** A month when sent, undefined when not; null refuses it. */
function parseMonth(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined
  return isYearMonth(raw) ? raw : null
}

/** A whole number from 1 to `SPENDING_TOP_MAX` when sent; null refuses it. */
function parseTop(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !TOP.test(raw)) return null
  const top = Number(raw)
  return top <= SPENDING_TOP_MAX ? top : null
}

function refuse(res: Response, status: number, error: string): void {
  res.status(status).json({ error })
}

const router = express.Router()

// GET /api/v1/spending/categories?scope=&month=&top=
router.get('/categories', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    refuse(res, 400, 'scope must be all, personal or strawb')
    return
  }
  const month = parseMonth(req.query.month)
  if (month === null) {
    refuse(res, 400, 'month must be YYYY-MM')
    return
  }
  const top = parseTop(req.query.top)
  if (top === null) {
    refuse(res, 400, `top must be a whole number from 1 to ${SPENDING_TOP_MAX}`)
    return
  }
  try {
    res.json(await readSpendingByCategory({ scope, month, top }))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'spending: could not read spending by category',
      errorClass(err),
    )
    refuse(
      res,
      500,
      err instanceof SpendingDataError
        ? err.message
        : 'Could not read spending',
    )
  }
})

export default router

import express from 'express'
import type { Response } from 'express'

import type { RowScope, SubscriptionAnswer } from '../../shared/contracts.ts'
import { isIsoDate, isMerchantKey } from '../../shared/subscriptions.ts'
import {
  SubscriptionsDataError,
  cancelSubscription,
  readSubscriptions,
  setAnswer,
  uncancelSubscription,
} from '../db/subscriptions.ts'
import { errorClass } from '../error-class.ts'
import { fromThisSite, parseScope } from '../http.ts'

// /api/v1/subscriptions (prd-02 Ruling 14, issue #229): the Subscriptions
// screen's read and Hannah's marks. Mounted by ./index.ts.
//
// GET /?scope=all|personal|strawb answers `SubscriptionsResponse` from
// shared/contracts.ts, exactly as `readSubscriptions` got it from
// shared/subscriptions.ts. This router does no arithmetic and no
// detection, never reads Xero, and never calls out.
//
// PUT /mark stores her answer (`MarkSubscriptionRequest`). POST /cancel
// records the day she cancelled (`CancelSubscriptionRequest`) and POST
// /uncancel clears it; neither sends anything to the merchant or the bank.
// Each answers `SubscriptionMarkResponse`. A write names one merchant in one
// row scope, never `all`. The body is checked before anything is read; a
// merchant with no charge in that scope is a 404. A page on another site
// must not be able to write from Hannah's browser, so the same check as
// POST /api/v1/sync/run comes first (see `fromThisSite`).
//
// The merchant key is sent as it is: an Akahu merchant id is a catalogue id,
// not a credential or an account id, and a description key is bank text the
// activity list already shows. No account id, connection or account name is
// in any payload.
//
// Errors are fixed text. A `SubscriptionsDataError` carries one of its own
// constant messages, which name no value; anything else is a generic text.
// Only the error's class is logged.

type Body = Record<string, unknown>

/** A plain object holding no key but `allowed`; anything else is null. */
function plainBody(raw: unknown, allowed: readonly string[]): Body | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return null
  }
  return raw as Body
}

interface Target {
  scope: RowScope
  merchantKey: string
}

/** The merchant a write names, or the fixed text refusing it. */
function parseTarget(body: Body): Target | string {
  const { scope, merchantKey } = body
  if (scope !== 'personal' && scope !== 'strawb')
    return 'scope must be personal or strawb'
  if (!isMerchantKey(merchantKey)) return 'merchantKey is not valid'
  return { scope, merchantKey }
}

function parseAnswer(body: Body): SubscriptionAnswer | null | undefined {
  if (!('answer' in body)) return undefined
  const { answer } = body
  return answer === null ||
    answer === 'subscription' ||
    answer === 'not_subscription'
    ? answer
    : undefined
}

function refuse(res: Response, status: number, error: string): void {
  res.status(status).json({ error })
}

function saveFailed(res: Response, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('subscriptions: could not save subscription', errorClass(err))
  refuse(
    res,
    500,
    err instanceof SubscriptionsDataError
      ? err.message
      : 'Could not save subscription',
  )
}

const router = express.Router()

// GET /api/v1/subscriptions?scope=
router.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    refuse(res, 400, 'scope must be all, personal or strawb')
    return
  }
  try {
    res.json(await readSubscriptions(scope))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'subscriptions: could not read subscriptions',
      errorClass(err),
    )
    refuse(
      res,
      500,
      err instanceof SubscriptionsDataError
        ? err.message
        : 'Could not read subscriptions',
    )
  }
})

// PUT /api/v1/subscriptions/mark
router.put('/mark', async (req, res) => {
  if (!fromThisSite(req)) {
    refuse(res, 403, 'Forbidden')
    return
  }
  const body = plainBody(req.body, ['scope', 'merchantKey', 'answer'])
  if (body === null) {
    refuse(res, 400, 'Invalid body')
    return
  }
  const target = parseTarget(body)
  if (typeof target === 'string') {
    refuse(res, 400, target)
    return
  }
  const answer = parseAnswer(body)
  if (answer === undefined) {
    refuse(res, 400, 'answer must be subscription, not_subscription or null')
    return
  }
  try {
    const stored = await setAnswer(target, answer)
    if (stored === 'not_found') {
      refuse(res, 404, 'Merchant not found')
      return
    }
    res.json(stored)
  } catch (err) {
    saveFailed(res, err)
  }
})

// POST /api/v1/subscriptions/cancel
router.post('/cancel', async (req, res) => {
  if (!fromThisSite(req)) {
    refuse(res, 403, 'Forbidden')
    return
  }
  const body = plainBody(req.body, ['scope', 'merchantKey', 'on'])
  if (body === null) {
    refuse(res, 400, 'Invalid body')
    return
  }
  const target = parseTarget(body)
  if (typeof target === 'string') {
    refuse(res, 400, target)
    return
  }
  const on = 'on' in body ? body.on : undefined
  if (on !== undefined && !isIsoDate(on)) {
    refuse(res, 400, 'on must be a YYYY-MM-DD date')
    return
  }
  try {
    const stored = await cancelSubscription(target, on)
    if (stored === 'not_found') {
      refuse(res, 404, 'Merchant not found')
      return
    }
    if (stored === 'future_date') {
      refuse(res, 400, 'on cannot be in the future')
      return
    }
    res.json(stored)
  } catch (err) {
    saveFailed(res, err)
  }
})

// POST /api/v1/subscriptions/uncancel
router.post('/uncancel', async (req, res) => {
  if (!fromThisSite(req)) {
    refuse(res, 403, 'Forbidden')
    return
  }
  const body = plainBody(req.body, ['scope', 'merchantKey'])
  if (body === null) {
    refuse(res, 400, 'Invalid body')
    return
  }
  const target = parseTarget(body)
  if (typeof target === 'string') {
    refuse(res, 400, target)
    return
  }
  try {
    const stored = await uncancelSubscription(target)
    if (stored === 'not_found') {
      refuse(res, 404, 'Merchant not found')
      return
    }
    res.json(stored)
  } catch (err) {
    saveFailed(res, err)
  }
})

export default router

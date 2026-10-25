import express from 'express'
import type { Request } from 'express'

import type { Scope } from '../../shared/contracts.ts'
import {
  OverviewDataError,
  dismissAlert,
  readOverview,
} from '../db/overview.ts'

// /api/v1/overview (prd-02, issue #44): the Overview screen's one read and
// its alert dismissal. Mounted by ./index.ts.
//
// GET /?scope=all|personal|strawb answers `OverviewResponse` from
// shared/contracts.ts. Safe-to-spend is the shared module's result exactly
// as `readOverview` got it (prd-02 Ruling 1); this router does no money
// arithmetic and never reads Xero.
//
// POST /alerts/:id/dismiss stores a dismissal for an alert that is
// currently derived and answers `DismissAlertResponse`. It is served here,
// under the overview mount, and shared/contracts.ts names the path
// /api/v1/overview/alerts/:id/dismiss. The id's shape is checked before
// anything is read. A page on another site must not be able to dismiss
// from Hannah's browser, so the same check as POST /api/v1/sync/run comes
// first (see `fromThisSite`).
//
// Errors are fixed text. An `OverviewDataError` carries one of its own
// constant messages, which name no id or value; anything else is a generic
// text. Only the error's class is logged.

/** A plain `all`, `personal` or `strawb`; anything else is refused. */
function parseScope(raw: unknown): Scope | null {
  return raw === 'all' || raw === 'personal' || raw === 'strawb' ? raw : null
}

// `<kind>:<positive row id>:<YYYY-MM-DD>`, as `deriveAlerts` builds them.
const ALERT_ID =
  /^(over_budget|bill_due_soon|bill_overdue):[1-9]\d*:\d{4}-\d{2}-\d{2}$/
const MAX_ALERT_ID_LENGTH = 255

/**
 * A copy of `fromThisSite` in ./sync.ts; change both together.
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

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

const router = express.Router()

// GET /api/v1/overview?scope=
router.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    res.status(400).json({ error: 'scope must be all, personal or strawb' })
    return
  }
  try {
    res.json(await readOverview(scope))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('overview: could not read overview', errorClass(err))
    res.status(500).json({
      error:
        err instanceof OverviewDataError
          ? err.message
          : 'Could not read overview',
    })
  }
})

// POST /api/v1/overview/alerts/:id/dismiss
router.post('/alerts/:id/dismiss', async (req, res) => {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const id = req.params.id
  if (id.length > MAX_ALERT_ID_LENGTH || !ALERT_ID.test(id)) {
    res.status(400).json({ error: 'Invalid alert id' })
    return
  }
  try {
    const dismissed = await dismissAlert(id)
    if (dismissed === null) {
      res.status(404).json({ error: 'Alert not found' })
      return
    }
    res.json(dismissed)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('overview: could not dismiss alert', errorClass(err))
    res.status(500).json({
      error:
        err instanceof OverviewDataError
          ? err.message
          : 'Could not dismiss alert',
    })
  }
})

export default router

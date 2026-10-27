import express from 'express'

import {
  INSIGHT_KINDS,
  type Insight,
  type InsightKind,
  type InsightScope,
} from '../../../models/insights.ts'
import { dismissInsight, getInsight, listInsights } from '../db/insights.ts'
import { errorClass } from '../../error-class.ts'

// /api/v1/agents/insights (prd-04 Rulings 2, 3 and 8, #51), mounted by
// ./index.ts, which also refuses a cross-site POST before it reaches here.
//
// The list never includes a dismissed insight. Each item is the accessor's
// row: its chart spec re-validated on read (Ruling 8), so a stored spec the
// validator refuses comes back as a null chart, and no `mermaid` key
// (Ruling 3 has no column for it).
//
// Errors are `{ error: string }` with fixed text, never a row value: an
// insight's title and body carry merchant text. A 500 logs only the error's
// class.

interface ListInsightsResponse {
  items: Insight[]
}

interface DismissInsightResponse {
  insight: Insight
}

/**
 * A plain positive integer id, or null. Digits only, as PATCH
 * /api/v1/transactions/:id: Number() would also accept '1e3', '0x10' and ' 7'.
 */
function parseId(raw: string): number | null {
  const id = Number(raw)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null
}

/** `all` (or absent) is no filter; one scope; anything else, or repeated, null. */
function parseScope(raw: unknown): InsightScope | 'all' | null {
  if (raw === undefined) return 'all'
  return raw === 'all' || raw === 'personal' || raw === 'strawb' ? raw : null
}

/** Absent is no filter; one known kind; anything else, or repeated, null. */
function parseKind(raw: unknown): InsightKind | 'any' | null {
  if (raw === undefined) return 'any'
  return typeof raw === 'string' &&
    (INSIGHT_KINDS as readonly string[]).includes(raw)
    ? (raw as InsightKind)
    : null
}

const router = express.Router()

// GET /api/v1/agents/insights?scope=all|personal|strawb&kind=pattern|report|chart
router.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (scope === null) {
    res.status(400).json({ error: 'scope must be all, personal or strawb' })
    return
  }
  const kind = parseKind(req.query.kind)
  if (kind === null) {
    res.status(400).json({ error: 'kind must be pattern, report or chart' })
    return
  }
  try {
    const items = await listInsights({
      scope: scope === 'all' ? undefined : scope,
      kind: kind === 'any' ? undefined : kind,
    })
    const body: ListInsightsResponse = { items }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('agents: could not list insights', errorClass(err))
    res.status(500).json({ error: 'Could not list insights' })
  }
})

// POST /api/v1/agents/insights/:id/dismiss
//
// A second dismissal is refused, and the first dismissal's time is kept.
router.post('/:id/dismiss', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id must be a positive integer' })
    return
  }
  try {
    const dismissed = await dismissInsight(id)
    const insight = await getInsight(id)
    if (insight === undefined) {
      res.status(404).json({ error: 'Insight not found' })
      return
    }
    if (!dismissed) {
      res.status(409).json({ error: 'Insight already dismissed' })
      return
    }
    const body: DismissInsightResponse = { insight }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('agents: could not dismiss insight', errorClass(err))
    res.status(500).json({ error: 'Could not dismiss insight' })
  }
})

export default router

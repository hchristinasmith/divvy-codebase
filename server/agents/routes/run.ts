import express from 'express'

import type { InsightScope } from '../../../models/insights.ts'
import connection from '../../db/connection.ts'
import { errorClass } from '../../error-class.ts'
import type { CategoryRunResult } from '../category/agent.ts'
import type { InsightsRunResult } from '../insights/agent.ts'
import {
  agentScheduler,
  INSIGHT_SCOPES,
  type ManualRun,
} from '../scheduler.ts'

// POST /api/v1/agents/run (prd-04 Rulings 2 and 7, #58), mounted by
// ./index.ts, which also refuses a cross-site POST before it reaches here.
//
// Body `{ agent: 'category' | 'insights', scope?: 'personal' | 'strawb' }`.
// `category` runs the category agent once as a manual run, over the next
// batch of its sweep; it has no scope, so a `scope` with it is refused.
// `insights` runs the insights agent for the given scope, or for every scope
// when none is given, over the last complete NZ week.
//
// The run goes through the agent scheduler's one-pass guard, so it never
// overlaps a scheduled pass: 409 while a pass is in flight. Once the process
// is shutting down (SIGTERM, #462) it is 503 and nothing starts, checked
// before the gap read below. A manual run started within MANUAL_RUN_GAP_MS of
// this request is also 409, so back-to-back calls cannot each add a run row
// (#454). Unlike POST
// /api/v1/sync/run this waits for the run and answers with its result,
// because an agent run is a few local queries. A run that ended `failed` is
// a 500 naming the run, whose row is in `agent_runs`; the reason is in the
// server log only. Errors are `{ error, runId }` with fixed text, never a
// thrown message.

interface RunResponse {
  agent: ManualRun['agent']
  runs: (CategoryRunResult | InsightsRunResult)[]
}

interface RunErrorResponse {
  error: string
  runId: number | null
}

/** The manual run a body asks for, or null. */
function parseRun(body: unknown): ManualRun | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }
  const agent: unknown = 'agent' in body ? body.agent : undefined
  const scope: unknown = 'scope' in body ? body.scope : undefined
  if (agent === 'category') {
    return scope === undefined ? { agent } : null
  }
  if (agent !== 'insights') return null
  if (scope === undefined) return { agent, scopes: INSIGHT_SCOPES }
  return scope === 'personal' || scope === 'strawb'
    ? { agent, scopes: [scope satisfies InsightScope] }
    : null
}

// Read from `agent_runs`, not held in memory, so it holds across the module
// instances a test imports and across a restart.
const MANUAL_RUN_GAP_MS = 10_000

/** True when the newest manual run started within MANUAL_RUN_GAP_MS of `now`. */
async function manualRunStartedMomentsAgo(now: Date): Promise<boolean> {
  const latest = await connection('agent_runs')
    .where({ trigger: 'manual' })
    .orderBy([
      { column: 'started_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .first('started_at')
  if (latest === undefined) return false
  return Math.abs(now.getTime() - Date.parse(latest.started_at)) < MANUAL_RUN_GAP_MS
}

/** Refused while the process drains: the body names no run, as the 409s do. */
function refuseShuttingDown(res: express.Response): void {
  const body: RunErrorResponse = { error: 'Server is shutting down', runId: null }
  res.status(503).json(body)
}

const router = express.Router()

router.post('/', async (req, res) => {
  const run = parseRun(req.body)
  if (run === null) {
    const body: RunErrorResponse = {
      error:
        "body must be { agent: 'category' } or { agent: 'insights', scope?: 'personal' | 'strawb' }",
      runId: null,
    }
    res.status(400).json(body)
    return
  }
  try {
    // A stopped scheduler answers first, before the gap read, so a draining
    // process never reports a gap. A pass in flight answers next, as it always
    // has; the gap check only matters for a run that could start now. Inside
    // the try: Express 4 does not catch a rejected handler, so a failed read
    // must answer here.
    const state = agentScheduler.getState()
    if (state.stopped) {
      refuseShuttingDown(res)
      return
    }
    const idle = !state.running
    if (idle && (await manualRunStartedMomentsAgo(new Date()))) {
      const body: RunErrorResponse = {
        error: 'An agent run was started moments ago; try again shortly',
        runId: null,
      }
      res.status(409).json(body)
      return
    }
    const started = agentScheduler.runNow(run)
    if (!started.started) {
      // The stop can land during the gap read above; runNow still refuses.
      if (started.reason === 'stopped') {
        refuseShuttingDown(res)
        return
      }
      const body: RunErrorResponse = { error: 'An agent pass is already running', runId: null }
      res.status(409).json(body)
      return
    }
    const result = await started.result
    const failed = result.runs.find((r) => r.outcome === 'failed')
    if (failed !== undefined) {
      const body: RunErrorResponse = { error: 'Agent run failed', runId: failed.runId }
      res.status(500).json(body)
      return
    }
    const body: RunResponse = { agent: result.agent, runs: result.runs }
    res.json(body)
  } catch (err) {
    console.error('agents: could not run agent', errorClass(err))
    const body: RunErrorResponse = { error: 'Could not run agent', runId: null }
    res.status(500).json(body)
  }
})

export default router

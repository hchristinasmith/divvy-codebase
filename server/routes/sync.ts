import express from 'express'

import connection from '../db/connection.ts'
import type { IsoTimestamp, SyncOutcome, SyncRun } from '../../models/sync.ts'
import { rankByStartedAt } from '../sync/ranked-runs.ts'
import { syncScheduler } from '../sync/scheduler.ts'
import { errorClass } from '../error-class.ts'
import { fromThisSite } from '../http.ts'

// /api/v1/sync (prd-01 Ruling 6, issue #27): what the last sync did, when
// the next is due, and "sync now". prd-02's Sync screen reads this shape.
//
// GET /status reads `sync_runs` and the scheduler's in-process state; it
// never reads the environment. `error` is the row's `error_message`, which
// `runSync` builds from fixed codes only, so no credential can reach it.
// `running` is this process's flag, not the database's: a `running` row left
// by a process that died must not show as a sync in progress. So
// `lastRun.outcome === 'running'` with `running === false` means a leftover
// row. A run closes it as abandoned once it is 30 minutes old
// (`STALE_RUN_AFTER_MS`); until then a run is skipped, writing nothing.
//
// POST /run starts a run and answers at once (202), or refuses with 409 if
// one is in flight, or 503 once the process is shutting down (#462); it never
// waits for the sync. There is no server-side auth (prd-01 Ruling 7, D4): the
// app is reachable only over the tailnet.
// So that a page on another site cannot start a run from Hannah's browser,
// a browser's `Sec-Fetch-Site`, which no page can set, decides first:
// `same-origin` and `none` pass, anything else is 403. Only when it is
// absent (curl, an older browser) is `Origin` compared with `Host`; an
// absent `Origin` passes. `Sec-Fetch-Site` goes first because a proxy can
// rewrite `Host`: the Vite dev proxy does (`changeOrigin`), so a same-origin
// press under `npm run dev` arrives with a `Host` its `Origin` does not name.

export interface SyncRunCounts {
  inserted: number
  updated: number
  pendingMirrored: number
}

export interface SyncRunStatus {
  id: number
  startedAt: IsoTimestamp
  finishedAt: IsoTimestamp | null
  outcome: SyncOutcome
  counts: SyncRunCounts
  error: string | null
}

export interface SyncStatus {
  running: boolean
  lastRun: SyncRunStatus | null
  lastSuccessAt: IsoTimestamp | null
  nextRunAt: IsoTimestamp | null
}

export type SyncRunResponse =
  | { started: true }
  | { started: false; reason: 'already running' }
  | { started: false; reason: 'shutting down' }

function toRunStatus(row: SyncRun): SyncRunStatus {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    counts: {
      inserted: row.inserted_count,
      updated: row.updated_count,
      pendingMirrored: row.pending_mirrored_count,
    },
    error: row.error_message,
  }
}

const router = express.Router()

// GET /api/v1/sync/status
//
// Both queries rank runs as run.ts's claim step does, through
// rankByStartedAt in server/sync/ranked-runs.ts (#188, #169, #206).
router.get('/status', async (req, res) => {
  try {
    const latest: SyncRun | undefined = await rankByStartedAt(
      connection('sync_runs'),
    ).first()
    const lastSuccess: Pick<SyncRun, 'finished_at'> | undefined =
      await rankByStartedAt(
        connection('sync_runs').where({ outcome: 'success' }),
      ).first('finished_at')
    const state = syncScheduler.getState()
    const body: SyncStatus = {
      running: state.running,
      lastRun: latest === undefined ? null : toRunStatus(latest),
      lastSuccessAt: lastSuccess?.finished_at ?? null,
      nextRunAt: state.nextRunAt,
    }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'sync status: could not read sync_runs',
      errorClass(err),
    )
    res.status(500).json({ error: 'Could not read sync status' })
  }
})

// POST /api/v1/sync/run
router.post('/run', (req, res) => {
  if (!fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const result = syncScheduler.trigger()
  if (result.started) {
    const body: SyncRunResponse = { started: true }
    res.status(202).json(body)
    return
  }
  // Refused, not queued, once the process is draining after SIGTERM (#462).
  if (result.reason === 'stopped') {
    const body: SyncRunResponse = { started: false, reason: 'shutting down' }
    res.status(503).json(body)
    return
  }
  const body: SyncRunResponse = { started: false, reason: 'already running' }
  res.status(409).json(body)
})

export default router

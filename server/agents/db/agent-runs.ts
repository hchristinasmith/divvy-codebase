// The agents' run log (prd-04 Rulings 2, 5 and 7; #31): writes and reads
// `agent_runs`, and no other table.
//
// A run log only (Ruling 7, no model calls): which agent ran, why, when, how
// it ended and how many rows it considered and wrote. A failed run's reason
// goes to the server log; there is no column for it.
//
// Ruling 5's polling stands on `sync_run_id` and `cursor`. A run triggered
// by a sync names that `sync_runs` row, and `processedSyncRunIds` is the set
// of sync runs a successful run of the agent named. The poller takes the sync
// runs outside it, so one whose only run failed is picked up again however
// many later sync runs have succeeded, and the retry is safe because a second
// insert of a proposal is a no-op. This module never reads `sync_runs`; the
// poller does the difference.
// `cursor` is the agent's own opaque place in a backlog sweep.
//
// The row type and value lists live here, not in models/, until a follow-up
// moves them (out of #31's fence). The migration repeats the lists, and
// agent-runs.test.ts pins them to it.
//
// A refused write throws SQLite's words without the row (`scrubbed`).
import type { IsoTimestamp } from '../../../models/sync.ts'
import connection from '../../db/connection.ts'
import { scrubbed } from './proposals.ts'

export const AGENT_KINDS = ['category', 'insights'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export const AGENT_TRIGGERS = ['sync', 'weekly', 'manual'] as const
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number]

export const AGENT_RUN_OUTCOMES = ['running', 'success', 'failed'] as const
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number]

// A row of `agent_runs`.
export interface AgentRun {
  id: number
  kind: AgentKind
  trigger: AgentTrigger
  started_at: IsoTimestamp
  // Null exactly while `outcome` is `running`.
  finished_at: IsoTimestamp | null
  outcome: AgentRunOutcome
  considered_count: number
  written_count: number
  // Set exactly when `trigger` is `sync`.
  sync_run_id: number | null
  cursor: string | null
}

export interface StartRun {
  kind: AgentKind
  trigger: AgentTrigger
  // Required when `trigger` is `sync`, refused otherwise.
  syncRunId?: number
}

/** Logs the start of a run, `running` with both counts 0, and returns its row. */
export async function startRun(
  start: StartRun,
  now: Date = new Date(),
  db = connection,
): Promise<AgentRun> {
  const syncRunId = start.syncRunId ?? null
  if (start.trigger === 'sync' && syncRunId === null) {
    throw new Error('a sync-triggered run must name its sync run')
  }
  if (start.trigger !== 'sync' && syncRunId !== null) {
    throw new Error('only a sync-triggered run names a sync run')
  }
  const row: Omit<AgentRun, 'id'> = {
    kind: start.kind,
    trigger: start.trigger,
    started_at: now.toISOString(),
    finished_at: null,
    outcome: 'running',
    considered_count: 0,
    written_count: 0,
    sync_run_id: syncRunId,
    cursor: null,
  }
  const [stored]: AgentRun[] = await scrubbed(
    'startRun',
    db('agent_runs').insert(row).returning('*'),
  )
  return stored
}

export interface FinishRun {
  outcome: Exclude<AgentRunOutcome, 'running'>
  consideredCount: number
  writtenCount: number
  // Left as it was when absent.
  cursor?: string | null
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return value
}

/**
 * Logs the end of a running run. True when this call finished it; false
 * when there is no such run or it had already finished, which keeps the
 * first outcome.
 */
export async function finishRun(
  id: number,
  finish: FinishRun,
  now: Date = new Date(),
  db = connection,
): Promise<boolean> {
  if (finish.outcome !== 'success' && finish.outcome !== 'failed') {
    throw new Error('outcome must be success or failed')
  }
  const changes: Partial<AgentRun> = {
    outcome: finish.outcome,
    finished_at: now.toISOString(),
    considered_count: count(finish.consideredCount, 'consideredCount'),
    written_count: count(finish.writtenCount, 'writtenCount'),
  }
  if (finish.cursor !== undefined) changes.cursor = finish.cursor
  const updated = await scrubbed(
    'finishRun',
    db('agent_runs')
      .where({ id, outcome: 'running' satisfies AgentRunOutcome })
      .update(changes),
  )
  return updated > 0
}

/** The most recently started run of `kind`. */
export async function latestRun(
  kind: AgentKind,
  db = connection,
): Promise<AgentRun | undefined> {
  return db('agent_runs')
    .where({ kind })
    .orderBy([
      { column: 'started_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .first()
}

/**
 * Every sync run a successful run of `kind` processed, ascending, each once.
 * Running and failed runs are not counted, so a sync run whose only run
 * failed stays outside the set until a run for it succeeds.
 */
export async function processedSyncRunIds(
  kind: AgentKind,
  db = connection,
): Promise<number[]> {
  const rows: { sync_run_id: number }[] = await db('agent_runs')
    .where({ kind, outcome: 'success' satisfies AgentRunOutcome })
    .whereNotNull('sync_run_id')
    .distinct('sync_run_id')
    .orderBy('sync_run_id', 'asc')
  return rows.map((r) => r.sync_run_id)
}

export interface RunFilter {
  kind?: AgentKind
  // Default 50.
  limit?: number
}

/** Runs, newest first. */
export async function listRuns(
  filter: RunFilter = {},
  db = connection,
): Promise<AgentRun[]> {
  // SQLite reads a negative limit as none, and knex drops a NaN one.
  const limit = filter.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer')
  }
  const query = db('agent_runs')
  if (filter.kind !== undefined) query.where({ kind: filter.kind })
  return query
    .orderBy([
      { column: 'started_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .limit(limit)
}

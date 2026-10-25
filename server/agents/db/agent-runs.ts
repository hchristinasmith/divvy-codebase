// The agents' run log (prd-04 Rulings 2, 5 and 7; #31): writes and reads
// `agent_runs`, and no other table.
//
// A run log only (Ruling 7, no model calls): which agent ran, why, when, how
// it ended and how many rows it considered and wrote. A failed run's reason
// goes to the server log; there is no column for it.
//
// Ruling 5's polling stands on `sync_run_id` and `cursor`. A run triggered
// by a sync names that `sync_runs` row, and `lastProcessedSyncRunId` is the
// highest one a successful run of the agent named, so the next poll starts
// after it. A failed run does not count: its sync run is picked up again,
// and the retry is safe because a second insert of a proposal is a no-op.
// `cursor` is the agent's own opaque place in a backlog sweep.
//
// The row type and value lists live here, not in models/, until a follow-up
// moves them (out of #31's fence). The migration repeats the lists, and
// agent-runs.test.ts pins them to it.
import type { IsoTimestamp } from '../../../models/sync.ts'
import connection from '../../db/connection.ts'

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
  const [stored]: AgentRun[] = await db('agent_runs').insert(row).returning('*')
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
  const updated = await db('agent_runs')
    .where({ id, outcome: 'running' satisfies AgentRunOutcome })
    .update(changes)
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
 * The highest sync run a successful run of `kind` processed, or null when
 * none has. Running and failed runs are not counted.
 */
export async function lastProcessedSyncRunId(
  kind: AgentKind,
  db = connection,
): Promise<number | null> {
  const row = await db('agent_runs')
    .where({ kind, outcome: 'success' satisfies AgentRunOutcome })
    .whereNotNull('sync_run_id')
    .max<{ id: number | null }>('sync_run_id as id')
    .first()
  return row?.id ?? null
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
  const query = db('agent_runs')
  if (filter.kind !== undefined) query.where({ kind: filter.kind })
  return query
    .orderBy([
      { column: 'started_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .limit(filter.limit ?? 50)
}

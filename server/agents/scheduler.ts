import type { Knex } from 'knex'

import type { InsightScope } from '../../models/insights.ts'
import { addDaysIso, nzCalendarDate } from '../../shared/nz-dates.ts'
import connection from '../db/connection.ts'
import { errorClass } from '../error-class.ts'
import {
  runCategoryAgent as defaultRunCategoryAgent,
  type CategoryRunOptions,
  type CategoryRunResult,
} from './category/agent.ts'
import type { AgentConfig, AgentRun, AgentRunOutcome } from './contracts.ts'
import {
  finishRun,
  latestRun,
  listRuns,
  processedSyncRunIds,
  startRun,
} from './db/agent-runs.ts'
import {
  runInsightsAgent as defaultRunInsightsAgent,
  type InsightsRunOptions,
  type InsightsRunResult,
} from './insights/agent.ts'
import { isoWeekOf } from './insights/queries.ts'

// The in-process agent scheduler (prd-04 Rulings 2, 5 and 7; #58): one per
// process, beside the sync scheduler (server/sync/scheduler.ts), whose shape
// this copies rather than adding a second kind of job runner (D7 is open).
//
// Each tick is one pass:
// - the category agent, once, for the oldest successful `sync_runs` row that
//   no successful category run has named yet (Ruling 5's polling, on
//   `processedSyncRunIds`). One sync run per tick, and the agent examines one
//   batch per run, so a backlog is swept over several ticks. No transaction
//   is linked to the sync run that wrote it, so no changed rows are named;
//   new rows have higher ids, and the cursor sweep reaches them.
// - the weekly insights pass, when it is due: every insight scope, once per
//   NZ ISO week, from WEEKLY_DUE_WEEKDAY at 00:00 Pacific/Auckland, a few
//   days after the week it reports on ends, so late-settling weekend rows
//   are in. `agent_runs` has no scope column, so the pass is done for the
//   week when its newest weekly runs since the due day, one per scope, all
//   succeeded; otherwise the next tick runs the whole pass again, which is
//   safe because a re-run skips the drafts already stored. Two guards keep
//   that count honest: a scope whose call rejects before logging a run gets
//   a failed weekly run logged by the scheduler, and a pass stops before a
//   scope once the due day has moved on, so a late retry of last week is
//   never stamped inside the new week. A scope column on `agent_runs` would
//   make both unnecessary.
//
// One pass at a time. The timer's tick and a manual run (POST
// /api/v1/agents/run) share one guard: the promise of the pass in flight,
// set synchronously before anything is awaited, so an overlapping trigger is
// refused rather than queued.
//
// Nothing happens on import. `agentScheduler` is created unstarted and only
// `server/index.ts` calls `start()`. `start()` first closes, as `failed`,
// every run still `running`: at boot nothing in this process is in flight,
// so such a run belongs to a process that died. The first tick is one
// interval after boot.
//
// Failure is recorded, not thrown. A failed agent run is in `agent_runs`
// (each agent logs its own). If an agent call rejects, the scheduler logs
// fixed text with the error's class, never its message, and the next tick
// tries again. No model is called here or by either agent (Ruling 7).

export const AGENT_INTERVAL_MS = 300_000

/** ISO weekday (Monday 1) from which the weekly insights pass is due. */
export const WEEKLY_DUE_WEEKDAY = 3

/** How many recent insights runs the weekly due check reads. */
const WEEKLY_LOOKBACK = 100

export const INSIGHT_SCOPES: readonly InsightScope[] = ['personal', 'strawb']

export type ManualRun =
  | { agent: 'category' }
  | { agent: 'insights'; scopes: readonly InsightScope[] }

export type ManualResult =
  | { agent: 'category'; runs: CategoryRunResult[] }
  | { agent: 'insights'; runs: InsightsRunResult[] }

export type AgentTriggerResult =
  | { started: true }
  | { started: false; reason: 'already_running' }
  // Between stop() and start(): the shutdown drain (#462), so no pass begins.
  | { started: false; reason: 'stopped' }

export type ManualRunResult =
  | { started: true; result: Promise<ManualResult> }
  | { started: false; reason: 'already_running' }
  | { started: false; reason: 'stopped' }

export interface AgentSchedulerState {
  /** True between `start()` and `stop()`. */
  started: boolean
  /** True from `stop()` until `start()`: no pass begins. Set by a shutdown. */
  stopped: boolean
  /** True while a pass started by this process is in flight. */
  running: boolean
  /** When the timer next fires, as ISO-8601 UTC; null when not started. */
  nextRunAt: string | null
}

export interface AgentSchedulerDeps {
  /** Defaults to the app's database connection. */
  db?: Knex
  /** Defaults to the system clock. Passed to every agent run. */
  now?: () => Date
  /** Defaults to AGENT_INTERVAL_MS. */
  intervalMs?: number
  runCategoryAgent?: (
    options: CategoryRunOptions,
    clock: () => Date,
    db: Knex,
  ) => Promise<CategoryRunResult>
  runInsightsAgent?: (
    scope: InsightScope,
    options: InsightsRunOptions,
    clock: () => Date,
    db: Knex,
  ) => Promise<InsightsRunResult>
  /** Passed to every category run; the agent's defaults when absent. */
  categoryConfig?: Partial<AgentConfig>
}

export interface AgentScheduler {
  /**
   * Closes stale `running` runs, then starts the timer, and lifts an earlier
   * `stop()`. Throws if already started. The close is the first pass in
   * flight; `whenIdle()` waits for it.
   */
  start(): void
  /**
   * Stops the timer and refuses every new pass (`trigger()` and `runNow()`
   * answer `stopped`) until `start()`. A pass in flight finishes. Safe to call
   * twice.
   */
  stop(): void
  /**
   * Starts one scheduled pass unless one is in flight or the scheduler is
   * stopped. Never waits.
   */
  trigger(): AgentTriggerResult
  /** Starts one manual run unless a pass is in flight or the scheduler is stopped. */
  runNow(run: ManualRun): ManualRunResult
  getState(): AgentSchedulerState
  /** Resolves once no pass is in flight. Never rejects. */
  whenIdle(): Promise<void>
}

/** The NZ calendar day of the latest weekly due moment at or before `at`. */
export function weeklyDueDay(at: Date): string {
  const today = nzCalendarDate(at)
  // getUTCDay of the civil date at UTC midnight is its weekday; Monday 1.
  const weekday = ((new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1
  const due = addDaysIso(today, WEEKLY_DUE_WEEKDAY - weekday)
  return due <= today ? due : addDaysIso(due, -7)
}

export function createAgentScheduler(
  deps: AgentSchedulerDeps = {},
): AgentScheduler {
  const db = deps.db ?? connection
  const now = deps.now ?? (() => new Date())
  const runCategory = deps.runCategoryAgent ?? defaultRunCategoryAgent
  const runInsights = deps.runInsightsAgent ?? defaultRunInsightsAgent
  const config = deps.categoryConfig

  let current: Promise<unknown> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let nextTickAt: number | null = null
  // Set by stop(), cleared by start(). A scheduler never started is not
  // stopped, so it still runs passes (the route tests rely on that).
  let stopped = false

  /** Runs `work` as the pass in flight; the caller has checked the guard. */
  function claim<T>(work: () => Promise<T>): Promise<T> {
    const pass = work()
    const settled = pass.then(
      () => undefined,
      () => undefined,
    )
    current = settled.finally(() => {
      current = null
    })
    return pass
  }

  async function closeStaleRuns(): Promise<void> {
    try {
      // Only the running rows, not the whole log; the counts are kept as
      // they stand.
      const runs: Pick<AgentRun, 'id' | 'considered_count' | 'written_count'>[] =
        await db('agent_runs')
          .where({ outcome: 'running' satisfies AgentRunOutcome })
          .orderBy('id', 'asc')
          .select('id', 'considered_count', 'written_count')
      for (const run of runs) {
        await finishRun(
          run.id,
          {
            outcome: 'failed',
            consideredCount: run.considered_count,
            writtenCount: run.written_count,
          },
          now(),
          db,
        )
      }
    } catch (err) {
      console.error('agent scheduler: could not close stale runs', errorClass(err))
    }
  }

  async function categoryStep(): Promise<void> {
    const processed = new Set(await processedSyncRunIds('category', db))
    const done: { id: number }[] = await db('sync_runs')
      .where({ outcome: 'success' })
      .orderBy('id', 'asc')
      .select('id')
    const next = done.find((row) => !processed.has(row.id))
    if (next === undefined) return
    await runCategory({ trigger: 'sync', syncRunId: next.id, config }, now, db)
  }

  async function weeklyDue(at: Date): Promise<boolean> {
    const dueDay = weeklyDueDay(at)
    const runs = await listRuns({ kind: 'insights', limit: WEEKLY_LOOKBACK }, db)
    const sinceDue = runs.filter(
      (run) =>
        run.trigger === 'weekly' &&
        nzCalendarDate(new Date(run.started_at)) >= dueDay,
    )
    const newest = sinceDue.slice(0, INSIGHT_SCOPES.length)
    return !(
      newest.length === INSIGHT_SCOPES.length &&
      newest.every((run) => run.outcome === 'success')
    )
  }

  // A scope whose call rejected before logging a run would leave no row, and
  // the due check, which cannot see scopes, could then read two runs of the
  // other scope as a finished pass. So the scheduler logs the failed run.
  async function logRejectedWeekly(before: number | undefined): Promise<void> {
    try {
      if ((await latestRun('insights', db))?.id !== before) return
      const run = await startRun({ kind: 'insights', trigger: 'weekly' }, now(), db)
      await finishRun(run.id, { outcome: 'failed', consideredCount: 0, writtenCount: 0 }, now(), db)
    } catch (err) {
      console.error('agent scheduler: could not log rejected insights run', errorClass(err))
    }
  }

  async function weeklyStep(): Promise<void> {
    const at = now()
    const dueDay = weeklyDueDay(at)
    if (!(await weeklyDue(at))) return
    // The week before the due day's week: the one that ended a few days ago.
    const period = isoWeekOf(addDaysIso(dueDay, -7))
    for (const scope of INSIGHT_SCOPES) {
      // A pass that crosses into the next due day stops: its runs would be
      // stamped inside the new week and read as that week's pass.
      if (weeklyDueDay(now()) !== dueDay) return
      const before = (await latestRun('insights', db))?.id
      try {
        await runInsights(scope, { trigger: 'weekly', period }, now, db)
      } catch (err) {
        console.error('agent scheduler: insights run rejected', errorClass(err))
        await logRejectedWeekly(before)
      }
    }
  }

  async function scheduledPass(): Promise<void> {
    try {
      await categoryStep()
    } catch (err) {
      console.error('agent scheduler: category run rejected', errorClass(err))
    }
    try {
      await weeklyStep()
    } catch (err) {
      console.error('agent scheduler: weekly insights check rejected', errorClass(err))
    }
  }

  async function manualPass(run: ManualRun): Promise<ManualResult> {
    if (run.agent === 'category') {
      return {
        agent: 'category',
        runs: [await runCategory({ trigger: 'manual', config }, now, db)],
      }
    }
    const runs: InsightsRunResult[] = []
    for (const scope of run.scopes) {
      runs.push(await runInsights(scope, { trigger: 'manual' }, now, db))
    }
    return { agent: 'insights', runs }
  }

  function trigger(): AgentTriggerResult {
    if (stopped) return { started: false, reason: 'stopped' }
    if (current !== null) return { started: false, reason: 'already_running' }
    void claim(scheduledPass)
    return { started: true }
  }

  return {
    start() {
      if (timer !== null) throw new Error('agent scheduler already started')
      stopped = false
      const ms = deps.intervalMs ?? AGENT_INTERVAL_MS
      // Nothing is in flight before the timer exists, so the close always runs.
      if (current === null) void claim(closeStaleRuns)
      nextTickAt = now().getTime() + ms
      timer = setInterval(() => {
        nextTickAt = now().getTime() + ms
        trigger()
      }, ms)
      // The HTTP server keeps the process alive; the timer alone must not.
      timer.unref()
    },

    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
      nextTickAt = null
      stopped = true
    },

    trigger,

    runNow(run) {
      if (stopped) return { started: false, reason: 'stopped' }
      if (current !== null) return { started: false, reason: 'already_running' }
      return { started: true, result: claim(() => manualPass(run)) }
    },

    getState() {
      return {
        started: timer !== null,
        stopped,
        running: current !== null,
        nextRunAt:
          timer === null || nextTickAt === null
            ? null
            : new Date(nextTickAt).toISOString(),
      }
    },

    async whenIdle() {
      await current
    },
  }
}

/** The process's agent scheduler. Unstarted: only `server/index.ts` starts it. */
export const agentScheduler: AgentScheduler = createAgentScheduler()

// The insights agent (prd-04 Rulings 2, 3, 7 and 8; #47): one deterministic
// run for one scope and one ISO week. Ruling 7: no model call, no prompt,
// no tokens and no network; the run is the typed queries (./queries.ts)
// filled into the template (./prompt.ts) and written to `insights` through
// `insertInsight`, which validates each chart spec on write (Ruling 8).
//
// It writes only the inbox: `insights` and its own `agent_runs` row.
// Nothing schedules or triggers it yet (#58).
//
// One attempt, no retry. A run is `failed` when anything threw or the
// validator refused any draft's spec; a refused draft stores nothing, and
// the others are still written. An insight already stored for the same kind,
// scope and period, dismissed or not, is skipped, so a re-run neither
// duplicates nor resurrects one (and does not refresh its numbers).
//
// The clock is read once at start, and that reading is the run's: the
// period when none is given, `started_at`, and every insight's `created_at`.
// It is read once more at finish, for `finished_at`. A caller that wants a
// fixed time passes a clock that always answers the same instant.
//
// Logs name the draft's kind and the validator's reason and path, or a thrown
// error's class; never a label, an amount or a row, and never an error's
// message, which for a database error can hold its SQL and bound values.
import type { ChartSpecRejection, InsightKind, InsightScope } from '../../../models/insights.ts'
import connection from '../../db/connection.ts'
import { finishRun, startRun, type StartRun } from '../db/agent-runs.ts'
import { insertInsight, listInsights } from '../db/insights.ts'
import { buildDrafts } from './prompt.ts'
import { collectAggregates, lastCompleteWeek, weekRange } from './queries.ts'
import { errorClass } from '../../error-class.ts'

export interface InsightsRunOptions {
  // An ISO week label; the last complete NZ week before `now` when absent.
  period?: string
  // Default `manual`. The insights agent is never sync-triggered.
  trigger?: Exclude<StartRun['trigger'], 'sync'>
}

export interface InsightsRunResult {
  runId: number
  outcome: 'success' | 'failed'
  period: string
  // Ledger rows read for the week's analysis window.
  considered: number
  written: number
  // Drafts already stored for this kind, scope and period.
  skipped: number
  rejected: { kind: InsightKind; reason: ChartSpecRejection; path: string }[]
}

/** Runs the insights agent once for `scope` and one week, and logs the run. */
export async function runInsightsAgent(
  scope: InsightScope,
  options: InsightsRunOptions = {},
  clock: () => Date = () => new Date(),
  db = connection,
): Promise<InsightsRunResult> {
  if (scope !== 'personal' && scope !== 'strawb') {
    throw new Error('scope must be personal or strawb')
  }
  const trigger = options.trigger ?? 'manual'
  if (trigger !== 'manual' && trigger !== 'weekly') {
    throw new Error('trigger must be manual or weekly')
  }
  // The one start reading: see the header.
  const now = clock()
  const period = options.period ?? lastCompleteWeek(now)
  // Refuses, with weekRange's own text and before any run is logged, a period
  // that names no week or whose analysis window leaves the years 0000 to 9999.
  weekRange(period)

  const run = await startRun({ kind: 'insights', trigger }, now, db)
  let outcome: InsightsRunResult['outcome'] = 'success'
  let considered = 0
  let written = 0
  let skipped = 0
  const rejected: InsightsRunResult['rejected'] = []

  try {
    const aggregates = await collectAggregates(scope, period, db)
    considered = aggregates.ledgerRowCount
    for (const draft of buildDrafts(aggregates, scope)) {
      const stored = await listInsights({ kind: draft.kind, scope, includeDismissed: true }, db)
      if (stored.some((insight) => insight.period === draft.period)) {
        skipped += 1
        continue
      }
      const result = await insertInsight(draft, now, db)
      if (result.ok) {
        written += 1
      } else {
        rejected.push({ kind: draft.kind, reason: result.reason, path: result.path })
        console.error('insights agent: spec rejected', draft.kind, result.reason, result.path)
      }
    }
    if (rejected.length > 0) outcome = 'failed'
  } catch (err) {
    outcome = 'failed'
    console.error('insights agent: run failed', errorClass(err))
  } finally {
    await finishRun(run.id, { outcome, consideredCount: considered, writtenCount: written }, clock(), db)
  }

  return { runId: run.id, outcome, period, considered, written, skipped, rejected }
}

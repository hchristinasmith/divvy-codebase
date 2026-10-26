// The category agent (prd-04 Rulings 2, 5, 6 and 7; #42): one run proposes
// categories from rules learned from Hannah's corrections (./rules.ts).
// Ruling 7: no model call, no prompt, no tokens and no network; a rule is
// the only origin, and a merchant she has never corrected gets no proposal.
//
// It writes only the inbox: `category_proposals` through `insertProposal`,
// and its own `agent_runs` row. Nothing schedules or triggers it yet (#58,
// which calls it with `trigger: 'sync'`, the sync run and the changed rows).
//
// A run examines two sets of rows (Ruling 5):
// - the changed rows the caller names (`transactionIds`), wherever the
//   cursor is, and not counted against the batch size;
// - the next batch of the backlog sweep, ascending by id after the cursor.
// Examining a row means: it has a rule for its scope and merchant, its
// category differs from the rule's, so a pending proposal is inserted. A
// pair already stored, in any status, is skipped by the inbox's unique
// index, so a rejected pair never comes back (Done-when 3) and examining a
// row twice writes nothing twice.
//
// The cursor is `{"rules": <hash of the rule set>, "after": <last id>}`,
// stored only by a successful run. The next run resumes from the newest
// successful run's cursor while the rule set is the same, and restarts from
// the beginning when a rule appeared, vanished or changed category, so a
// rule learned today reaches rows the sweep passed yesterday. A missing or
// malformed cursor restarts too. Re-examining is safe for the same reason a
// failed run's retry is: inserts are idempotent.
//
// Disabled (`enabled: false`) returns before a run is logged. A logged
// `success` would mark its sync run processed, and `failed` would be a false
// alarm.
//
// One attempt, no retry. A throw ends the run `failed` with the proposals
// written so far kept and no cursor stored, so the next run resumes from the
// last good place. Logs carry fixed text or a thrown error's class; never a
// row, a merchant string or an error's message, which for a database error
// can hold its SQL and bound values.
import { hash } from 'node:crypto'

import connection from '../../db/connection.ts'
import type { AgentConfig } from '../contracts.ts'
import { finishRun, listRuns, startRun } from '../db/agent-runs.ts'
import { insertProposal } from '../db/proposals.ts'
import { loadCandidates, loadEvidence, type Candidate } from './read.ts'
import { deriveRules, proposalOf, type Rule } from './rules.ts'

// The class of what was thrown, as the routes log it.
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

// Ruling 7's N is 2; a batch of 500 sweeps a year of history in a few syncs.
const DEFAULTS: AgentConfig = { batchSize: 500, ruleThreshold: 2, enabled: true }

// How far back to look for the last successful run's cursor. Further back
// than this the sweep restarts, which is safe.
const RESUME_LOOKBACK = 20

export interface CategoryRunOptions {
  // Default `manual`. The category agent is never weekly.
  trigger?: 'sync' | 'manual'
  // Required exactly when `trigger` is `sync`.
  syncRunId?: number
  // New or changed rows, examined regardless of the cursor.
  transactionIds?: number[]
  config?: Partial<AgentConfig>
}

export interface CategoryRunResult {
  // Null when disabled: no run was logged.
  runId: number | null
  outcome: 'success' | 'failed' | 'disabled'
  // Rows examined.
  considered: number
  written: number
  // Pairs already stored, in any status.
  skipped: number
  // What this run stored; null unless it succeeded.
  cursor: string | null
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const ruleId = (scope: string, key: string) => `${scope}|${key}`

// The rule set's identity: which merchants have a rule, and to what. Support
// is left out, since a change in it can make no other row match.
function fingerprint(rules: readonly Rule[]): string {
  return hash('sha256', JSON.stringify(rules.map((r) => [r.scope, r.key, r.category])), 'hex')
}

interface Cursor {
  rules: string
  after: number
}

// A stored cursor, or null when it is not one this agent wrote.
function parseCursor(text: string): Cursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (!('rules' in parsed) || !('after' in parsed)) return null
  const { rules, after } = parsed
  if (typeof rules !== 'string' || !/^[0-9a-f]{64}$/.test(rules)) return null
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return null
  return { rules, after }
}

// The newest successful run's cursor, skipping the run just started.
async function lastCursor(runId: number, db: typeof connection): Promise<Cursor | null> {
  const runs = await listRuns({ kind: 'category', limit: RESUME_LOOKBACK }, db)
  const last = runs.find((r) => r.id !== runId && r.outcome === 'success' && r.cursor !== null)
  return last?.cursor ? parseCursor(last.cursor) : null
}

/** Runs the category agent once and logs the run. */
export async function runCategoryAgent(
  options: CategoryRunOptions = {},
  clock: () => Date = () => new Date(),
  db = connection,
): Promise<CategoryRunResult> {
  // Every refusal comes before a run is logged.
  const trigger = options.trigger ?? 'manual'
  if (trigger !== 'sync' && trigger !== 'manual') {
    throw new Error('trigger must be sync or manual')
  }
  if ((trigger === 'sync') !== (options.syncRunId !== undefined)) {
    throw new Error('syncRunId must be given exactly when trigger is sync')
  }
  if (options.syncRunId !== undefined && !positiveInteger(options.syncRunId)) {
    throw new Error('syncRunId must be a positive integer')
  }
  const config: AgentConfig = { ...DEFAULTS, ...options.config }
  if (!positiveInteger(config.batchSize)) throw new Error('batchSize must be a positive integer')
  if (!positiveInteger(config.ruleThreshold)) throw new Error('ruleThreshold must be a positive integer')
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const changed = options.transactionIds ?? []
  if (!Array.isArray(changed) || !changed.every(positiveInteger)) {
    throw new Error('transactionIds must be positive integers')
  }

  if (!config.enabled) {
    console.info('category agent: disabled, no run')
    return { runId: null, outcome: 'disabled', considered: 0, written: 0, skipped: 0, cursor: null }
  }

  // The one start reading: `started_at` and every proposal's `created_at`.
  const now = clock()
  const run = await startRun({ kind: 'category', trigger, syncRunId: options.syncRunId }, now, db)
  let outcome: 'success' | 'failed' = 'success'
  let considered = 0
  let written = 0
  let skipped = 0
  let cursor: string | null = null

  try {
    const evidence = await loadEvidence(db)
    const rules = deriveRules(evidence.corrections, evidence.rejections, config.ruleThreshold)
    const byMerchant = new Map(rules.map((r) => [ruleId(r.scope, r.key), r]))
    const rulesId = fingerprint(rules)
    const previous = await lastCursor(run.id, db)
    const after = previous !== null && previous.rules === rulesId ? previous.after : 0

    const examined = new Set<number>()
    const examine = async (row: Candidate) => {
      if (examined.has(row.id)) return
      examined.add(row.id)
      considered += 1
      if (row.key === null) return
      const rule = byMerchant.get(ruleId(row.scope, row.key))
      if (rule === undefined || rule.category === row.category) return
      const { confidence, reason } = proposalOf(rule)
      const stored = await insertProposal(
        {
          transaction_id: row.id,
          current_category: row.category,
          proposed_category: rule.category,
          confidence,
          reason,
          origin: 'rule',
        },
        now,
        db,
      )
      // `unknown_category` cannot happen: a rule's category already passed
      // the same check (Ruling 6).
      if (stored.inserted) written += 1
      else if (stored.reason === 'duplicate') skipped += 1
    }

    if (changed.length > 0) {
      for (const row of await loadCandidates(db, { ids: [...new Set(changed)] })) await examine(row)
    }
    let last = after
    for (const row of await loadCandidates(db, { afterId: after, limit: config.batchSize })) {
      await examine(row)
      last = row.id
    }
    cursor = JSON.stringify({ rules: rulesId, after: last } satisfies Cursor)
  } catch (err) {
    outcome = 'failed'
    cursor = null
    console.error('category agent: run failed', errorClass(err))
  } finally {
    await finishRun(
      run.id,
      {
        outcome,
        consideredCount: considered,
        writtenCount: written,
        ...(outcome === 'success' ? { cursor } : {}),
      },
      clock(),
      db,
    )
  }

  return { runId: run.id, outcome, considered, written, skipped, cursor }
}

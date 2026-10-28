// The category agent (prd-04 Rulings 2, 4, 5, 6, 7 and 9; #42, #430): one
// run proposes categories from rules learned from Hannah's corrections
// (./rules.ts), then sends the rows no rule covers to the model (Ruling 9).
//
// It writes only the inbox: `category_proposals` through `insertProposal`,
// and its own `agent_runs` row, opened and closed by the one model client
// (../llm/client.ts) whether or not the model is called. The scheduler
// (../scheduler.ts) calls it with `trigger: 'sync'` and the sync run.
//
// The rules pass examines two sets of rows (Ruling 5):
// - the changed rows the caller names (`transactionIds`), wherever the
//   cursor is, and not counted against the batch size;
// - the next batch of the backlog sweep, ascending by id after the cursor.
// Examining a row means: it has a rule for its scope and merchant, its
// category differs from the rule's, so a pending proposal is inserted, origin
// `rule`. A pair already stored, in any status, is skipped by the inbox's
// unique index, so a rejected pair never comes back (Done-when 3) and
// examining a row twice writes nothing twice.
//
// The model pass sweeps its own batch, ascending by id after its own
// position. A row with a rule for its scope and merchant is never sent, nor
// is a row with no merchant key. The rest go to the model in batches of
// the client config's size, one call each (./prompt.ts builds the request
// from Ruling 4's fields only, with Hannah's corrections and rejections of
// the same merchants as examples). Changed rows are not sent again: a row
// is sent at most once. Every entry of a reply is checked: a row of the
// batch, a category in data/cats.js (Ruling 6), not the row's current
// category, the first for its row. Anything else is discarded and counted.
// What is stored is origin `claude` with a fixed confidence and a fixed
// reason, so no model text reaches the inbox. An unreadable reply discards
// its batch's proposals, the rows stay sent, and the run goes on.
//
// The cursor is `{"rules": <hash of the rule set>, "after": <last id>,
// "model": <last id the model pass is past>}`, stored by every finished run,
// success, blocked or failed. The next run resumes from the newest finished
// run whose cursor parses. The rules position restarts from the beginning
// when a rule appeared, vanished or changed category, so a rule learned
// today reaches rows the sweep passed yesterday; re-examining is safe
// because inserts are idempotent. The model position never restarts, so a
// row is never sent twice. A cursor without `model` (from before Ruling 9)
// resumes the model pass from the beginning.
//
// The model position moves past a batch only when its call returned. A
// blocked call (the kill switch or the daily budget, in the client) was not
// sent: the run stops calling, keeps the proposals already written, ends
// `blocked` and stores the position of what was sent. A call that throws
// leaves its batch unsent too, and the run ends `failed`.
//
// Disabled (`enabled: false`) returns before a run is logged. A logged
// `success` would mark its sync run processed, and `failed` would be a false
// alarm.
//
// One attempt, no retry. A throw ends the run `failed` with the proposals
// written so far kept. Its cursor keeps the rules position it started from
// unless the rules pass finished, and the model position of the last
// returned call. Logs carry fixed text or a thrown error's class; never a
// row, a merchant string, a prompt, a reply or an error's message, which for
// a database error can hold its SQL and bound values.
import { hash } from 'node:crypto'

import connection from '../../db/connection.ts'
import { errorClass } from '../../error-class.ts'
import { parseProposedCategory, type AgentConfig, type ProposalOrigin } from '../contracts.ts'
import { listRuns } from '../db/agent-runs.ts'
import { insertProposal } from '../db/proposals.ts'
import { startModelRun, type ModelRunDeps } from '../llm/client.ts'
import { loadLlmConfig } from '../llm/config.ts'
import {
  categoryRequest,
  readCategoryReply,
  replyText,
  type CorrectionExample,
  type PromptExamples,
  type RejectionExample,
} from './prompt.ts'
import { loadCandidates, loadEvidence, loadExamples, loadModelRows, type Candidate, type Keyed } from './read.ts'
import { deriveRules, proposalOf, type Rule } from './rules.ts'

// Ruling 7's N is 2; a batch of 500 sweeps a year of history in a few syncs.
const DEFAULTS: AgentConfig = { batchSize: 500, ruleThreshold: 2, enabled: true }

// How far back to look for the last finished run's cursor. Further back
// than this the sweep restarts, which is safe for the rules; the model pass
// then starts over too.
const RESUME_LOOKBACK = 20

// Examples per call, of each kind, newest first.
const EXAMPLES_PER_CALL = 20

// A model proposal's confidence and reason are fixed: no number or text from
// a reply is stored. The confidence is a non-integer real in (0, 1), as the
// inbox's CHECK requires.
const MODEL_CONFIDENCE = 0.5
const MODEL_REASON = 'Suggested by Claude from the merchant, description and amount.'

export interface CategoryRunOptions {
  // Default `manual`. The category agent is never weekly.
  trigger?: 'sync' | 'manual'
  // Required exactly when `trigger` is `sync`.
  syncRunId?: number
  // New or changed rows, examined by the rules regardless of the cursor.
  transactionIds?: number[]
  config?: Partial<AgentConfig>
}

/** What the model client is given; tests pass a fake transport and env. */
export type CategoryRunDeps = Pick<ModelRunDeps, 'transport' | 'env'>

export interface CategoryRunResult {
  // Null when disabled: no run was logged.
  runId: number | null
  outcome: 'success' | 'failed' | 'blocked' | 'disabled'
  // Rows examined, by either pass.
  considered: number
  written: number
  // Pairs already stored, in any status.
  skipped: number
  // Reply entries not stored: an unknown category or row, the row's current
  // category, a second entry for a row, or every row of an unreadable reply.
  discarded: number
  // What this run stored; null when disabled or nothing was stored.
  cursor: string | null
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const position = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const ruleId = (scope: string, key: string) => `${scope}|${key}`

// The rule set's identity: which merchants have a rule, and to what. Support
// is left out, since a change in it can make no other row match.
function fingerprint(rules: readonly Rule[]): string {
  return hash('sha256', JSON.stringify(rules.map((r) => [r.scope, r.key, r.category])), 'hex')
}

interface Cursor {
  rules: string
  after: number
  model: number
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
  if (!position(after)) return null
  // Absent in a cursor stored before Ruling 9.
  const model = 'model' in parsed ? parsed.model : 0
  if (!position(model)) return null
  return { rules, after, model }
}

// The newest finished run's cursor that parses, skipping the run just
// started. A failed or blocked run's counts too: it stored what it sent.
async function lastCursor(runId: number, db: typeof connection): Promise<Cursor | null> {
  const runs = await listRuns({ kind: 'category', limit: RESUME_LOOKBACK }, db)
  for (const r of runs) {
    if (r.id === runId || r.outcome === 'running' || r.cursor === null) continue
    const cursor = parseCursor(r.cursor)
    if (cursor !== null) return cursor
  }
  return null
}

// The examples about the merchants of one batch, newest first.
function examplesFor(
  all: { corrections: Keyed<CorrectionExample>[]; rejections: Keyed<RejectionExample>[] },
  merchants: ReadonlySet<string>,
): PromptExamples {
  const pick = <T>(list: Keyed<T>[]) =>
    list.filter((k) => merchants.has(ruleId(k.scope, k.key))).slice(0, EXAMPLES_PER_CALL).map((k) => k.example)
  return { corrections: pick(all.corrections), rejections: pick(all.rejections) }
}

/** Runs the category agent once and logs the run. */
export async function runCategoryAgent(
  options: CategoryRunOptions = {},
  clock: () => Date = () => new Date(),
  db = connection,
  deps: CategoryRunDeps = {},
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
  // An absent or undefined field takes its default; a spread would let an
  // explicit `undefined` (an unset env var, say) override it.
  const given = options.config ?? {}
  const config: AgentConfig = {
    batchSize: given.batchSize ?? DEFAULTS.batchSize,
    ruleThreshold: given.ruleThreshold ?? DEFAULTS.ruleThreshold,
    enabled: given.enabled ?? DEFAULTS.enabled,
  }
  if (!positiveInteger(config.batchSize)) throw new Error('batchSize must be a positive integer')
  if (!positiveInteger(config.ruleThreshold)) throw new Error('ruleThreshold must be a positive integer')
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const changed = options.transactionIds ?? []
  if (!Array.isArray(changed) || !changed.every(positiveInteger)) {
    throw new Error('transactionIds must be positive integers')
  }

  if (!config.enabled) {
    console.info('category agent: disabled, no run')
    return { runId: null, outcome: 'disabled', considered: 0, written: 0, skipped: 0, discarded: 0, cursor: null }
  }

  // The one start reading: `started_at` and every proposal's `created_at`.
  const now = clock()
  const run = await startModelRun(
    { kind: 'category', trigger, syncRunId: options.syncRunId },
    { transport: deps.transport, env: deps.env, clock, db },
  )
  let failed = false
  let blocked = false
  let written = 0
  let skipped = 0
  let discarded = 0
  // Null until the rule set is known; no cursor is stored before then.
  let rulesId: string | null = null
  let after = 0
  let modelAfter = 0
  const examined = new Set<number>()

  try {
    const evidence = await loadEvidence(db)
    const rules = deriveRules(evidence.corrections, evidence.rejections, config.ruleThreshold)
    const byMerchant = new Map(rules.map((r) => [ruleId(r.scope, r.key), r]))
    const previous = await lastCursor(run.id, db)
    rulesId = fingerprint(rules)
    after = previous !== null && previous.rules === rulesId ? previous.after : 0
    modelAfter = previous?.model ?? 0

    const store = async (
      row: { id: number; category: string | null },
      proposed: string,
      origin: ProposalOrigin,
      made: { confidence: number; reason: string },
    ) => {
      const stored = await insertProposal(
        {
          transaction_id: row.id,
          current_category: row.category,
          proposed_category: proposed,
          confidence: made.confidence,
          reason: made.reason,
          origin,
        },
        now,
        db,
      )
      if (stored.inserted) written += 1
      else if (stored.reason === 'duplicate') skipped += 1
      else discarded += 1
    }

    // ---- The rules pass (Ruling 7) ----
    const examine = async (row: Candidate) => {
      if (examined.has(row.id)) return
      examined.add(row.id)
      if (row.key === null) return
      const rule = byMerchant.get(ruleId(row.scope, row.key))
      if (rule === undefined || rule.category === row.category) return
      // A rule's category already passed the taxonomy check (Ruling 6).
      await store(row, rule.category, 'rule', proposalOf(rule))
    }

    if (changed.length > 0) {
      for (const row of await loadCandidates(db, { ids: [...new Set(changed)] })) await examine(row)
    }
    let last = after
    for (const row of await loadCandidates(db, { afterId: after, limit: config.batchSize })) {
      await examine(row)
      last = row.id
    }
    after = last

    // ---- The model pass (Ruling 9) ----
    const perCall = loadLlmConfig(deps.env).batchSize
    const sweep = await loadCandidates(db, { afterId: modelAfter, limit: config.batchSize })
    // Each batch with the id the model position may move to once its call
    // returns: its last row, or the sweep's end for the final batch, so the
    // rows between batches that are not sent are passed with them.
    const batches: { rows: Candidate[]; through: number }[] = []
    let open: Candidate[] = []
    for (const row of sweep) {
      examined.add(row.id)
      if (row.key !== null && !byMerchant.has(ruleId(row.scope, row.key))) open.push(row)
      if (open.length === perCall) {
        batches.push({ rows: open, through: row.id })
        open = []
      }
    }
    const end = sweep.at(-1)?.id ?? modelAfter
    if (open.length > 0) batches.push({ rows: open, through: end })

    const examples = batches.length > 0 ? await loadExamples(db) : { corrections: [], rejections: [] }
    for (const batch of batches) {
      const rows = await loadModelRows(db, batch.rows.map((r) => r.id))
      const merchants = new Set(batch.rows.map((r) => ruleId(r.scope, r.key ?? '')))
      const result = await run.complete(categoryRequest(rows, examplesFor(examples, merchants)))
      if (result.status === 'blocked') {
        blocked = true
        break
      }
      modelAfter = batch.through
      const reply = readCategoryReply(replyText(result.message), rows.length)
      if (reply === null) {
        console.warn('category agent: unreadable model reply, batch discarded')
        discarded += rows.length
        continue
      }
      discarded += reply.unusable
      const byHandle = new Map(rows.map((r, i) => [i + 1, r]))
      const answered = new Set<number>()
      for (const entry of reply.entries) {
        const row = byHandle.get(entry.row)
        const proposed = parseProposedCategory(entry.category)
        if (row === undefined || answered.has(entry.row) || proposed === null || proposed === row.category) {
          discarded += 1
          continue
        }
        answered.add(entry.row)
        await store(row, proposed, 'claude', { confidence: MODEL_CONFIDENCE, reason: MODEL_REASON })
      }
    }
    if (!blocked) modelAfter = Math.max(modelAfter, end)
  } catch (err) {
    failed = true
    console.error('category agent: run failed', errorClass(err))
  }

  const cursor = rulesId === null ? null : JSON.stringify({ rules: rulesId, after, model: modelAfter } satisfies Cursor)
  await run.finish({
    outcome: failed ? 'failed' : 'success',
    consideredCount: examined.size,
    writtenCount: written,
    ...(cursor === null ? {} : { cursor }),
  })

  return {
    runId: run.id,
    outcome: failed ? 'failed' : blocked ? 'blocked' : 'success',
    considered: examined.size,
    written,
    skipped,
    discarded,
    cursor,
  }
}

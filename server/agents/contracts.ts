// The background agents' contract (prd-04 Ruling 2, Ruling 6, Ruling 7,
// Ruling 9). Every later prd-04 issue builds against this file. The inbox
// columns below change only by amending prd-04.
//
// Ruling 9 amends Ruling 7 for the category agent only. Rules learned from
// `category_corrections` run first (origin `rule`); rows that no rule covers
// go to the model in batches, and what it proposes carries origin `claude`.
// Every model call goes through one client with a kill switch and a daily
// token budget, and a run that called the model logs its model, tokens and
// cost on its `agent_runs` row. A run the kill switch or the budget stopped
// ends `blocked`, and still logs the usage of any calls it made first.
//
// The insights agent stays on Ruling 7: no model. It is fixed queries and a
// template (its row and chart spec are models/insights.ts), and its runs
// carry no usage.
//
// The category agent writes only this inbox (Ruling 2):
//
//   category_proposals  id, transaction_id, current_category,
//                       proposed_category, confidence, reason,
//                       origin (rule | claude),
//                       status (pending | accepted | rejected), created_at
//
// A proposal names a category from data/cats.js exactly, or is discarded
// (Ruling 6).

import type { IsoTimestamp } from '../../models/sync.ts'
import { isKnownCategory } from '../db/categories.ts'

// ---- category_proposals (Ruling 2, Ruling 7, Ruling 9) ----

export const PROPOSAL_ORIGINS = ['rule', 'claude'] as const
export type ProposalOrigin = (typeof PROPOSAL_ORIGINS)[number]

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export interface CategoryProposal {
  id: number
  transaction_id: number
  // The transaction's category when the proposal was made.
  current_category: string | null
  // Always a name from data/cats.js; see `parseProposedCategory`.
  proposed_category: string
  // 0..1. Not money.
  confidence: number
  reason: string
  origin: ProposalOrigin
  status: ProposalStatus
  created_at: IsoTimestamp
}

// ---- agent_runs (prd-04 Rulings 2, 5, 7 and 9; #31, #428) ----

export const AGENT_KINDS = ['category', 'insights'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export const AGENT_TRIGGERS = ['sync', 'weekly', 'manual'] as const
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number]

export const AGENT_RUN_OUTCOMES = ['running', 'success', 'failed', 'blocked'] as const
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
  // Null on a run with no model call (Ruling 9).
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_micro_usd: number | null
}

// ---- Proposed categories (Ruling 6) ----

/**
 * The proposed name if it is exactly a category in data/cats.js, else null.
 * No trimming or case folding: a near-miss is discarded, not repaired.
 */
export function parseProposedCategory(value: unknown): string | null {
  return typeof value === 'string' && isKnownCategory(value) ? value : null
}

// ---- Configuration (Ruling 7, Ruling 9) ----

// Resolved values only. server/agents/llm/config.ts reads the model path's
// settings from the environment (the Anthropic API key, AGENT_KILL_SWITCH,
// AGENT_DAILY_TOKEN_BUDGET). Nothing reads the rest from the environment:
// they are constants in server/agents/category/agent.ts and llm/config.ts.
export interface AgentConfig {
  batchSize: number
  // N in Ruling 7: how many matching corrections, with none later away from
  // the category, make a rule. Default 2.
  ruleThreshold: number
  // False stops both agents.
  enabled: boolean
  // Read by the category agent's model path only (Ruling 9). Optional so a
  // rules-only config still type-checks; llm/config.ts supplies their values.
  // Tokens the model path may spend in a day, input and output together.
  dailyTokenBudget?: number
  // The model id the category agent calls.
  categoryModel?: string
  // True stops every model call; the rules still run.
  killSwitch?: boolean
}

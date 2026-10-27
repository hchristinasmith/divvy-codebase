// The model path's configuration (prd-04 Rulings 1, 4 and 9; #429).
//
// This is the only module that reads the Anthropic API key from the
// environment, and the only place a model id is written down. The key is a
// Fly secret (Ruling 1); it never reaches the MCP, whose entry refuses to
// start with any `ANTHROPIC_` variable set (mcp/guard-env.ts, prd-03
// Ruling 2).
//
// `loadLlmConfig` reads the environment afresh on every model call
// (./client.ts) and nothing caches it, so the kill switch applies to the
// next call whatever the process environment holds then (Ruling 4).
//
// - `AGENT_KILL_SWITCH`: any non-blank value is on, `0` and `false`
//   included. A typo stops spending rather than allowing it.
// - `AGENT_DAILY_TOKEN_BUDGET`: input and output tokens together, per
//   Pacific/Auckland calendar day (./guard.ts). Unset or blank is the
//   default. Anything but digits naming a positive whole number logs a
//   warning naming the variable, never its value, and uses the default.
//
// The model, batch size and prices are constants here, not env vars: a
// change to any of them is a code change someone reviews.
import type { AgentConfig } from '../contracts.ts'

// Micro-USD (millionths of a US dollar) per million tokens. Not Divvy money.
export interface ModelPrice {
  input: number
  output: number
}

export interface LlmConfig
  extends Required<
    Pick<AgentConfig, 'batchSize' | 'dailyTokenBudget' | 'categoryModel' | 'killSwitch'>
  > {
  // Null when unset or blank; a call then refuses before the network.
  apiKey: string | null
  // Keyed by model id.
  prices: ReadonlyMap<string, ModelPrice>
}

type Env = Readonly<Record<string, string | undefined>>

const CATEGORY_MODEL = 'claude-haiku-5-5'

// Haiku 5.5 at $0.10 input and $0.50 output per million tokens, checked
// 2026-10-06. That rate holds for prompts up to 100K tokens; beyond it the
// rate is $0.50 and $2.50. A category batch stays far below the threshold,
// so only the lower rate is configured.
const PRICES: ReadonlyMap<string, ModelPrice> = new Map([
  [CATEGORY_MODEL, { input: 100_000, output: 500_000 }],
])

// Rows sent to the model in one call.
const BATCH_SIZE = 25

const DEFAULT_DAILY_TOKEN_BUDGET = 200_000

const INVALID_BUDGET_WARNING =
  'agents: AGENT_DAILY_TOKEN_BUDGET is not a positive whole number of tokens; using the default budget'

function dailyTokenBudget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAILY_TOKEN_BUDGET
  // Digits only: Number() would also accept '1e6', '0x10' and ' 5000 '.
  const tokens = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(tokens) || tokens < 1) {
    console.warn(INVALID_BUDGET_WARNING)
    return DEFAULT_DAILY_TOKEN_BUDGET
  }
  return tokens
}

/** The model path's configuration, read from `env` now. */
export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const key = env.ANTHROPIC_API_KEY?.trim() ?? ''
  return {
    apiKey: key === '' ? null : key,
    killSwitch: (env.AGENT_KILL_SWITCH?.trim() ?? '') !== '',
    dailyTokenBudget: dailyTokenBudget(env.AGENT_DAILY_TOKEN_BUDGET),
    categoryModel: CATEGORY_MODEL,
    batchSize: BATCH_SIZE,
    prices: PRICES,
  }
}

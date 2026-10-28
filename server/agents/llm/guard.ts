// The model path's brakes (prd-04 Rulings 4 and 9; #429): the kill switch,
// the daily token budget, and what a call cost.
//
// The day is the Pacific/Auckland calendar day (shared/nz-dates.ts), not
// UTC and not a rolling 24 hours, so the budget resets at Hannah's midnight.
// A run's usage reaches `agent_runs` only when it finishes, so the client
// adds the running run's own tokens to what is read here.
//
// Nothing is cached: `tokensSpentToday` reads the log on every call, so a
// run that finished between two calls of another run is counted by the
// second.
import connection from '../../db/connection.ts'
import { nzCalendarDate } from '../../../shared/nz-dates.ts'
import type { AgentRun } from '../contracts.ts'
import type { LlmConfig, ModelPrice } from './config.ts'

export type BlockReason = 'kill_switch' | 'budget'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

const tokens = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`)
  }
  return value
}

/**
 * What `usage` cost at `price`, in micro-USD (millionths of a US dollar),
 * rounded up to a whole one. Integer arithmetic throughout; not Divvy money.
 */
export function costMicroUsd(usage: TokenUsage, price: ModelPrice): number {
  const scaled =
    tokens(usage.inputTokens, 'inputTokens') * tokens(price.input, 'price.input') +
    tokens(usage.outputTokens, 'outputTokens') * tokens(price.output, 'price.output')
  if (!Number.isSafeInteger(scaled)) throw new RangeError('cost is out of range')
  // `scaled - rest` is a whole multiple of a million, so the division is exact.
  const rest = scaled % 1_000_000
  return (scaled - rest) / 1_000_000 + (rest > 0 ? 1 : 0)
}

// Wider than any calendar day, a daylight-saving one included.
const LOOKBACK_MS = 48 * 60 * 60 * 1000

/**
 * Input and output tokens logged by runs that finished on `now`'s
 * Pacific/Auckland calendar day. Read from `agent_runs` on every call.
 */
export async function tokensSpentToday(now: Date, db = connection): Promise<number> {
  // A plain select here, because the accessor belongs in
  // server/agents/db/agent-runs.ts, which is another lane's fence (#429).
  const rows: Pick<AgentRun, 'finished_at' | 'input_tokens' | 'output_tokens'>[] = await db(
    'agent_runs',
  )
    .select('finished_at', 'input_tokens', 'output_tokens')
    .whereNotNull('finished_at')
    .whereNotNull('input_tokens')
    .whereNotNull('output_tokens')
    .where('finished_at', '>=', new Date(now.getTime() - LOOKBACK_MS).toISOString())
  const today = nzCalendarDate(now)
  let spent = 0
  for (const row of rows) {
    if (row.finished_at === null || nzCalendarDate(new Date(row.finished_at)) !== today) continue
    spent += (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
  }
  return spent
}

/**
 * Why the next call must not be made, or null when it may. The kill switch
 * comes first; the budget stops a call once today's tokens, this run's
 * included, have reached it.
 */
export function checkBrakes(
  config: Pick<LlmConfig, 'killSwitch' | 'dailyTokenBudget'>,
  spentToday: number,
  spentThisRun: number,
): BlockReason | null {
  if (config.killSwitch) return 'kill_switch'
  // Written as "not below" so a NaN anywhere blocks rather than allows.
  if (!(spentToday + spentThisRun < config.dailyTokenBudget)) return 'budget'
  return null
}

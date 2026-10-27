// The one Claude API client (prd-04 Rulings 1, 4 and 9; #429). Every model
// call an agent makes goes through `ModelRun.complete`, and this is the only
// module that imports the Anthropic SDK. Only the category agent calls a
// model; insights stay on Ruling 7, so a model run of any other kind is
// refused before it is logged.
//
// Usage is kept per agent run, because `finishRun` writes it once, on the
// run's own `agent_runs` row: the model, input and output tokens summed over
// the run's calls, and their cost (each call's rounded up) from the prices
// in ./config.ts.
//
// Before every call, in order:
// - the configuration is read again (./config.ts), so the kill switch
//   stops the next call of a run already under way;
// - the kill switch blocks;
// - today's logged tokens are read again (./guard.ts) and this run's own
//   are added; at or over the daily budget blocks, so a batch stops partway;
// - no API key refuses with a thrown error.
// A blocked call returns `blocked` and is never sent. Once a run is blocked,
// every later call is blocked without being sent, and the run ends
// `blocked` unless its caller says `failed`.
//
// Every attempted call leaves a record: a run that called `complete` at all,
// sent or not, logs its model and usage (zero tokens if nothing was sent),
// so a blocked or failed run is never silent. A run that never called
// `complete` keeps its usage columns null.
//
// Calls are one at a time: the brakes are checked against the tokens of the
// calls that have returned.
//
// Logs and thrown errors carry fixed text, a reason, an error's class and an
// HTTP status. Never the key, a prompt, a response or an error's message,
// which for an API error can repeat request headers.
import Anthropic from '@anthropic-ai/sdk'

import connection from '../../db/connection.ts'
import { errorClass } from '../../error-class.ts'
import type { AgentRunOutcome } from '../contracts.ts'
import { finishRun, startRun, type StartRun } from '../db/agent-runs.ts'
import { loadLlmConfig } from './config.ts'
import { checkBrakes, costMicroUsd, tokensSpentToday, type BlockReason } from './guard.ts'

/** Sends one request. The default is the SDK's; tests record the body instead. */
export type Transport = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>

// What a caller sends: everything but the model, which comes from config.
export type CompleteParams = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>

export type CompleteResult =
  | { status: 'ok'; message: Anthropic.Message }
  | { status: 'blocked'; reason: BlockReason }

export interface FinishModelRun {
  outcome: Extract<AgentRunOutcome, 'success' | 'failed'>
  consideredCount: number
  writtenCount: number
  // Left as it was when absent.
  cursor?: string | null
}

export interface ModelRun {
  id: number
  complete(params: CompleteParams): Promise<CompleteResult>
  // True when this call finished the run (`finishRun`).
  finish(finish: FinishModelRun): Promise<boolean>
}

export interface ModelRunDeps {
  // Default: the Anthropic SDK, built on the first call that is sent.
  transport?: Transport
  // Default: `process.env`, read on every call.
  env?: Readonly<Record<string, string | undefined>>
  clock?: () => Date
  db?: typeof connection
}

// The SDK is given the key explicitly; left to itself it would read the
// environment.
function sdkTransport(apiKey: string): Transport {
  let sdk: Anthropic | undefined
  return (params) => {
    sdk ??= new Anthropic({ apiKey })
    return sdk.messages.create(params)
  }
}

// A thrown call as a new error: its class and HTTP status only.
function sanitized(err: unknown): Error {
  const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : null
  return new Error(`model call failed: ${errorClass(err)}${status === null ? '' : ` (status ${status})`}`)
}

/** Logs the start of an agent run that may call the model, and returns it. */
export async function startModelRun(start: StartRun, deps: ModelRunDeps = {}): Promise<ModelRun> {
  if (start.kind !== 'category') {
    throw new Error('only the category agent calls a model (prd-04 Ruling 9)')
  }
  const clock = deps.clock ?? (() => new Date())
  const db = deps.db ?? connection
  const run = await startRun(start, clock(), db)

  // Set by the first attempted call; null means `complete` was never called.
  let model: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  let blocked: BlockReason | null = null
  let finished = false
  let transport = deps.transport

  const block = (reason: BlockReason): CompleteResult => {
    if (blocked === null) console.info('agents: model calls blocked', reason)
    blocked = reason
    return { status: 'blocked', reason }
  }

  return {
    id: run.id,

    async complete(params) {
      if (finished) throw new Error('model run already finished')
      // A blocked run already logged its model on the call that blocked.
      if (blocked !== null) return block(blocked)
      const config = loadLlmConfig(deps.env)
      model = config.categoryModel
      if (config.killSwitch) return block('kill_switch')
      const spentToday = await tokensSpentToday(clock(), db)
      const reason = checkBrakes(config, spentToday, inputTokens + outputTokens)
      if (reason !== null) return block(reason)

      const price = config.prices.get(config.categoryModel)
      if (price === undefined) {
        console.error('agents: model call refused, no price configured')
        throw new Error('model call refused: no price configured for the model')
      }
      if (config.apiKey === null) {
        console.error('agents: model call refused, no API key')
        throw new Error('model call refused: no API key configured')
      }
      transport ??= sdkTransport(config.apiKey)

      let message: Anthropic.Message
      try {
        // The model is last, so a caller's cannot override config's.
        message = await transport({ ...params, model: config.categoryModel })
      } catch (err) {
        console.error('agents: model call failed', errorClass(err))
        throw sanitized(err)
      }
      const usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      }
      cost += costMicroUsd(usage, price)
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      return { status: 'ok', message }
    },

    async finish(finish) {
      finished = true
      const outcome: Exclude<AgentRunOutcome, 'running'> =
        finish.outcome === 'failed' ? 'failed' : blocked !== null ? 'blocked' : finish.outcome
      return finishRun(
        run.id,
        {
          outcome,
          consideredCount: finish.consideredCount,
          writtenCount: finish.writtenCount,
          ...(finish.cursor === undefined ? {} : { cursor: finish.cursor }),
          ...(model === null
            ? {}
            : { usage: { model, inputTokens, outputTokens, costMicroUsd: cost } }),
        },
        clock(),
        db,
      )
    },
  }
}

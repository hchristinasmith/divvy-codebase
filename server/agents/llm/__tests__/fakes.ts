import type Anthropic from '@anthropic-ai/sdk'

import connection from '../../../db/connection.ts'
import type { AgentRun } from '../../contracts.ts'
import type { Transport } from '../client.ts'

// Test doubles for the model client (#429). Every value is invented.

/** A reply carrying `usage`, shaped like the SDK's. */
export function reply(inputTokens: number, outputTokens: number): Anthropic.Message {
  return {
    id: 'msg_invented',
    container: null,
    content: [{ type: 'text', text: '[]', citations: null }],
    diagnostics: null,
    model: 'invented-model',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  }
}

export interface Recording {
  transport: Transport
  // Every request body sent, as sent.
  bodies: Anthropic.MessageCreateParamsNonStreaming[]
}

/** A transport that records each body and answers with the next usage. */
export function recording(usages: readonly [number, number][]): Recording {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = []
  const transport: Transport = async (params) => {
    bodies.push(structuredClone(params))
    const usage = usages[Math.min(bodies.length - 1, usages.length - 1)]
    return reply(usage[0], usage[1])
  }
  return { transport, bodies }
}

/** A transport that fails the test if it is ever called. */
export function untouchable(): { transport: Transport; calls: () => number } {
  let calls = 0
  return {
    transport: async () => {
      calls += 1
      throw new Error('the transport was touched')
    },
    calls: () => calls,
  }
}

/** A finished run's row with usage, as another run would have left it. */
export async function priorRun(
  finishedAt: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const row: Omit<AgentRun, 'id'> = {
    kind: 'category',
    trigger: 'manual',
    started_at: finishedAt,
    finished_at: finishedAt,
    outcome: 'success',
    considered_count: 1,
    written_count: 0,
    sync_run_id: null,
    cursor: null,
    model: 'invented-model',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_micro_usd: 1,
  }
  const [id] = await connection('agent_runs').insert(row)
  return id
}

export const params = {
  max_tokens: 512,
  system: 'Propose a category for each row.',
  messages: [{ role: 'user' as const, content: 'invented row' }],
}

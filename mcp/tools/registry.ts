// The advisor's fixed tool list and the one path a call takes through it
// (prd-03 Ruling 1, Ruling 4).
//
// `TOOLS` is the whole surface. Adding, removing or renaming a tool is a PRD
// amendment, not a code change, and `__tests__/registry.test.ts` and
// `../__tests__/guard.test.ts` fail if this list drifts.
//
// Every call goes through `dispatchToolCall`: look the name up, validate the
// arguments with the tool's strict schema, run the handler, then await
// `audit.record(...)` for whatever happened (ok, rejected or error). Nothing
// is returned to the client until that record has settled, and if it fails
// the client gets an error carrying no data.
//
// This uses the SDK's low-level `Server` (marked deprecated in favour of
// `McpServer` in @modelcontextprotocol/sdk 1.32) on purpose: `McpServer`
// validates arguments and answers unknown tool names inside the SDK, before
// any of our code runs, so those calls could never be audited.
//
// Known gap: the SDK rejects a `tools/call` whose envelope is malformed (no
// `name`, or `arguments` that is not an object) before this dispatcher is
// reached. Such a call executes nothing and returns no data, but leaves no
// audit row.

import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { UNKNOWN_TOOL } from '../contracts.ts'
import type {
  AuditOutcome,
  ToolContext,
  ToolDefinition,
  ToolFailure,
  ToolResult,
} from '../contracts.ts'
import { getBills } from './get-bills.ts'
import { getBudgets } from './get-budgets.ts'
import { getGoals } from './get-goals.ts'
import { getHabits } from './get-habits.ts'
import { getSafeToSpend } from './get-safe-to-spend.ts'
import { getSyncStatus } from './get-sync-status.ts'
import { listTransactions } from './list-transactions.ts'

export const SERVER_INFO = { name: 'divvy-mcp', version: '0.1.0' } as const

/** The advisor's whole tool surface, in the order `tools/list` returns it. */
export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  getSafeToSpend,
  listTransactions,
  getBudgets,
  getBills,
  getGoals,
  getHabits,
  getSyncStatus,
])

export const TOOL_NAMES: readonly string[] = Object.freeze(TOOLS.map((tool) => tool.name))

/** How much of an unknown tool name is kept in its audit row. */
export const MAX_UNKNOWN_NAME_LENGTH = 64

/** The `tools/list` entries for a tool list: JSON Schema of each input. */
export function describeTools(tools: readonly ToolDefinition[] = TOOLS): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Tool['inputSchema'],
    annotations: { ...tool.annotations },
  }))
}

function failure(error: ToolFailure & { issues?: readonly { path: string; message: string }[] }): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] }
}

const AUDIT_UNAVAILABLE: ToolFailure = {
  code: 'audit_unavailable',
  message: 'the call could not be recorded, so no data is returned',
}
const INTERNAL_ERROR: ToolFailure = { code: 'internal_error', message: 'the tool failed' }

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/**
 * Whether a handler's result keeps the result contract: a `data_as_of` that
 * is an ISO 8601 UTC timestamp, and every `*_cents` field, at any depth, a
 * safe integer.
 */
export function keepsResultContract(result: ToolResult): boolean {
  if (typeof result.data_as_of !== 'string' || !ISO_UTC.test(result.data_as_of)) return false
  if (Number.isNaN(Date.parse(result.data_as_of))) return false
  return centsAreIntegers(result)
}

function centsAreIntegers(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(centsAreIntegers)
  if (value === null || typeof value !== 'object') return true
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith('_cents') && !Number.isSafeInteger(inner)) return false
    if (!centsAreIntegers(inner)) return false
  }
  return true
}

function isRowCount(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
}

/**
 * Runs one `tools/call`: look up, validate, handle, record, respond. Every
 * outcome is recorded before anything is returned. `tools` is injectable so
 * tests and later lanes can drive the real dispatcher with fake tools.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext,
  tools: readonly ToolDefinition[] = TOOLS,
): Promise<CallToolResult> {
  const startedAt = ctx.clock.now()
  const elapsed = () => Math.max(0, ctx.clock.now().getTime() - startedAt.getTime())
  const raw = args ?? {}

  let tool = UNKNOWN_TOOL
  let params: unknown = raw
  let rowCount: number | null = null
  let outcome: AuditOutcome
  let response: CallToolResult

  const found = tools.find((candidate) => candidate.name === name)
  if (!found) {
    outcome = 'rejected'
    params = { requested_tool: String(name).slice(0, MAX_UNKNOWN_NAME_LENGTH) }
    response = failure({ code: 'unknown_tool', message: 'no tool has that name' })
  } else {
    tool = found.name
    const parsed = found.inputSchema.safeParse(raw)
    if (!parsed.success) {
      outcome = 'rejected'
      response = failure({
        code: 'invalid_arguments',
        message: 'the arguments do not match the tool input schema',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      })
    } else {
      params = parsed.data
      try {
        const handled = await found.handler(parsed.data, { replica: ctx.replica, clock: ctx.clock })
        if (!handled.ok) {
          outcome = 'error'
          response = failure({ code: handled.error.code, message: handled.error.message })
        } else if (!keepsResultContract(handled.result) || !isRowCount(handled.rowCount)) {
          outcome = 'error'
          response = failure(INTERNAL_ERROR)
        } else {
          outcome = 'ok'
          rowCount = handled.rowCount
          const result = handled.result as ToolResult & Record<string, unknown>
          response = {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          }
        }
      } catch {
        // The exception text may hold paths or SQL; it is neither returned
        // nor recorded.
        outcome = 'error'
        response = failure(INTERNAL_ERROR)
      }
    }
  }

  try {
    await ctx.audit.record({
      at: startedAt.toISOString(),
      tool,
      params,
      rowCount,
      outcome,
      durationMs: elapsed(),
    })
  } catch {
    // stdout is the MCP protocol stream; diagnostics go to stderr.
    console.error('[divvy-mcp] audit record failed; no data returned')
    return failure(AUDIT_UNAVAILABLE)
  }
  return response
}

/** The MCP server for a context: lists the fixed tools and dispatches calls. */
export function createToolServer(ctx: ToolContext, tools: readonly ToolDefinition[] = TOOLS): Server {
  const names = new Set(tools.map((tool) => tool.name))
  if (names.size !== tools.length) throw new Error('tool names must be unique')

  const listed = describeTools(tools)
  const server = new Server({ ...SERVER_INFO }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }))
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchToolCall(request.params.name, request.params.arguments, ctx, tools),
  )
  return server
}

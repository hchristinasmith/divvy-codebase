// Schema pieces shared by the advisor's tools (prd-03 Ruling 1).
//
// Every input schema is a strict zod object: an unknown key is rejected,
// never stripped. Bounds reject, never clamp. No schema has a `.default()`
// or a coercion, so the JSON schema the registry publishes is exactly what
// a handler receives.

import { z } from 'zod'
import type { HandlerOutcome, ToolDefinition } from '../contracts.ts'

/**
 * The longest `from`..`to` span `list_transactions` accepts, counted in
 * days inclusive of both ends: 2024-01-01..2024-12-31 is 366 days and
 * passes; one day more is rejected. The PRD sets no number (Done when 7
 * only forbids an unbounded range); a leap year is the chosen bound.
 */
export const MAX_RANGE_DAYS = 366

/** The most rows `list_transactions` may return (prd-03 Ruling 1). */
export const MAX_LIMIT = 200

/** The longest category name a filter may carry. */
export const MAX_CATEGORY_LENGTH = 100

export const SCOPES = ['personal', 'strawb'] as const
export type Scope = (typeof SCOPES)[number]

export const scopeSchema = z.enum(SCOPES)

/** A calendar date, `YYYY-MM-DD`, validated as a real date. */
export const isoDateSchema = z.iso.date()

/** The input of a tool that takes nothing: `{}` and only `{}`. */
export const noInputSchema = z.strictObject({})

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The problems with a `from`..`to` range, as messages. Empty when the range
 * is valid: `from` on or before `to`, spanning at most `MAX_RANGE_DAYS`
 * days inclusive. Returns nothing for strings that are not both valid dates;
 * the date schema reports those.
 */
export function dateRangeIssues(from: unknown, to: unknown): string[] {
  const fromOk = isoDateSchema.safeParse(from).success
  const toOk = isoDateSchema.safeParse(to).success
  if (!fromOk || !toOk) return []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (start > end) return ['from must be on or before to']
  const days = (end - start) / DAY_MS + 1
  if (days > MAX_RANGE_DAYS) {
    return [`the range from..to may span at most ${MAX_RANGE_DAYS} days`]
  }
  return []
}

/** Identity helper so a tool file gets its handler's input type inferred. */
export function defineTool<S extends z.ZodObject>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition
}

/** The typed answer of a tool whose handler a later lane has yet to write. */
export function notImplemented(tool: string): HandlerOutcome {
  return { ok: false, error: { code: 'not_implemented', message: `${tool} is not implemented yet` } }
}

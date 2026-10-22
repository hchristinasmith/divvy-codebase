// The advisor's contract (prd-03 Ruling 1, Ruling 4, Ruling 6).
//
// Every later prd-03 lane builds against this file and none of them edits
// it: the replica lane implements `ReplicaReader` in `mcp/replica/index.ts`
// (`openReplica`), the audit lane implements `AuditSink` in
// `mcp/audit/index.ts` (`createAuditSink`), and the tool lanes fill the
// handlers in `mcp/tools/*.ts`. If a later lane has to edit this file to
// proceed, that is a finding against this contract, not a widening.
//
// This module holds types and constants only, plus the `staticSql` tag. It
// has no side effects and imports nothing at runtime.

import type { z } from 'zod'

// ---- Environment and paths (prd-03 Ruling 2, Ruling 4) ----

/** Env var naming the scrubbed read-only replica file. */
export const REPLICA_PATH_ENV = 'DIVVY_REPLICA_PATH'
/** Env var naming the advisor audit file, the only file the MCP writes. */
export const AUDIT_PATH_ENV = 'DIVVY_AUDIT_PATH'

export const DEFAULT_REPLICA_PATH = '/app/replica/divvy-ro.sqlite3'
export const DEFAULT_AUDIT_PATH = '/app/audit/advisor-audit.sqlite3'

/**
 * Where wave 2 implements the replica reader and the audit sink, and the
 * export each module must provide. `mcp/context.ts` imports these modules
 * once they exist; until then it uses a fail-closed placeholder.
 */
export const WAVE2_MODULES = {
  replica: { path: 'mcp/replica/index.ts', exportName: 'openReplica' },
  audit: { path: 'mcp/audit/index.ts', exportName: 'createAuditSink' },
} as const

// ---- Replica reader (prd-03 Ruling 2) ----

/** A value bound into a replica query. */
export type SqlValue = string | number | null

declare const staticSqlBrand: unique symbol
/**
 * SQL text written in source, never built from tool input. Only `staticSql`
 * produces one, and it refuses template substitutions, so a value from a
 * tool call can reach the replica only as a bound parameter.
 */
export type StaticSql = string & { readonly [staticSqlBrand]: true }

/**
 * Tags a literal SQL statement for the replica reader:
 * `` staticSql`SELECT … WHERE scope = ?` ``. Throws if the template has any
 * `${}` substitution; pass values through `ReadQuery.params` instead.
 */
export function staticSql(strings: TemplateStringsArray, ...values: never[]): StaticSql {
  // A template literal's strings array and its `raw` are frozen; this
  // refuses an ordinary array passed by hand. It does not stop a deliberate
  // frozen forgery, which only review (or a lint rule) can.
  const fromTemplate =
    Array.isArray(strings) && Object.isFrozen(strings) && Array.isArray(strings.raw) && Object.isFrozen(strings.raw)
  if (!fromTemplate) throw new TypeError('staticSql is a template tag; call it as staticSql`...`')
  if (strings.length !== 1 || values.length !== 0) {
    throw new TypeError('staticSql takes no substitutions; bind values through params')
  }
  return strings[0] as StaticSql
}

export interface ReadQuery {
  readonly sql: StaticSql
  readonly params?: readonly SqlValue[]
  /**
   * The most rows this query may return. The reader rejects (never
   * truncates) a result larger than this, so a row bound holds at the reader
   * as well as in the tool's input schema (prd-03 Done when 7).
   */
  readonly maxRows: number
}

/** Freshness of the replica, read from its `replica_meta` table. */
export interface ReplicaMeta {
  /** ISO 8601 UTC: the moment the data in the replica reflects. */
  readonly data_as_of: string
  /** ISO 8601 UTC: when the replica file was built. */
  readonly built_at: string
  /** ISO 8601 UTC of the last finished sync, or null if none. */
  readonly last_sync_at: string | null
}

/**
 * Read-only access to the scrubbed replica.
 *
 * Implementations open the replica with `mode=ro` and `immutable=1` inside
 * each call and close it before returning, so there is nothing to cache and
 * nothing to close. They must refuse anything other than a single `SELECT`
 * or `WITH … SELECT` statement (no `INSERT`, `UPDATE`, `DELETE`, `PRAGMA`,
 * `ATTACH` or DDL). There is deliberately no `exec`, `run`, `prepare`,
 * `pragma` or `attach` here.
 */
export interface ReplicaReader {
  meta(): Promise<ReplicaMeta>
  /** Rejects if the statement returns more than `query.maxRows` rows. */
  select<Row extends Record<string, SqlValue>>(query: ReadQuery): Promise<readonly Row[]>
}

export type OpenReplica = (options: { path: string }) => ReplicaReader | Promise<ReplicaReader>

/** The shape `mcp/replica/index.ts` must export. */
export interface ReplicaModule {
  openReplica: OpenReplica
}

// ---- Audit (prd-03 Ruling 4) ----

/**
 * How a call ended. `rejected`: the call never reached a handler (unknown
 * tool or invalid arguments). `error`: the handler failed, refused or broke
 * the result contract. Stored as the audit file's `outcome` column.
 */
export type AuditOutcome = 'ok' | 'rejected' | 'error'

/**
 * The `tool` value recorded for a call naming a tool that is not in the
 * registry. The requested name goes in `params`, so caller-chosen text never
 * becomes a tool name in the log.
 */
export const UNKNOWN_TOOL = '(unknown)'

/** One audit row. It never carries returned data or error text. */
export interface AuditRecord {
  /** ISO 8601 UTC of the call's start. */
  readonly at: string
  /** The tool name, or `UNKNOWN_TOOL` for a name not in the registry. */
  readonly tool: string
  /**
   * The validated input for `ok` and `error`; the raw arguments for
   * `rejected`. The sink serialises and bounds it.
   */
  readonly params: unknown
  /** Rows the handler read, or null when not applicable. */
  readonly rowCount: number | null
  readonly outcome: AuditOutcome
  readonly durationMs: number
}

export interface AuditSink {
  /**
   * Resolves only once the record is durably written; rejects on any
   * failure. The dispatcher returns nothing to the client until this has
   * settled, and returns no data if it rejects.
   */
  record(entry: AuditRecord): Promise<void>
}

export type CreateAuditSink = (options: { path: string }) => AuditSink | Promise<AuditSink>

/** The shape `mcp/audit/index.ts` must export. */
export interface AuditModule {
  createAuditSink: CreateAuditSink
}

// ---- Context ----

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

/** What the dispatcher holds for a call. */
export interface ToolContext {
  readonly replica: ReplicaReader
  readonly audit: AuditSink
  readonly clock: Clock
}

/** What a handler is given: the dispatcher, not the handler, writes audit rows. */
export type HandlerContext = Omit<ToolContext, 'audit'>

// ---- Results ----

/**
 * Money in a tool result is a safe integer number of cents (M1 #8). Name a
 * money field with a `_cents` suffix: the dispatcher refuses a result whose
 * `*_cents` field is not a safe integer.
 */
export type Cents = number

/** Every successful tool result carries `data_as_of` (ISO 8601 UTC). */
export type ToolResult<T extends object = object> = T & { readonly data_as_of: string }

export type ToolErrorCode =
  | 'not_implemented'
  | 'invalid_arguments'
  | 'unknown_tool'
  | 'internal_error'
  | 'audit_unavailable'

export interface ToolFailure {
  readonly code: ToolErrorCode
  readonly message: string
}

/**
 * The codes a handler may refuse with. The dispatcher answers each with a
 * fixed message, so nothing a handler writes reaches the client except its
 * result; any other code is answered as `internal_error`.
 */
export type HandlerErrorCode = Extract<ToolErrorCode, 'not_implemented' | 'internal_error'>

/** What a handler returns. A handler may also throw; that is an `error`. */
export type HandlerOutcome =
  | { readonly ok: true; readonly result: ToolResult; readonly rowCount: number | null }
  | { readonly ok: false; readonly error: { readonly code: HandlerErrorCode } }

// ---- Tool definitions (prd-03 Ruling 1) ----

/** Every tool declares itself read-only to the client. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  readonly name: string
  readonly title: string
  readonly description: string
  /** A strict zod object: unknown keys are rejected, never stripped. */
  readonly inputSchema: S
  readonly annotations: typeof READ_ONLY_ANNOTATIONS
  // Method syntax on purpose: it lets a list of tools with different input
  // schemas be typed as `readonly ToolDefinition[]` without a cast.
  handler(input: z.output<S>, ctx: HandlerContext): Promise<HandlerOutcome>
}

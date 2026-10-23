// The advisor audit sink: one durable row per tool call (prd-03 Ruling 4).
//
// The audit file is the only thing the MCP process writes. It is a SQLite
// file of its own, created here and given its schema by `schema.sql`, never
// by a knex migration, because the main database is read-only to the MCP
// (Ruling 2). The web app opens it read-only for the Privacy screen.
//
// Each `record` opens the file, applies the schema, inserts one row, closes
// the file, and only then resolves. Nothing is held open between calls, so
// there is no connection to leak and no state that a failure can poison: an
// unwritable path, a missing directory, a file that is not a database or a
// database that is not an audit file rejects that record, and the dispatcher
// answers the call with no data. The next record tries again from scratch.
//
// The sink writes only to a file that is its own: one with no tables but
// `advisor_audit` (and the `sqlite_sequence` its AUTOINCREMENT brings) and
// an `application_id` that is unset or `AUDIT_APPLICATION_ID`. Any other
// database is refused before anything in it changes, so a mistyped path
// never converts someone else's file out of WAL or adds a table to it. Every
// write stamps the id, so an audit file says what it is.
//
// What a row holds is bounded here, whatever the caller passes:
//   - only the six `AuditRecord` fields are read, so a stray `result` or
//     `error` on the entry is never stored;
//   - a record whose fields are not what the contract says is refused
//     before the file is touched, naming the field but not its value;
//   - parameters are stored as JSON with every control and format character
//     written as a `\uXXXX` escape, so the Privacy screen never renders a
//     bidi override or an invisible character from a parameter;
//   - that escaped JSON is no longer than `MAX_AUDIT_PARAMS_LENGTH`;
//     anything longer, or anything that does not serialise, is replaced by
//     a small marker rather than cut, so `params_json` is always valid JSON.
//
// The file keeps a rollback journal (`journal_mode=DELETE`), not WAL, so a
// reader opening it read-only on a quiescent file needs no `-wal` or `-shm`
// file and no write access to the directory.
//
// This module never writes to stdout (the MCP protocol stream) and never
// logs; the dispatcher reports a failed record on stderr.

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import sqlite3 from 'sqlite3'
import type { AuditOutcome, AuditRecord, AuditSink, CreateAuditSink } from '../contracts.ts'

/**
 * The longest `params_json` stored as given. Longer parameters are stored
 * as `{"oversized_params_length":N}`. It matches the dispatcher's
 * `MAX_REJECTED_PARAMS_LENGTH`, and the sink's test fails if they drift; it
 * is not imported from there because the sink must not load the registry.
 */
export const MAX_AUDIT_PARAMS_LENGTH = 1024

/** The longest tool name a row may carry; the registry's names are far shorter. */
const MAX_TOOL_LENGTH = 64

/** How long a write waits for another connection's lock before failing. */
const BUSY_TIMEOUT_MS = 5000

/**
 * The `application_id` every audit file carries in its header: the ASCII
 * bytes `DVAU`, for Divvy audit, read as a big-endian 32-bit integer.
 */
const AUDIT_APPLICATION_ID = 0x44564155

/** The only `sqlite_master` names an audit file may hold. */
const AUDIT_FILE_NAMES: readonly string[] = ['advisor_audit', 'sqlite_sequence']

const OUTCOMES: readonly AuditOutcome[] = ['ok', 'rejected', 'error']

// Control (Cc) and format (Cf) characters have no place in a tool name, and
// are escaped wherever they appear in `params_json`.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u
const CONTROL_OR_FORMAT_ALL = /[\p{Cc}\p{Cf}]/gu

const INSERT_ROW =
  'INSERT INTO advisor_audit (at, tool, params_json, row_count, outcome, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'

/** A record checked against the contract and ready to bind. */
interface AuditRow {
  readonly at: string
  readonly tool: string
  readonly paramsJson: string
  readonly rowCount: number | null
  readonly outcome: AuditOutcome
  readonly durationMs: number
}

/** Thrown for a record that breaks the contract; the message names the field only. */
function invalid(field: string): TypeError {
  return new TypeError(`invalid audit record: ${field}`)
}

// The schema's `at` shape. `toISOString` alone also yields `+010000-…` and
// `-000001-…` for years outside 0000–9999, which the schema would refuse
// only after the file is touched.
const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isIsoUtcWithMillis(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_MILLIS.test(value)) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return date.toISOString() === value
}

/**
 * Every control and format character in `json` as a `\uXXXX` escape, one per
 * UTF-16 unit, so a format character outside the BMP becomes its surrogate
 * pair. `JSON.stringify` only puts such characters inside strings, and never
 * after an unescaped backslash, so the result is valid JSON that parses to
 * the same value.
 */
function escapeControlAndFormat(json: string): string {
  return json.replace(CONTROL_OR_FORMAT_ALL, (character) => {
    let escaped = ''
    for (let i = 0; i < character.length; i++) {
      escaped += `\\u${character.charCodeAt(i).toString(16).padStart(4, '0')}`
    }
    return escaped
  })
}

/**
 * The parameters as escaped JSON, bounded. Replaced, never truncated: cut
 * JSON is not JSON, and the schema refuses a `params_json` that is not. The
 * bound is on the escaped text, which is what the row stores.
 */
function boundedParamsJson(params: unknown): string {
  let json: string | undefined
  try {
    json = JSON.stringify(params)
  } catch {
    json = undefined
  }
  if (json === undefined) return JSON.stringify({ unserialisable_params: true })
  const escaped = escapeControlAndFormat(json)
  if (escaped.length > MAX_AUDIT_PARAMS_LENGTH) return JSON.stringify({ oversized_params_length: escaped.length })
  return escaped
}

/** Checks one record against the contract. Throws `invalid(field)`. */
function toRow(entry: unknown): AuditRow {
  if (entry === null || typeof entry !== 'object') throw invalid('entry')
  // Read the contract's fields by name and nothing else.
  const { at, tool, params, rowCount, outcome, durationMs } = entry as Partial<Record<keyof AuditRecord, unknown>>

  if (!isIsoUtcWithMillis(at)) throw invalid('at')
  if (
    typeof tool !== 'string' ||
    tool.length === 0 ||
    tool.length > MAX_TOOL_LENGTH ||
    CONTROL_OR_FORMAT.test(tool)
  ) {
    throw invalid('tool')
  }
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome as AuditOutcome)) throw invalid('outcome')
  if (rowCount !== null && !(Number.isSafeInteger(rowCount) && (rowCount as number) >= 0)) throw invalid('rowCount')
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > Number.MAX_SAFE_INTEGER
  ) {
    throw invalid('durationMs')
  }

  return {
    at,
    tool,
    paramsJson: boundedParamsJson(params),
    rowCount: rowCount as number | null,
    outcome: outcome as AuditOutcome,
    durationMs: Math.round(durationMs),
  }
}

// ---- sqlite3's callbacks, as promises ----

function openFile(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    // No OPEN_URI: the path is a file name, never a URI with parameters.
    const db = new sqlite3.Database(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (error) => {
      if (error) reject(error)
      else resolve(db)
    })
  })
}

function exec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()))
  })
}

function all(db: sqlite3.Database, sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all<Record<string, unknown>>(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
  })
}

function journalMode(db: sqlite3.Database): Promise<unknown> {
  return new Promise((resolve, reject) => {
    db.get<{ journal_mode?: unknown }>('PRAGMA journal_mode = DELETE', (error, row) => {
      if (error) reject(error)
      else resolve(row?.journal_mode)
    })
  })
}

function insert(db: sqlite3.Database, row: AuditRow): Promise<number> {
  const values = [row.at, row.tool, row.paramsJson, row.rowCount, row.outcome, row.durationMs]
  return new Promise((resolve, reject) => {
    db.run(INSERT_ROW, values, function (this: sqlite3.RunResult, error: Error | null) {
      if (error) reject(error)
      else resolve(this.changes)
    })
  })
}

function closeFile(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()))
  })
}

// ---- The sink ----

let schemaText: string | undefined

/** `schema.sql`, read on first use and kept once it has been read. */
function schema(): string {
  if (schemaText === undefined) schemaText = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
  return schemaText
}

/**
 * Rejects unless the open file is empty or an audit file: an `application_id`
 * of 0 or `AUDIT_APPLICATION_ID`, and no `sqlite_master` entry but the audit
 * file's own. Only reads. The message names no path and no table.
 */
async function assertAuditFile(db: sqlite3.Database): Promise<void> {
  const [header] = await all(db, 'PRAGMA application_id')
  const applicationId = header?.application_id
  const entries = await all(db, 'SELECT name FROM sqlite_master')
  const ownId = applicationId === 0 || applicationId === AUDIT_APPLICATION_ID
  const ownEntries = entries.every((entry) => typeof entry.name === 'string' && AUDIT_FILE_NAMES.includes(entry.name))
  if (!ownId || !ownEntries) throw new Error('the audit path holds a database that is not an audit file')
}

/** Writes one checked row: open, check, schema, insert, close. Rejects on any failure. */
async function writeRow(path: string, row: AuditRow): Promise<void> {
  const db = await openFile(path)
  try {
    db.configure('busyTimeout', BUSY_TIMEOUT_MS)
    // Before anything that writes, the journal pragma included: a file that
    // is not the sink's own is refused unmodified.
    await assertAuditFile(db)
    // A journal-mode change cannot happen inside a transaction, so it comes
    // before one. SQLite answers with the mode it is now in; anything but
    // `delete` means the switch did not take, and the record fails.
    const mode = await journalMode(db)
    if (mode !== 'delete') throw new Error('audit file did not switch to a rollback journal')
    await exec(db, 'PRAGMA synchronous = FULL')
    // IMMEDIATE takes the write lock up front, so two writers queue on the
    // busy timeout instead of one failing on a lock upgrade.
    await exec(db, 'BEGIN IMMEDIATE')
    await exec(db, schema())
    await exec(db, `PRAGMA application_id = ${AUDIT_APPLICATION_ID}`)
    const changes = await insert(db, row)
    if (changes !== 1) throw new Error('audit insert did not write exactly one row')
    await exec(db, 'COMMIT')
  } catch (error) {
    // Closing with a transaction open rolls it back. The first error is the
    // one worth reporting, so a failure to close here is dropped.
    await closeFile(db).catch(() => undefined)
    throw error
  }
  // The row is only durable once the file is closed cleanly.
  await closeFile(db)
}

// The absolute-path rule is what refuses `''`, `:memory:` and `file:` URIs:
// none of them is absolute.
function assertFilePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new TypeError('the audit path must be an absolute file path')
  }
}

/**
 * The audit sink for the file at `path`. Does no I/O: the file is created,
 * given its schema and written on each `record`. Throws only for a path that
 * is not absolute, which is also what refuses an empty path, `:memory:` and
 * a `file:` URI; every I/O failure is a rejected `record`, never a throw here.
 *
 * Records are written one at a time, in the order `record` was called. A
 * failed record does not stop the ones queued behind it.
 *
 * It returns the sink itself, not a promise, which the contract's
 * `CreateAuditSink` allows; `satisfies` checks it against that type.
 */
export const createAuditSink = (({ path }: { path: string }): AuditSink => {
  assertFilePath(path)
  let tail: Promise<void> = Promise.resolve()

  return {
    record(entry: AuditRecord): Promise<void> {
      let row: AuditRow
      try {
        row = toRow(entry)
      } catch (error) {
        return Promise.reject(error)
      }
      const run = tail.then(() => writeRow(path, row))
      tail = run.catch(() => undefined)
      return run
    },
  }
}) satisfies CreateAuditSink

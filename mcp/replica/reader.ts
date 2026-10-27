// The replica reader (prd-03 Ruling 2), implementing `ReplicaReader` from
// `../contracts.ts`.
//
// Every call opens the replica, runs one statement and closes it, so nothing
// is cached and an atomic rename by the refresh is picked up on the next call.
// The file is opened as a URI with exactly `mode=ro` and `immutable=1`
// (`__tests__/mode.test.ts` is the drift guard): read-only, and with no
// locking or change detection, which is safe because the refresh never
// rewrites the file in place, only renames a new one over it.
//
// A statement must be one `SELECT` or `WITH … SELECT`. The text check below
// refuses anything else before the file is opened; under it, `mode=ro` makes
// SQLite itself refuse a write, and the attached-database limit of zero makes
// it refuse `ATTACH`, which a read-only connection would otherwise allow. SQL
// reaches here only as `StaticSql` written in source; tool input arrives as
// bound parameters.
//
// No I/O at import time. This module never imports the refresh or the scrub.

import { pathToFileURL } from 'node:url'
import sqlite3 from 'sqlite3'
import { staticSql } from '../contracts.ts'
import type { ReadQuery, ReplicaMeta, ReplicaReader, SqlValue } from '../contracts.ts'

/** The query string every replica connection is opened with. */
export const REPLICA_URI_QUERY = 'mode=ro&immutable=1'

/** The open flags every replica connection uses: read-only, filename as URI. */
export const REPLICA_OPEN_FLAGS = sqlite3.OPEN_READONLY | sqlite3.OPEN_URI

/** The URI a replica connection opens: the path percent-encoded, then the flags. */
export function replicaUri(path: string): string {
  return `${pathToFileURL(path).href}?${REPLICA_URI_QUERY}`
}

/** Thrown for a statement the reader refuses to run. */
export class ReplicaQueryRefused extends Error {
  constructor(reason: string) {
    super(`replica reader refused the statement: ${reason}`)
    this.name = 'ReplicaQueryRefused'
  }
}

/** Thrown when a statement returns more rows than its `maxRows`. */
export class ReplicaRowLimitExceeded extends Error {
  constructor(maxRows: number) {
    super(`replica query returned more than ${maxRows} rows`)
    this.name = 'ReplicaRowLimitExceeded'
  }
}

// Words that only a write, a schema change or a reach outside the file use.
// `pragma\w*` covers the table-valued `pragma_*` functions too.
const REFUSED_WORDS = /\b(insert|update|delete|pragma\w*|attach|detach|create|drop|alter|vacuum|reindex|analyze|load_extension)\b|\breplace\s+into\b/i

/**
 * The statement with comments removed and every string literal emptied. A
 * quoted identifier keeps its text, unquoted, so the word check still sees
 * it: SQLite resolves `"pragma_database_list"` or `` `pragma_table_info` ``
 * to the same table-valued function as the bare name. A name that merely
 * contains a refused word as a whole word is refused too; that is the safe
 * direction.
 */
function withoutLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (match) => {
    if (match.startsWith('--') || match.startsWith('/*')) return ' '
    if (match.startsWith("'")) return "''"
    return ` ${match.slice(1, -1)} `
  })
}

/** Throws `ReplicaQueryRefused` unless `sql` is a single SELECT or WITH … SELECT. */
export function assertSingleSelect(sql: string): void {
  const body = withoutLiterals(sql).trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(body)) throw new ReplicaQueryRefused('not a SELECT')
  if (body.includes(';')) throw new ReplicaQueryRefused('more than one statement')
  const word = REFUSED_WORDS.exec(body)
  if (word) throw new ReplicaQueryRefused(`uses ${word[0].toUpperCase()}`)
}

function open(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(replicaUri(path), REPLICA_OPEN_FLAGS, (error) => {
      if (error) return reject(error)
      db.configure('limit', sqlite3.LIMIT_ATTACHED, 0)
      resolve(db)
    })
  })
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())))
}

function isSqlValue(value: unknown): value is SqlValue {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

/**
 * Runs `query` on a fresh read-only connection, reading at most
 * `maxRows + 1` rows, and rejects if the extra row exists.
 */
async function select<Row extends Record<string, SqlValue>>(path: string, query: ReadQuery): Promise<Row[]> {
  if (!Number.isSafeInteger(query.maxRows) || query.maxRows < 1) {
    throw new ReplicaQueryRefused('maxRows must be a positive integer')
  }
  assertSingleSelect(query.sql)
  const db = await open(path)
  try {
    const statement = await new Promise<sqlite3.Statement>((resolve, reject) => {
      const prepared: sqlite3.Statement = db.prepare(query.sql, [...(query.params ?? [])], (error: Error | null) =>
        error ? reject(error) : resolve(prepared),
      )
    })
    try {
      const rows: Row[] = []
      for (;;) {
        const row = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          statement.get((error: Error | null, next: Record<string, unknown> | undefined) => (error ? reject(error) : resolve(next)))
        })
        if (row === undefined) break
        if (rows.length === query.maxRows) throw new ReplicaRowLimitExceeded(query.maxRows)
        if (!Object.values(row).every(isSqlValue)) throw new Error('replica query returned a value that is not text, a number or null')
        rows.push(row as Row)
      }
      return rows
    } finally {
      await new Promise<void>((resolve) => statement.finalize(() => resolve()))
    }
  } finally {
    await close(db)
  }
}

/** A `ReplicaReader` over the replica file at `path`. Opens nothing until called. */
export function createReplicaReader(path: string): ReplicaReader {
  return {
    async meta(): Promise<ReplicaMeta> {
      const rows = await select<{ built_at: SqlValue; last_sync_at: SqlValue; data_as_of: SqlValue }>(path, {
        sql: staticSql`SELECT built_at, last_sync_at, data_as_of FROM replica_meta`,
        maxRows: 1,
      })
      const row = rows[0]
      if (
        row === undefined ||
        typeof row.built_at !== 'string' ||
        typeof row.data_as_of !== 'string' ||
        (row.last_sync_at !== null && typeof row.last_sync_at !== 'string')
      ) {
        throw new Error('replica_meta is missing or malformed')
      }
      return { data_as_of: row.data_as_of, built_at: row.built_at, last_sync_at: row.last_sync_at }
    },
    select<Row extends Record<string, SqlValue>>(query: ReadQuery): Promise<readonly Row[]> {
      return select<Row>(path, query)
    },
  }
}

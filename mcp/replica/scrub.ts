// Builds the scrubbed replica from a backup copy of the live database
// (prd-03 Ruling 2).
//
// Default-deny: the scrub never drops anything. It creates a new, empty file
// and copies into it only the tables and columns `ALLOWLIST` names, so a
// table or column added to the live schema later is absent until someone
// edits the allowlist. Dropping columns from a copy instead would leave the
// dropped values in the file's free pages, and would let a new column through
// by default.
//
// The source is the backup copy, attached read-only; the live file is never
// opened here. An allowlisted table or column the copy does not have fails
// the build, so a schema change that breaks the replica fails a refresh
// (which keeps the previous replica) instead of shipping a half-empty one.
//
// Account numbers arrive masked: `formatted_account` becomes `account_last4`,
// the last four characters once separators are removed, computed inside the
// INSERT so the full number is never written to the replica file.
//
// This module is part of the refresh process only. The MCP entry never
// imports it (`__tests__/refresh.test.ts` pins that).

import { pathToFileURL } from 'node:url'
import sqlite3 from 'sqlite3'
import type { Clock } from '../contracts.ts'
import { ALLOWLIST, REPLICA_META_TABLE, columnName } from './allowlist.ts'
import type { AllowedColumn } from './allowlist.ts'

type SqlParam = string | number | null

// ---- Promise wrappers over the sqlite3 callback API ----

export function openDatabase(filename: string, mode: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, mode, (error) => (error ? reject(error) : resolve(db)))
  })
}

export function run(db: sqlite3.Database, sql: string, params: readonly SqlParam[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error: Error | null) => (error ? reject(error) : resolve()))
  })
}

export function all<Row>(db: sqlite3.Database, sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error: Error | null, rows: Row[]) => (error ? reject(error) : resolve(rows)))
  })
}

export function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()))
  })
}

// ---- The build ----

/** A double-quoted SQL identifier. Every name here comes from source, never input. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function selectExpression(column: AllowedColumn): string {
  if (typeof column === 'string') return ident(column)
  // `substr(x, -4)` is at most four characters, whatever the format.
  return `substr(replace(replace(${ident(column.lastFourOf)}, '-', ''), ' ', ''), -4)`
}

interface TableInfoRow {
  name: string
  type: string
}

/** The column types of `src.<table>`, refusing a table or column the copy lacks. */
async function sourceColumns(db: sqlite3.Database, table: string, columns: readonly AllowedColumn[]): Promise<Map<string, string>> {
  const info = await all<TableInfoRow>(db, `PRAGMA src.table_info(${ident(table)})`)
  if (info.length === 0) throw new Error(`replica allowlist names table ${table}, which the live database does not have`)
  const types = new Map(info.map((row) => [row.name, row.type]))
  for (const column of columns) {
    const source = typeof column === 'string' ? column : column.lastFourOf
    if (!types.has(source)) {
      throw new Error(`replica allowlist names column ${table}.${source}, which the live database does not have`)
    }
  }
  return types
}

/** The `finished_at` of the newest finished sync run in the copy, or null. */
async function lastSyncAt(db: sqlite3.Database): Promise<string | null> {
  const rows = await all<{ finished_at: unknown }>(
    db,
    'SELECT finished_at FROM src.sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1',
  )
  if (rows.length === 0) return null
  const value = rows[0].finished_at
  if (typeof value === 'string') return value
  if (typeof value === 'number') return new Date(value).toISOString()
  throw new Error('sync_runs.finished_at is neither text nor a number')
}

export interface BuildReplicaOptions {
  /** The backup copy of the live database. Opened read-only. */
  readonly sourcePath: string
  /** Where to write the replica. Must not exist yet. */
  readonly targetPath: string
  /** ISO 8601 UTC: when the copy was taken. */
  readonly dataAsOf: string
  readonly clock: Clock
}

export interface BuiltReplicaMeta {
  readonly built_at: string
  readonly last_sync_at: string | null
  readonly data_as_of: string
}

/** Writes a new replica at `targetPath` holding only what `ALLOWLIST` names, plus `replica_meta`. */
export async function buildReplica(options: BuildReplicaOptions): Promise<BuiltReplicaMeta> {
  const db = await openDatabase(options.targetPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_URI)
  try {
    const existing = await all<{ name: string }>(db, 'SELECT name FROM sqlite_master')
    if (existing.length > 0) throw new Error('replica build target is not empty')
    await run(db, 'ATTACH DATABASE ? AS src', [`${pathToFileURL(options.sourcePath).href}?mode=ro`])
    await run(db, 'BEGIN')
    for (const [table, rule] of Object.entries(ALLOWLIST)) {
      const types = await sourceColumns(db, table, rule.columns)
      const definitions = rule.columns.map((column) =>
        typeof column === 'string' ? `${ident(column)} ${types.get(column) ?? ''}`.trim() : `${ident(column.name)} TEXT`,
      )
      await run(db, `CREATE TABLE main.${ident(table)} (${definitions.join(', ')})`)
      const names = rule.columns.map((column) => ident(columnName(column))).join(', ')
      const expressions = rule.columns.map(selectExpression).join(', ')
      let sql = `INSERT INTO main.${ident(table)} (${names}) SELECT ${expressions} FROM src.${ident(table)}`
      const params: string[] = []
      if (rule.onlyRowsWhere) {
        if (!types.has(rule.onlyRowsWhere.column)) {
          throw new Error(`replica allowlist filters on ${table}.${rule.onlyRowsWhere.column}, which the live database does not have`)
        }
        // An empty list copies no rows rather than producing `IN ()`.
        const placeholders = rule.onlyRowsWhere.in.map(() => '?').join(', ')
        sql += placeholders ? ` WHERE ${ident(rule.onlyRowsWhere.column)} IN (${placeholders})` : ' WHERE 0'
        params.push(...rule.onlyRowsWhere.in)
      }
      await run(db, sql, params)
    }
    const meta: BuiltReplicaMeta = {
      built_at: options.clock.now().toISOString(),
      last_sync_at: await lastSyncAt(db),
      data_as_of: options.dataAsOf,
    }
    await run(
      db,
      `CREATE TABLE main.${ident(REPLICA_META_TABLE)} (built_at TEXT NOT NULL, last_sync_at TEXT, data_as_of TEXT NOT NULL)`,
    )
    await run(db, `INSERT INTO main.${ident(REPLICA_META_TABLE)} (built_at, last_sync_at, data_as_of) VALUES (?, ?, ?)`, [
      meta.built_at,
      meta.last_sync_at,
      meta.data_as_of,
    ])
    await run(db, 'COMMIT')
    await run(db, 'DETACH DATABASE src')
    return meta
  } finally {
    await close(db)
  }
}

// The replica reader (prd-03 Ruling 2; Done when 2). This test fails if:
//   - a connection or its data outlives a call: a replica renamed in, or
//     removed, between two calls is not what the second call sees;
//   - `openReplica` opens anything before it is called;
//   - INSERT, UPDATE, DELETE, REPLACE, PRAGMA (statement or function),
//     ATTACH, DETACH, DDL, VACUUM or a second statement gets past the reader,
//     or a refused statement changes the file;
//   - an ordinary SELECT that merely mentions those words in a string,
//     a parameter or a column name is refused;
//   - a result larger than `maxRows` is truncated instead of rejected, or a
//     `maxRows` that is not a positive integer is accepted;
//   - `meta()` does not return exactly `built_at`, `last_sync_at` and
//     `data_as_of` from `replica_meta`.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { staticSql } from '../../contracts.ts'
import type { ReplicaModule } from '../../contracts.ts'
import * as replicaModule from '../index.ts'
import { ReplicaQueryRefused, ReplicaRowLimitExceeded } from '../reader.ts'
import { close, openDatabase, run } from '../scrub.ts'

const META = { built_at: '2026-10-28T01:00:05.000Z', last_sync_at: '2026-10-28T00:58:00.000Z', data_as_of: '2026-10-28T01:00:00.000Z' }

let dir: string
let path: string

/** A small replica: `replica_meta` plus a `t` with `rows` rows named `label`-n. */
async function writeReplica(file: string, rows: number, label: string): Promise<void> {
  const db = await openDatabase(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
  try {
    await run(db, 'CREATE TABLE replica_meta (built_at TEXT NOT NULL, last_sync_at TEXT, data_as_of TEXT NOT NULL)')
    await run(db, 'INSERT INTO replica_meta VALUES (?, ?, ?)', [META.built_at, META.last_sync_at, META.data_as_of])
    await run(db, 'CREATE TABLE t (id INTEGER, name TEXT, updated_at TEXT)')
    for (let i = 1; i <= rows; i += 1) await run(db, 'INSERT INTO t VALUES (?, ?, ?)', [i, `${label}-${i}`, META.built_at])
  } finally {
    await close(db)
  }
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'divvy-reader-'))
  path = join(dir, 'replica.sqlite3')
  await writeReplica(path, 5, 'a')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const { openReplica } = replicaModule satisfies ReplicaModule

describe('module shape', () => {
  it('exports openReplica and nothing else', () => {
    expect(Object.keys(replicaModule).sort()).toEqual(['openReplica'])
  })

  it('opens nothing until called', async () => {
    const reader = await openReplica({ path: join(dir, 'missing.sqlite3') })
    await expect(reader.meta()).rejects.toThrow(/SQLITE_CANTOPEN/)
  })
})

describe('meta()', () => {
  it('returns built_at, last_sync_at and data_as_of from replica_meta, and nothing else', async () => {
    const meta = await (await openReplica({ path })).meta()
    expect(Object.keys(meta).sort()).toEqual(['built_at', 'data_as_of', 'last_sync_at'])
    expect(meta).toEqual(META)
  })

  it('returns last_sync_at null when no sync has finished', async () => {
    const db = await openDatabase(path, sqlite3.OPEN_READWRITE)
    await run(db, 'UPDATE replica_meta SET last_sync_at = NULL')
    await close(db)
    expect((await (await openReplica({ path })).meta()).last_sync_at).toBeNull()
  })
})

describe('a fresh connection per call', () => {
  it('sees a replica renamed in between two calls on the same reader', async () => {
    const reader = await openReplica({ path })
    const query = { sql: staticSql`SELECT name FROM t ORDER BY id`, maxRows: 10 }
    expect((await reader.select(query))[0]).toEqual({ name: 'a-1' })
    const next = join(dir, 'next.sqlite3')
    await writeReplica(next, 2, 'b')
    renameSync(next, path)
    expect(await reader.select(query)).toEqual([{ name: 'b-1' }, { name: 'b-2' }])
  })

  it('holds nothing between calls: a removed replica fails the next call', async () => {
    const reader = await openReplica({ path })
    await reader.meta()
    rmSync(path)
    await expect(reader.meta()).rejects.toThrow(/SQLITE_CANTOPEN/)
  })
})

describe('only a single SELECT gets through', () => {
  const refused = [
    staticSql`INSERT INTO t VALUES (9, 'x', 'y')`,
    staticSql`insert or replace into t values (9, 'x', 'y')`,
    staticSql`REPLACE INTO t VALUES (9, 'x', 'y')`,
    staticSql`UPDATE t SET name = 'x'`,
    staticSql`DELETE FROM t`,
    staticSql`WITH x AS (SELECT 1) INSERT INTO t SELECT 9, 'x', 'y' FROM x`,
    staticSql`WITH x AS (SELECT 1) DELETE FROM t`,
    staticSql`WITH x AS (SELECT 1) REPLACE INTO t VALUES (9, 'x', 'y')`,
    staticSql`PRAGMA table_info(t)`,
    staticSql`SELECT * FROM pragma_table_info('t')`,
    staticSql`ATTACH DATABASE ':memory:' AS x`,
    staticSql`SELECT 1; ATTACH DATABASE ':memory:' AS x`,
    staticSql`DETACH DATABASE main`,
    staticSql`CREATE TABLE u (a)`,
    staticSql`CREATE TEMP TABLE u (a)`,
    staticSql`DROP TABLE t`,
    staticSql`ALTER TABLE t ADD COLUMN z`,
    staticSql`VACUUM`,
    staticSql`SELECT 1; DELETE FROM t`,
    staticSql`SELECT 1; SELECT 2`,
    staticSql`EXPLAIN SELECT 1`,
    staticSql`/* SELECT */ DELETE FROM t`,
    staticSql`-- SELECT
DELETE FROM t`,
    staticSql`SELECT load_extension('x')`,
    staticSql``,
  ]

  for (const sql of refused) {
    it(`refuses ${JSON.stringify(sql)} and leaves the file as it was`, async () => {
      const before = digest(path)
      const reader = await openReplica({ path })
      await expect(reader.select({ sql, maxRows: 10 })).rejects.toBeInstanceOf(ReplicaQueryRefused)
      expect(digest(path)).toBe(before)
      expect(await reader.select({ sql: staticSql`SELECT count(*) AS n FROM t`, maxRows: 1 })).toEqual([{ n: 5 }])
    })
  }

  it('allows SELECTs that only mention those words in strings, parameters or names', async () => {
    const reader = await openReplica({ path })
    const rows = await reader.select({
      sql: staticSql`
        -- a comment saying DELETE FROM t; is fine
        WITH named AS (SELECT id, name, updated_at FROM t WHERE name <> 'DROP TABLE t; --' AND name <> ?)
        SELECT id, replace(name, 'a', 'z') AS name, CASE WHEN id > 1 THEN 'update' ELSE 'insert' END AS word, updated_at
        FROM named ORDER BY id;`,
      params: ['DELETE FROM t'],
      maxRows: 5,
    })
    expect(rows).toHaveLength(5)
    expect(rows[0]).toEqual({ id: 1, name: 'z-1', word: 'insert', updated_at: META.built_at })
  })

  it('binds parameters as values, never as SQL', async () => {
    const reader = await openReplica({ path })
    const rows = await reader.select({
      sql: staticSql`SELECT count(*) AS n FROM t WHERE name = ?`,
      params: ["a-1' OR '1'='1"],
      maxRows: 1,
    })
    expect(rows).toEqual([{ n: 0 }])
  })
})

describe('maxRows rejects, never truncates', () => {
  it('returns every row when there are exactly maxRows', async () => {
    const reader = await openReplica({ path })
    expect(await reader.select({ sql: staticSql`SELECT id FROM t ORDER BY id`, maxRows: 5 })).toHaveLength(5)
  })

  it('rejects a result one row larger than maxRows', async () => {
    const reader = await openReplica({ path })
    await expect(reader.select({ sql: staticSql`SELECT id FROM t ORDER BY id`, maxRows: 4 })).rejects.toBeInstanceOf(
      ReplicaRowLimitExceeded,
    )
  })

  for (const maxRows of [0, -1, 1.5, Number.NaN]) {
    it(`refuses maxRows ${maxRows}`, async () => {
      const reader = await openReplica({ path })
      await expect(reader.select({ sql: staticSql`SELECT id FROM t`, maxRows })).rejects.toBeInstanceOf(ReplicaQueryRefused)
    })
  }
})

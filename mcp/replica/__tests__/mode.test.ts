// The "database mode" drift guard (prd-03 Ruling 2; Done when 2). This test
// fails if:
//   - the replica's URI flags stop being exactly `mode=ro&immutable=1`, or
//     its open flags stop being exactly read-only plus URI;
//   - the reader opens the replica any way other than through those two, or
//     stops capping attached databases at zero;
//   - a path with spaces or URI characters is not percent-encoded, so the
//     flags could be read as part of the filename;
//   - SQLite stops honouring either flag: `immutable=1` reads through
//     another connection's exclusive lock (no locking at all), and
//     `mode=ro` refuses a write even on a connection opened read-write.
//
// Run it; never edit it to make a flag change pass. A change here is a
// finding against Ruling 2.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { staticSql } from '../../contracts.ts'
import { openReplica } from '../index.ts'
import { REPLICA_OPEN_FLAGS, REPLICA_URI_QUERY, replicaUri } from '../reader.ts'
import { all, close, openDatabase, run } from '../scrub.ts'

const READER_SOURCE = readFileSync(new URL('../reader.ts', import.meta.url), 'utf8')

describe('the flags, as written', () => {
  it('opens with exactly mode=ro and immutable=1', () => {
    expect(REPLICA_URI_QUERY).toBe('mode=ro&immutable=1')
  })

  it('opens read-only, with the filename taken as a URI, and nothing else', () => {
    expect(REPLICA_OPEN_FLAGS).toBe(sqlite3.OPEN_READONLY | sqlite3.OPEN_URI)
  })

  it('percent-encodes the path before the flags', () => {
    expect(replicaUri('/app/replica/divvy-ro.sqlite3')).toBe('file:///app/replica/divvy-ro.sqlite3?mode=ro&immutable=1')
    expect(replicaUri('/tmp/a b/x?mode=rw#%.sqlite3')).toBe('file:///tmp/a%20b/x%3Fmode=rw%23%25.sqlite3?mode=ro&immutable=1')
  })

  it('the reader has one way to open a connection, and it uses both', () => {
    const opens = READER_SOURCE.match(/new sqlite3\.Database\(/g) ?? []
    expect(opens).toHaveLength(1)
    expect(READER_SOURCE).toContain('new sqlite3.Database(replicaUri(path), REPLICA_OPEN_FLAGS,')
    expect(READER_SOURCE).toContain("db.configure('limit', sqlite3.LIMIT_ATTACHED, 0)")
  })
})

describe('SQLite honours them', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'divvy mode ?#-'))
    path = join(dir, 'replica.sqlite3')
    const db = await openDatabase(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
    await run(db, 'CREATE TABLE t (x INTEGER)')
    await run(db, 'INSERT INTO t VALUES (1)')
    await close(db)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('immutable=1: the reader reads while another connection holds an exclusive lock', async () => {
    const writer = await openDatabase(path, sqlite3.OPEN_READWRITE)
    try {
      await run(writer, 'BEGIN EXCLUSIVE')
      await run(writer, 'INSERT INTO t VALUES (2)')
      // Control: an ordinary read-only connection is locked out.
      const plain = await openDatabase(path, sqlite3.OPEN_READONLY)
      await expect(all(plain, 'SELECT x FROM t')).rejects.toThrow(/SQLITE_BUSY/)
      await close(plain)
      const rows = await (await openReplica({ path })).select({ sql: staticSql`SELECT x FROM t`, maxRows: 10 })
      expect(rows).toEqual([{ x: 1 }])
    } finally {
      await run(writer, 'ROLLBACK')
      await close(writer)
    }
  })

  it('mode=ro: a write fails even on a connection opened read-write with the same URI', async () => {
    const db = await openDatabase(replicaUri(path), sqlite3.OPEN_READWRITE | sqlite3.OPEN_URI)
    try {
      await expect(run(db, 'INSERT INTO t VALUES (3)')).rejects.toThrow(/SQLITE_READONLY/)
    } finally {
      await close(db)
    }
  })

  it('the attached-database cap: ATTACH fails on a connection configured as the reader configures it', async () => {
    const db = await openDatabase(replicaUri(path), REPLICA_OPEN_FLAGS)
    try {
      db.configure('limit', sqlite3.LIMIT_ATTACHED, 0)
      await expect(run(db, "ATTACH DATABASE ':memory:' AS x")).rejects.toThrow(/too many attached databases/)
    } finally {
      await close(db)
    }
  })
})

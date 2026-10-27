// The replica refresh (prd-03 Ruling 2; Done when 2). This test fails if:
//   - a refresh changes the live file, or leaves its unscrubbed copy or a
//     temporary replica behind;
//   - a reader opening the replica in a loop during refreshes ever sees a
//     missing or half-built file;
//   - a failed refresh (a locked live database, a schema the allowlist no
//     longer matches) changes or removes the previous replica;
//   - watch mode does not refresh at start, every 300 s, and within 60 s of a
//     newer finished sync_runs row read from the live database, or stops
//     after a failed refresh or a failed poll;
//   - the command does not exit 0 after a refresh, 1 after a failed one, or
//     refuses no unknown argument;
//   - the refresh, the scrub or the live database path is reachable from the
//     MCP entry or the replica module, in source or in the bundle esbuild
//     makes of them.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import knex from 'knex'
import type { Knex } from 'knex'
import sqlite3 from 'sqlite3'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPLICA_PATH_ENV, staticSql, systemClock } from '../../contracts.ts'
import { openReplica } from '../index.ts'
import { REFRESH_INTERVAL_MS, SYNC_POLL_MS, readFinishedSyncMarker, refreshReplica, watchReplica } from '../refresh.ts'
import { close, openDatabase, run } from '../scrub.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MIGRATIONS = join(ROOT, 'server', 'db', 'migrations')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const CLI = 'mcp/replica/refresh-cli.ts'
const FIRST_SYNC = '2026-10-28T00:00:00.000Z'

function liveDb(filename: string): Knex {
  return knex({ client: 'sqlite3', connection: { filename }, useNullAsDefault: true, migrations: { directory: MIGRATIONS } })
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

let templateDir: string
let template: string
let dir: string
let livePath: string
let replicaPath: string

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), 'divvy-refresh-template-'))
  template = join(templateDir, 'live.sqlite3')
  const db = liveDb(template)
  try {
    await db.migrate.latest()
    await db('accounts').insert({ akahu_id: 'acc_1', name: 'Everyday', balance_cents: 100, created_at: FIRST_SYNC, updated_at: FIRST_SYNC })
    await db('transactions').insert({ akahu_id: 't1', account_id: 'acc_1', date: FIRST_SYNC, description: 'Tea', amount_cents: -400 })
    await db('sync_runs').insert({ started_at: FIRST_SYNC, finished_at: FIRST_SYNC, outcome: 'success' })
  } finally {
    await db.destroy()
  }
}, 30_000)
afterAll(() => rmSync(templateDir, { recursive: true, force: true }))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'divvy-refresh-'))
  livePath = join(dir, 'live.sqlite3')
  replicaPath = join(dir, 'replica', 'divvy-ro.sqlite3')
  copyFileSync(template, livePath)
  // The replica lives in its own directory, as /app/replica does.
  mkdirSync(dirname(replicaPath))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function finishSync(at: string): Promise<void> {
  const db = await openDatabase(livePath, sqlite3.OPEN_READWRITE)
  try {
    await run(db, "INSERT INTO sync_runs (started_at, finished_at, outcome) VALUES (?, ?, 'success')", [at, at])
  } finally {
    await close(db)
  }
}

describe('one refresh', () => {
  it('builds the replica from a copy and leaves the live file byte for byte as it was', async () => {
    const before = digest(livePath)
    const mtime = statSync(livePath).mtimeMs
    const meta = await refreshReplica({ livePath, replicaPath, clock: systemClock })
    expect(digest(livePath)).toBe(before)
    expect(statSync(livePath).mtimeMs).toBe(mtime)
    expect(meta.last_sync_at).toBe(FIRST_SYNC)
    expect(await (await openReplica({ path: replicaPath })).meta()).toEqual(meta)
  })

  it('leaves no copy or temporary file behind, beside the live file or the replica', async () => {
    await refreshReplica({ livePath, replicaPath })
    expect(readdirSync(dir).sort()).toEqual(['live.sqlite3', 'replica'])
    expect(readdirSync(dirname(replicaPath))).toEqual(['divvy-ro.sqlite3'])
  })

  it('leaves no copy, -wal or -shm beside a live file in WAL mode, as Litestream runs it', async () => {
    const writer = await openDatabase(livePath, sqlite3.OPEN_READWRITE)
    try {
      await run(writer, 'PRAGMA journal_mode = WAL')
      await run(writer, 'PRAGMA wal_autocheckpoint = 0')
      await run(writer, "UPDATE transactions SET description = 'from the wal'")
      await refreshReplica({ livePath, replicaPath })
      expect(readdirSync(dir).filter((name) => name.startsWith('.divvy-replica-copy-'))).toEqual([])
      expect(readdirSync(dirname(replicaPath))).toEqual(['divvy-ro.sqlite3'])
      const rows = await (await openReplica({ path: replicaPath })).select({ sql: staticSql`SELECT description FROM transactions`, maxRows: 1 })
      expect(rows).toEqual([{ description: 'from the wal' }])
    } finally {
      await close(writer)
    }
  })

  it('renames the replica into place readable by owner and group only (0640)', async () => {
    await refreshReplica({ livePath, replicaPath })
    expect(statSync(replicaPath).mode & 0o777).toBe(0o640)
  })

  it('sweeps scratch and temporary files a dead refresh left, and nothing else', async () => {
    const dead = 2_000_000_000
    expect(() => process.kill(dead, 0)).toThrow()
    const replicaDir = dirname(replicaPath)
    const stale = [
      join(dir, `.divvy-replica-copy-${dead}-1-1.sqlite3`),
      join(dir, `.divvy-replica-copy-${dead}-1-1.sqlite3-wal`),
      join(dir, `.divvy-replica-copy-${process.pid}-1-99.sqlite3-shm`),
      join(replicaDir, `.divvy-ro.sqlite3.${dead}-1-1.tmp`),
      join(replicaDir, `.divvy-ro.sqlite3.${dead}-1-1.tmp-journal`),
    ]
    const kept = [
      join(dir, 'divvy.sqlite3'),
      join(dir, 'divvy.sqlite3-wal'),
      join(dir, 'divvy.sqlite3-shm'),
      join(dir, '.divvy-replica-copy-notes'),
      join(replicaDir, 'divvy-ro.sqlite3.bak'),
    ]
    for (const file of [...stale, ...kept]) writeFileSync(file, 'x')
    await refreshReplica({ livePath, replicaPath })
    expect(stale.filter((file) => existsSync(file))).toEqual([])
    expect(kept.filter((file) => !existsSync(file))).toEqual([])
  })

  it('writes the unscrubbed copy to workDir when given, and removes it', async () => {
    const work = join(dir, 'work')
    mkdirSync(work)
    await refreshReplica({ livePath, replicaPath, workDir: work })
    expect(readdirSync(work)).toEqual([])
  })

  it('stamps data_as_of from before the copy and built_at from after it', async () => {
    const times = [new Date('2026-10-28T01:00:00.000Z'), new Date('2026-10-28T01:00:02.000Z')]
    const clock = { now: () => times.shift() ?? new Date('2099-01-01T00:00:00.000Z') }
    const meta = await refreshReplica({ livePath, replicaPath, clock })
    expect(meta).toEqual({ data_as_of: '2026-10-28T01:00:00.000Z', built_at: '2026-10-28T01:00:02.000Z', last_sync_at: FIRST_SYNC })
  })
})

describe('the replica only changes by atomic rename', () => {
  it('a reader opening in a loop during refreshes never sees a missing or half-built file', async () => {
    await refreshReplica({ livePath, replicaPath })
    const reader = await openReplica({ path: replicaPath })
    let refreshing = true
    let reads = 0
    const failures: string[] = []
    const looping = (async () => {
      while (refreshing) {
        try {
          await reader.meta()
          const rows = await reader.select({ sql: staticSql`SELECT description FROM transactions`, maxRows: 10 })
          if (rows.length !== 1) failures.push(`saw ${rows.length} transactions`)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
        reads += 1
      }
    })()
    for (let i = 0; i < 10; i += 1) await refreshReplica({ livePath, replicaPath })
    refreshing = false
    await looping
    expect(failures).toEqual([])
    expect(reads).toBeGreaterThan(10)
  })
})

describe('a failed refresh leaves the previous replica intact', () => {
  it('when the live database is locked', async () => {
    await refreshReplica({ livePath, replicaPath })
    const before = digest(replicaPath)
    const writer = await openDatabase(livePath, sqlite3.OPEN_READWRITE)
    try {
      await run(writer, 'BEGIN EXCLUSIVE')
      await run(writer, "UPDATE transactions SET description = 'mid-write'")
      await expect(refreshReplica({ livePath, replicaPath })).rejects.toThrow(/SQLITE_BUSY|SQLITE_LOCKED/)
    } finally {
      await run(writer, 'ROLLBACK')
      await close(writer)
    }
    expect(digest(replicaPath)).toBe(before)
    expect(readdirSync(dir).sort()).toEqual(['live.sqlite3', 'replica'])
    expect(readdirSync(dirname(replicaPath))).toEqual(['divvy-ro.sqlite3'])
  })

  it('when the live schema no longer has an allowlisted column', async () => {
    await refreshReplica({ livePath, replicaPath })
    const before = digest(replicaPath)
    const db = await openDatabase(livePath, sqlite3.OPEN_READWRITE)
    await run(db, 'ALTER TABLE transactions RENAME COLUMN merchant_name TO merchant')
    await close(db)
    await expect(refreshReplica({ livePath, replicaPath })).rejects.toThrow(/transactions\.merchant_name/)
    expect(digest(replicaPath)).toBe(before)
    expect(readdirSync(dirname(replicaPath))).toEqual(['divvy-ro.sqlite3'])
  })
})

describe('the newest finished sync, read from the live database', () => {
  it('is the id of the newest finished sync_runs row, ignoring one still running', async () => {
    expect(await readFinishedSyncMarker(livePath)).toBe(1)
    const db = await openDatabase(livePath, sqlite3.OPEN_READWRITE)
    await run(db, "INSERT INTO sync_runs (started_at, outcome) VALUES ('2026-10-28T00:05:00.000Z', 'running')")
    await close(db)
    expect(await readFinishedSyncMarker(livePath)).toBe(1)
    await finishSync('2026-10-28T00:06:00.000Z')
    expect(await readFinishedSyncMarker(livePath)).toBe(3)
  })
})

describe('watch mode', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A watcher with a fake refresh and a settable sync marker, on fake timers. */
  function fakeWatch() {
    vi.useFakeTimers()
    let marker: number | null = 1
    const refresh = vi.fn(async () => undefined)
    const readSyncMarker = vi.fn(async () => marker)
    const onError = vi.fn()
    const watcher = watchReplica({ livePath, replicaPath, refresh, readSyncMarker, onError })
    return {
      refresh,
      readSyncMarker,
      onError,
      watcher,
      setMarker: (next: number | null) => {
        marker = next
      },
    }
  }

  it('waits five minutes and half a minute by default', () => {
    expect(REFRESH_INTERVAL_MS).toBe(300_000)
    expect(SYNC_POLL_MS).toBeLessThanOrEqual(60_000)
  })

  it('refreshes at start, then every 300 s and not before', async () => {
    const { refresh, watcher } = fakeWatch()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1 + SYNC_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    await watcher.stop()
  })

  it('refreshes within 60 s of a newer finished sync', async () => {
    const { refresh, setMarker, watcher } = fakeWatch()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    setMarker(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    // And not again for the same sync.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await watcher.stop()
  })

  it('survives a failed refresh, reports it, and retries at the next poll', async () => {
    const { refresh, onError, watcher } = fakeWatch()
    const failure = new Error('disk full')
    refresh.mockRejectedValueOnce(failure)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(SYNC_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    await watcher.stop()
  })

  it('survives a failed poll of the live database', async () => {
    const { refresh, readSyncMarker, onError, watcher } = fakeWatch()
    await vi.advanceTimersByTimeAsync(0)
    const failure = new Error('SQLITE_BUSY')
    readSyncMarker.mockRejectedValueOnce(failure)
    await vi.advanceTimersByTimeAsync(SYNC_POLL_MS)
    expect(onError).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await watcher.stop()
  })

  it('stops: no refresh after stop()', async () => {
    const { refresh, watcher } = fakeWatch()
    await vi.advanceTimersByTimeAsync(0)
    await watcher.stop()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('end to end on real files: a sync finishing in the live database reaches the replica', async () => {
    const errors: unknown[] = []
    const watcher = watchReplica({ livePath, replicaPath, pollMs: 20, onError: (error) => errors.push(error) })
    const reader = await openReplica({ path: replicaPath })
    const lastSyncAt = async (): Promise<string | null | undefined> => {
      try {
        return (await reader.meta()).last_sync_at
      } catch {
        return undefined
      }
    }
    try {
      await vi.waitFor(async () => expect(await lastSyncAt()).toBe(FIRST_SYNC), { timeout: 5_000, interval: 20 })
      await finishSync('2026-10-28T00:10:00.000Z')
      await vi.waitFor(async () => expect(await lastSyncAt()).toBe('2026-10-28T00:10:00.000Z'), { timeout: 5_000, interval: 20 })
    } finally {
      await watcher.stop()
    }
    expect(errors).toEqual([])
  })
})

describe('the command', () => {
  function runCli(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  it('one-shot: refreshes from DATABASE_PATH into DIVVY_REPLICA_PATH and exits 0', async () => {
    const result = runCli([], { DATABASE_PATH: livePath, [REPLICA_PATH_ENV]: replicaPath })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect((await (await openReplica({ path: replicaPath })).meta()).last_sync_at).toBe(FIRST_SYNC)
  }, 30_000)

  it('one-shot: exits 1 when the refresh fails, and leaves the replica as it was', async () => {
    await refreshReplica({ livePath, replicaPath })
    const before = digest(replicaPath)
    const result = runCli([], { DATABASE_PATH: join(dir, 'missing.sqlite3'), [REPLICA_PATH_ENV]: replicaPath })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[divvy-replica] refresh failed')
    expect(digest(replicaPath)).toBe(before)
  }, 30_000)

  it('refuses an unknown argument with exit 2', () => {
    const result = runCli(['--once'], { DATABASE_PATH: livePath, [REPLICA_PATH_ENV]: replicaPath })
    expect(result.status).toBe(2)
    expect(existsSync(replicaPath)).toBe(false)
  }, 30_000)
})

describe('the MCP entry cannot reach the refresh or the live file', () => {
  const ENTRIES = ['mcp/index.ts', 'mcp/replica/index.ts']
  const REFRESH_SIDE = ['mcp/replica/refresh.ts', 'mcp/replica/refresh-cli.ts', 'mcp/replica/scrub.ts']
  // The live path default and its env var, and the backup call.
  const LIVE_MARKERS = ['/data/divvy.sqlite3', 'DATABASE_PATH', '.backup(']

  function reachableFrom(entry: string): string[] {
    const seen = new Set<string>()
    const queue = [resolve(ROOT, entry)]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        if (fileName.startsWith('.')) queue.push(resolve(dirname(file), fileName))
      }
    }
    return [...seen].map((file) => relative(ROOT, file))
  }

  it('no refresh-side module is in the import graph of either entry', () => {
    const reached = ENTRIES.flatMap(reachableFrom)
    expect(reached).toContain('mcp/replica/reader.ts')
    expect(reached.filter((file) => REFRESH_SIDE.includes(file))).toEqual([])
  })

  it('no source file in either graph names the live path or calls backup', () => {
    const found = ENTRIES.flatMap(reachableFrom).flatMap((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      return LIVE_MARKERS.filter((marker) => source.includes(marker)).map((marker) => `${file}: ${marker}`)
    })
    expect(found).toEqual([])
  })

  it('the bundles esbuild makes of either entry hold no live path and no backup call', async () => {
    const result = await build({
      entryPoints: ENTRIES.map((entry) => join(ROOT, entry)),
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      loader: { '.sql': 'text' },
      outdir: join(dir, 'bundle'),
      logLevel: 'silent',
    })
    expect(result.outputFiles).toHaveLength(ENTRIES.length)
    for (const output of result.outputFiles) {
      expect(LIVE_MARKERS.filter((marker) => output.text.includes(marker)), output.path).toEqual([])
    }
    // Control: the same check finds the markers in the refresh command's bundle.
    const refresh = await build({
      entryPoints: [join(ROOT, CLI)],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      outdir: join(dir, 'bundle-refresh'),
      logLevel: 'silent',
    })
    expect(LIVE_MARKERS.filter((marker) => refresh.outputFiles[0].text.includes(marker))).toEqual(LIVE_MARKERS)
  })
})

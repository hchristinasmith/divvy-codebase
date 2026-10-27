// Refreshes the scrubbed replica from the live database (prd-03 Ruling 2).
//
// One refresh: copy the live file with SQLite's backup API into a scratch
// file beside the live database (a directory the MCP user cannot read), build
// a scrubbed replica from that copy into a temporary file beside the replica,
// then rename it over the replica. The rename is the only way the file at the
// replica path changes, so a reader opening it during a refresh sees either
// the previous replica or the new one, never a half-built file. A refresh that
// fails at any step (locked database, full disk, backup error, a schema the
// allowlist no longer matches) removes its scratch files and leaves the
// previous replica as it was.
//
// Watch mode refreshes every `intervalMs` (five minutes) and, between those,
// polls the live database every `pollMs` for a newer finished `sync_runs` row,
// refreshing as soon as one appears. That is how "shortly after each sync" is
// met without touching `server/sync/**`: the refresh process reads the live
// file it already has access to. A failed refresh is reported and the loop
// carries on.
//
// Runs as the web app's OS user, never inside the MCP process: the MCP entry
// does not import this module (`__tests__/refresh.test.ts` pins that).

import { rm, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import sqlite3 from 'sqlite3'
import { systemClock } from '../contracts.ts'
import type { Clock } from '../contracts.ts'
import { all, buildReplica, close, openDatabase } from './scrub.ts'
import type { BuiltReplicaMeta } from './scrub.ts'

/** Five minutes between refreshes (Ruling 2). */
export const REFRESH_INTERVAL_MS = 300_000

/**
 * How often watch mode looks for a newer finished sync. Half the 60 s the
 * issue allows between a sync finishing and the refresh starting.
 */
export const SYNC_POLL_MS = 30_000

export interface RefreshOptions {
  readonly livePath: string
  readonly replicaPath: string
  /** Where the unscrubbed backup copy is written; defaults to the live file's directory. */
  readonly workDir?: string
  readonly clock?: Clock
}

// The parts of node-sqlite3's Backup this module uses. Its type
// declarations omit `Database#backup`, which lib/sqlite3.js does define.
interface SqliteBackup {
  step(pages: number, callback: (error: Error | null) => void): void
  finish(callback: (error: Error | null) => void): void
  readonly completed: boolean
  retryErrors: number[]
}

interface BackupSource {
  backup(filename: string, callback: (error: Error | null) => void): SqliteBackup
}

/** Copies the whole live database into `copyPath` with the backup API. */
async function backupLive(livePath: string, copyPath: string): Promise<void> {
  const live = await openDatabase(livePath, sqlite3.OPEN_READONLY)
  try {
    const source = live as unknown as BackupSource
    let backup: SqliteBackup | undefined
    await new Promise<void>((resolve, reject) => {
      backup = source.backup(copyPath, (error) => (error ? reject(error) : resolve()))
    })
    const started = backup as SqliteBackup
    // Fail on a busy or locked database rather than retrying silently; the
    // watch loop is the retry.
    started.retryErrors = []
    try {
      await new Promise<void>((resolve, reject) => {
        started.step(-1, (error) => (error ? reject(error) : resolve()))
      })
      if (!started.completed) throw new Error('live database backup did not complete')
    } finally {
      await new Promise<void>((resolve) => started.finish(() => resolve()))
    }
  } finally {
    await close(live)
  }
}

let sequence = 0

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true })
  await rm(`${path}-journal`, { force: true })
}

/** Builds a fresh replica and renames it over `replicaPath`. Rejects, leaving the old one, on any failure. */
export async function refreshReplica(options: RefreshOptions): Promise<BuiltReplicaMeta> {
  const clock = options.clock ?? systemClock
  sequence += 1
  const tag = `${process.pid}-${Date.now()}-${sequence}`
  const copyPath = join(options.workDir ?? dirname(options.livePath), `.divvy-replica-copy-${tag}.sqlite3`)
  const tmpPath = join(dirname(options.replicaPath), `.${basename(options.replicaPath)}.${tag}.tmp`)
  let renamed = false
  try {
    // The copy holds the live state as of the moment the backup starts; the
    // replica claims no fresher data than that.
    const dataAsOf = clock.now().toISOString()
    await backupLive(options.livePath, copyPath)
    const meta = await buildReplica({ sourcePath: copyPath, targetPath: tmpPath, dataAsOf, clock })
    await rename(tmpPath, options.replicaPath)
    renamed = true
    return meta
  } finally {
    await removeFile(copyPath)
    if (!renamed) await removeFile(tmpPath)
  }
}

/**
 * The id of the newest finished `sync_runs` row in the live database, or null
 * if none has finished. Only one run can be running at a time, so a larger id
 * here means a sync finished since the last look.
 */
export async function readFinishedSyncMarker(livePath: string): Promise<number | null> {
  const live = await openDatabase(livePath, sqlite3.OPEN_READONLY)
  try {
    const rows = await all<{ id: number | null }>(live, 'SELECT max(id) AS id FROM sync_runs WHERE finished_at IS NOT NULL')
    return rows[0]?.id ?? null
  } finally {
    await close(live)
  }
}

export interface WatchOptions extends RefreshOptions {
  readonly intervalMs?: number
  readonly pollMs?: number
  /** Reports a failed refresh or poll; the loop continues either way. */
  readonly onError?: (error: unknown) => void
  /** Injectable for tests; default `refreshReplica`. */
  readonly refresh?: (options: RefreshOptions) => Promise<unknown>
  /** Injectable for tests; default `readFinishedSyncMarker`. */
  readonly readSyncMarker?: (livePath: string) => Promise<number | null>
}

export interface ReplicaWatcher {
  /** Stops the loop and resolves once any refresh in flight has settled. */
  stop(): Promise<void>
}

/** Refreshes now, then every `intervalMs` and within `pollMs` of a newer finished sync. */
export function watchReplica(options: WatchOptions): ReplicaWatcher {
  const clock = options.clock ?? systemClock
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS
  const pollMs = options.pollMs ?? SYNC_POLL_MS
  const refresh = options.refresh ?? refreshReplica
  const readSyncMarker = options.readSyncMarker ?? readFinishedSyncMarker
  const onError = options.onError ?? (() => undefined)

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastAttemptMs = Number.NEGATIVE_INFINITY
  // The marker the current replica was built after; undefined until the
  // first refresh succeeds, so a failed first refresh is retried next poll.
  let builtMarker: number | null | undefined
  let inFlight: Promise<void> = Promise.resolve()

  async function tick(): Promise<void> {
    try {
      const marker = await readSyncMarker(options.livePath)
      const now = clock.now().getTime()
      const due = builtMarker === undefined || marker !== builtMarker || now - lastAttemptMs >= intervalMs
      if (!due) return
      lastAttemptMs = now
      await refresh(options)
      // Read before the backup started, so the replica includes that sync.
      builtMarker = marker
    } catch (error) {
      onError(error)
    }
  }

  function loop(): void {
    inFlight = tick().then(() => {
      if (!stopped) timer = setTimeout(loop, pollMs)
    })
  }

  loop()
  return {
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await inFlight
    },
  }
}

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
// The scratch copy is unscrubbed, so it is made owner-only (0600) as soon as
// the backup finishes and switched out of WAL (a live file under Litestream is
// in WAL mode, and the backup copies that header), so reading it leaves no
// `-wal` or `-shm` beside the live file. A refresh process killed mid-run
// (SIGKILL, OOM) cannot clean up, so each refresh first sweeps scratch and
// temporary files left by a process that is no longer running, or by this
// one outside a refresh in flight. The replica is renamed into place as 0640:
// readable by its group (the MCP user's, set by the start script), not by all.
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

import { chmod, readdir, rm, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import sqlite3 from 'sqlite3'
import { systemClock } from '../contracts.ts'
import type { Clock } from '../contracts.ts'
import { all, buildReplica, close, openDatabase, run } from './scrub.ts'
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

/** The unscrubbed scratch copy: owner only. */
export const COPY_MODE = 0o600
/** The replica: the web app's user writes it, the MCP user's group reads it. */
export const REPLICA_MODE = 0o640

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

/** Makes the copy owner-only and leaves it in rollback-journal mode, with no `-wal` or `-shm`. */
async function sealCopy(copyPath: string): Promise<void> {
  await chmod(copyPath, COPY_MODE)
  const copy = await openDatabase(copyPath, sqlite3.OPEN_READWRITE)
  try {
    await run(copy, 'PRAGMA journal_mode = DELETE')
  } finally {
    await close(copy)
  }
}

let sequence = 0
/** Scratch and temporary paths of the refreshes this process has in flight. */
const refreshesInFlight = new Set<string>()

const SIDE_FILES = ['-journal', '-wal', '-shm'] as const

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true })
  for (const suffix of SIDE_FILES) await rm(`${path}${suffix}`, { force: true })
}

const COPY_PREFIX = '.divvy-replica-copy-'
const TAG = '(\\d+)-\\d+-\\d+'
const SIDE = '(?:-journal|-wal|-shm)?'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes files in `dir` matching `pattern` (whose first group is the pid
 * that wrote them) unless a running process, or a refresh in flight here,
 * owns them. Both patterns start with a dot and end in a refresh tag, so the
 * live database, the replica and their side files can never match.
 * Best-effort: litter is never a reason to skip a refresh.
 */
async function sweep(dir: string, pattern: RegExp): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const match = pattern.exec(name)
    if (!match) continue
    const path = join(dir, name)
    const pid = Number(match[1])
    const owned = pid === process.pid ? refreshesInFlight.has(path.replace(/-(?:journal|wal|shm)$/, '')) : processIsRunning(pid)
    if (owned) continue
    await rm(path, { force: true }).catch(() => undefined)
  }
}

/** Builds a fresh replica and renames it over `replicaPath`. Rejects, leaving the old one, on any failure. */
export async function refreshReplica(options: RefreshOptions): Promise<BuiltReplicaMeta> {
  const clock = options.clock ?? systemClock
  sequence += 1
  const tag = `${process.pid}-${Date.now()}-${sequence}`
  const workDir = options.workDir ?? dirname(options.livePath)
  const replicaDir = dirname(options.replicaPath)
  const copyPath = join(workDir, `${COPY_PREFIX}${tag}.sqlite3`)
  const tmpPath = join(replicaDir, `.${basename(options.replicaPath)}.${tag}.tmp`)
  await sweep(workDir, new RegExp(`^${escapeRegExp(COPY_PREFIX)}${TAG}\\.sqlite3${SIDE}$`))
  await sweep(replicaDir, new RegExp(`^\\.${escapeRegExp(basename(options.replicaPath))}\\.${TAG}\\.tmp${SIDE}$`))
  refreshesInFlight.add(copyPath)
  refreshesInFlight.add(tmpPath)
  let renamed = false
  try {
    // The copy holds the live state as of the moment the backup starts; the
    // replica claims no fresher data than that.
    const dataAsOf = clock.now().toISOString()
    await backupLive(options.livePath, copyPath)
    await sealCopy(copyPath)
    const meta = await buildReplica({ sourcePath: copyPath, targetPath: tmpPath, dataAsOf, clock })
    await chmod(tmpPath, REPLICA_MODE)
    await rename(tmpPath, options.replicaPath)
    renamed = true
    return meta
  } finally {
    await removeFile(copyPath)
    if (!renamed) await removeFile(tmpPath)
    refreshesInFlight.delete(copyPath)
    refreshesInFlight.delete(tmpPath)
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

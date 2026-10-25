import type { Knex } from 'knex'
import { createAkahuClient } from './akahu-client.ts'
import type { AkahuClient } from './akahu-client.ts'
import { runSync as defaultRunSync } from './run.ts'
import type { SyncOptions, SyncResult } from './run.ts'

// The in-process sync scheduler (prd-01 Ruling 6, issue #27): one per
// process, on the one machine Fly runs, calling `runSync` on a fixed
// interval and on demand ("sync now").
//
// One run at a time. The timer's tick and `trigger()` share one guard: the
// promise of the run in flight, set synchronously before anything is
// awaited, so a tick or a second press that arrives during a run is
// refused without writing or logging anything. `runSync` keeps its own
// database claim as well, which covers a run left `running` by a process
// that died; this guard covers the two callers inside one process.
//
// Nothing happens on import. `syncScheduler` is created unstarted and only
// `server/index.ts` calls `start()`, so a test that imports the app starts
// no timer. `start()` runs nothing immediately: the first run is one
// interval after boot.
//
// Failure is recorded, not thrown. `runSync` writes a failed `sync_runs`
// row for a missing credential or any Akahu or write failure (prd-01
// Done-when 4), which `/api/v1/sync/status` shows. If `runSync` itself
// rejects (it could not read or write `sync_runs`), the scheduler logs
// fixed text with the error's class name, never its message, and the next
// tick tries again; the process keeps running.
//
// Credentials are read from the environment when each run starts, never at
// import, and are passed to the Akahu client only. Nothing here logs them.

export const DEFAULT_SYNC_INTERVAL_MS = 900_000
/** A floor, so a typo cannot make the server call Akahu every few ms. */
export const MIN_SYNC_INTERVAL_MS = 60_000
/** The largest delay `setInterval` honours; above it Node fires after 1 ms. */
export const MAX_SYNC_INTERVAL_MS = 2_147_483_647

const INVALID_INTERVAL_WARNING =
  'sync scheduler: SYNC_INTERVAL_MS is not a whole number of milliseconds in the allowed range; using the default interval'

/**
 * `SYNC_INTERVAL_MS` as a delay. Unset or empty is the default and valid.
 * Anything else must be digits only, within the allowed range; otherwise
 * the default is used and `valid` is false.
 */
export function parseSyncIntervalMs(raw: string | undefined): {
  intervalMs: number
  valid: boolean
} {
  if (raw === undefined || raw === '') {
    return { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: true }
  }
  // Digits only: Number() would also accept '1e6', '0x10' and ' 900000 '.
  if (!/^\d+$/.test(raw)) {
    return { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }
  }
  const ms = Number(raw)
  if (ms < MIN_SYNC_INTERVAL_MS || ms > MAX_SYNC_INTERVAL_MS) {
    return { intervalMs: DEFAULT_SYNC_INTERVAL_MS, valid: false }
  }
  return { intervalMs: ms, valid: true }
}

export type TriggerResult =
  | { started: true }
  | { started: false; reason: 'already_running' }

export interface SchedulerState {
  /** True between `start()` and `stop()`. */
  started: boolean
  /** True while a run started by this process is in flight. */
  running: boolean
  /** When the timer next fires, as ISO-8601 UTC; null when not started. */
  nextRunAt: string | null
}

export interface SchedulerDeps {
  /** Defaults to `runSync` from `./run.ts`. */
  runSync?: (options: SyncOptions) => Promise<SyncResult>
  /** Called once per run. Defaults to the Akahu client over the env credentials. */
  createClient?: () => AkahuClient
  /** Passed to `runSync`; defaults to the app's database connection. */
  db?: Knex
  /** Trusted as given, not range-checked. Defaults to `SYNC_INTERVAL_MS`. */
  intervalMs?: number
  /** Defaults to the system clock. Passed to `runSync` too. */
  now?: () => Date
}

export interface SyncScheduler {
  /** Starts the timer. Throws if it is already started. Runs nothing now. */
  start(): void
  /** Stops the timer. A run in flight finishes. Safe to call twice. */
  stop(): void
  /** Starts a run unless one is in flight. Never waits for the run. */
  trigger(): TriggerResult
  getState(): SchedulerState
  /** Resolves once no run is in flight. Never rejects. */
  whenIdle(): Promise<void>
}

/** The Akahu client over the credentials in the environment right now. */
function clientFromEnv(): AkahuClient {
  return createAkahuClient({
    token: process.env.AKAHU_USER_TOKEN ?? '',
    appId: process.env.AKAHU_APP_ID ?? '',
  })
}

/** A class name is code, not data; a message can carry a credential. */
function errorClass(err: unknown): string {
  if (err instanceof Error) return err.constructor.name
  return typeof err
}

export function createSyncScheduler(deps: SchedulerDeps = {}): SyncScheduler {
  const runSync = deps.runSync ?? defaultRunSync
  const createClient = deps.createClient ?? clientFromEnv
  const now = deps.now ?? (() => new Date())

  let current: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let nextTickAt: number | null = null

  /** One run. Resolves whatever happens, so `current` never rejects. */
  async function execute(): Promise<void> {
    try {
      const client = createClient()
      await runSync({ client, db: deps.db, now })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('sync scheduler: runSync rejected', errorClass(err))
    }
  }

  function trigger(): TriggerResult {
    if (current !== null) return { started: false, reason: 'already_running' }
    current = execute().finally(() => {
      current = null
    })
    return { started: true }
  }

  return {
    start() {
      if (timer !== null) throw new Error('sync scheduler already started')
      let intervalMs = deps.intervalMs
      if (intervalMs === undefined) {
        const parsed = parseSyncIntervalMs(process.env.SYNC_INTERVAL_MS)
        if (!parsed.valid) {
          // eslint-disable-next-line no-console
          console.warn(INVALID_INTERVAL_WARNING)
        }
        intervalMs = parsed.intervalMs
      }
      const ms = intervalMs
      nextTickAt = now().getTime() + ms
      timer = setInterval(() => {
        nextTickAt = now().getTime() + ms
        trigger()
      }, ms)
      // The HTTP server keeps the process alive; the timer alone must not.
      timer.unref()
    },

    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
      nextTickAt = null
    },

    trigger,

    getState() {
      return {
        started: timer !== null,
        running: current !== null,
        nextRunAt:
          timer === null || nextTickAt === null
            ? null
            : new Date(nextTickAt).toISOString(),
      }
    },

    whenIdle() {
      return current ?? Promise.resolve()
    },
  }
}

/** The process's scheduler. Unstarted: only `server/index.ts` starts it. */
export const syncScheduler: SyncScheduler = createSyncScheduler()

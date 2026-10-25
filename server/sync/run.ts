import type { Knex } from 'knex'
import connection from '../db/connection.ts'
import type { SyncRun } from '../../models/sync.ts'
import { AkahuError } from './akahu-client.ts'
import type { AkahuClient } from './akahu-client.ts'
import { replacePending, upsertAccounts, upsertSettled } from './upsert.ts'

// One Akahu sync run (prd-01, issue #21): claim the run, fetch, then write
// everything in one database transaction.
//
// 1. Claim. One short transaction, before any request: a `running` row
//    younger than the stale timeout means another run holds sync, and this
//    one returns `skipped` having written nothing (Ruling 6). An older one
//    was left by a process that died; it is closed as `failed` with a fixed
//    message, because the partial unique index `sync_runs_one_running`
//    refuses a second `running` row while it stands.
// 2. Fetch, holding no database transaction. Settled transactions are read
//    before pending ones: a transaction that settles between the two reads
//    is then missing from both lists for one run, not present in both.
// 3. Write, in one transaction: accounts, then settled transactions, then
//    the pending mirror, then the run's own `success`. That last update
//    names `outcome = 'running'`, so a run that was declared stale and
//    superseded while it was fetching cannot commit over its successor.
// 4. On any failure the write transaction rolls back, the run is closed as
//    `failed`, and the result says so. Every table but `sync_runs` is left
//    exactly as it was.
//
// `error_message` is shown to Hannah and kept. It is built only from a
// fixed code and an HTTP status, never from an error's message, response
// or headers, which can carry the token (#19 contract, point 4). Nothing
// here logs.

/**
 * A `running` row older than this is treated as abandoned. Generous beside
 * a 15-minute schedule and the client's 30-second request timeout, so only
 * a dead process reaches it.
 */
export const STALE_RUN_AFTER_MS = 30 * 60_000

const DAY_MS = 24 * 60 * 60_000

/** Ruling 2: each run re-reads this much history. */
const OVERLAP_MS = 30 * DAY_MS

const ABANDONED_MESSAGE =
  'sync_abandoned: run did not finish within the stale timeout'

const MAX_ERROR_MESSAGE_LENGTH = 200

export interface SyncOptions {
  client: AkahuClient
  /** Defaults to the app's database connection. */
  db?: Knex
  /** Defaults to the system clock. */
  now?: () => Date
  /** Defaults to `STALE_RUN_AFTER_MS`. */
  staleAfterMs?: number
}

export type SyncResult =
  | {
      outcome: 'success'
      runId: number
      insertedCount: number
      updatedCount: number
      pendingMirroredCount: number
    }
  | { outcome: 'failed'; runId: number; errorMessage: string }
  | { outcome: 'skipped'; reason: 'already_running'; runningRunId: number }

type Claim =
  | { kind: 'claimed'; runId: number; lastSuccessStartedAt: string | null }
  | { kind: 'skipped'; runningRunId: number }

/**
 * The settled window to fetch (Ruling 2, amended by Ruling 10). With no
 * successful run yet, no window at all: neither bound is sent, so Akahu
 * returns everything it allows for this app (prd-01 Ruling 2; issue #139).
 * After one, from 30 days before the last success started, so an outage
 * longer than the overlap is still covered; never later than 30 days before
 * now. A start time that does not parse counts as no success, like the stale
 * check, so one bad row cannot fail every later run.
 */
function windowFor(
  lastSuccessStartedAt: string | null,
  now: Date,
): { start?: Date; end?: Date } {
  const lastSuccess =
    lastSuccessStartedAt === null ? NaN : Date.parse(lastSuccessStartedAt)
  if (Number.isNaN(lastSuccess)) return {}
  const start = Math.min(
    now.getTime() - OVERLAP_MS,
    lastSuccess - OVERLAP_MS,
  )
  return { start: new Date(start), end: now }
}

function runningRow(db: Knex): Promise<SyncRun | undefined> {
  return db('sync_runs').where({ outcome: 'running' }).first()
}

/** Step 1. Writes nothing when another fresh run holds sync. */
async function claim(
  db: Knex,
  startedAt: Date,
  staleAfterMs: number,
): Promise<Claim> {
  const startedIso = startedAt.toISOString()
  try {
    return await db.transaction(async (trx): Promise<Claim> => {
      const running: SyncRun | undefined = await trx('sync_runs')
        .where({ outcome: 'running' })
        .first()
      if (running !== undefined) {
        // A start time that does not parse is NaN, compares false, and so
        // is treated as abandoned rather than blocking sync forever.
        const fresh =
          Date.parse(running.started_at) >= startedAt.getTime() - staleAfterMs
        if (fresh) return { kind: 'skipped', runningRunId: running.id }
        await trx('sync_runs')
          .where({ id: running.id, outcome: 'running' })
          .update({
            outcome: 'failed',
            finished_at: startedIso,
            error_message: ABANDONED_MESSAGE,
          })
      }
      // A start that does not parse is skipped, not ranked: as text it would
      // sort after every ISO time and stay the latest success (#169).
      const lastSuccess: Pick<SyncRun, 'started_at'> | undefined = await trx(
        'sync_runs',
      )
        .where({ outcome: 'success' })
        .whereRaw('julianday(started_at) IS NOT NULL')
        .orderByRaw('julianday(started_at) DESC')
        .orderBy('id', 'desc')
        .first('started_at')
      const [runId] = await trx('sync_runs').insert({
        started_at: startedIso,
        outcome: 'running',
      })
      return {
        kind: 'claimed',
        runId,
        lastSuccessStartedAt: lastSuccess?.started_at ?? null,
      }
    })
  } catch (err) {
    // Another process claimed between the read and the insert, and the
    // unique index refused this one. Anything else is a real failure.
    const running = await runningRow(db)
    if (running !== undefined) {
      return { kind: 'skipped', runningRunId: running.id }
    }
    throw err
  }
}

/** Fixed text only: an error's own message can carry a credential. */
function failureMessage(err: unknown, phase: 'fetch' | 'write'): string {
  const text =
    err instanceof AkahuError
      ? `akahu_${err.code}` +
        (Number.isInteger(err.status) ? ` (HTTP ${err.status})` : '')
      : `sync_failed: ${phase}`
  return text.slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

/** Thrown inside the write transaction to roll it back. */
class RunNoLongerRunning extends Error {}

/**
 * Runs one sync. A skipped or failed run is returned, not thrown; only a
 * failure to read or write `sync_runs` itself rejects.
 */
export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { client } = options
  const db = options.db ?? connection
  const now = options.now ?? (() => new Date())
  const staleAfterMs = options.staleAfterMs ?? STALE_RUN_AFTER_MS

  const startedAt = now()
  const claimed = await claim(db, startedAt, staleAfterMs)
  if (claimed.kind === 'skipped') {
    return {
      outcome: 'skipped',
      reason: 'already_running',
      runningRunId: claimed.runningRunId,
    }
  }
  const { runId } = claimed

  let phase: 'fetch' | 'write' = 'fetch'
  try {
    const accounts = await client.listAccounts()
    const settled = await client.listTransactions(
      windowFor(claimed.lastSuccessStartedAt, startedAt),
    )
    const pending = await client.listPendingTransactions()

    phase = 'write'
    const counts = await db.transaction(async (trx) => {
      await upsertAccounts(trx, accounts, now().toISOString())
      const { inserted, updated } = await upsertSettled(trx, settled)
      const mirrored = await replacePending(trx, pending)
      const closed = await trx('sync_runs')
        .where({ id: runId, outcome: 'running' })
        .update({
          outcome: 'success',
          finished_at: now().toISOString(),
          inserted_count: inserted,
          updated_count: updated,
          pending_mirrored_count: mirrored,
        })
      if (closed !== 1) throw new RunNoLongerRunning()
      return { inserted, updated, mirrored }
    })
    return {
      outcome: 'success',
      runId,
      insertedCount: counts.inserted,
      updatedCount: counts.updated,
      pendingMirroredCount: counts.mirrored,
    }
  } catch (err) {
    const errorMessage = failureMessage(err, phase)
    // Names `outcome = 'running'` so a row already closed as abandoned
    // keeps the reason it was given.
    await db('sync_runs').where({ id: runId, outcome: 'running' }).update({
      outcome: 'failed',
      finished_at: now().toISOString(),
      error_message: errorMessage,
    })
    return { outcome: 'failed', runId, errorMessage }
  }
}

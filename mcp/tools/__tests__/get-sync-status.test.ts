// `get_sync_status` (prd-03 Ruling 1, Ruling 2; #80 Done when 3). This test
// fails if:
//   - the result gains, loses or renames a key, or carries sync error text;
//   - `age_seconds` is not whole seconds from `data_as_of` to the clock,
//     floored, or goes negative when the clock is behind the copy;
//   - `last_sync_status` is not the outcome of the run `last_sync_at` names
//     (the newest-finished or first run instead), including a run whose
//     `finished_at` is the epoch milliseconds the scrub converts to ISO, or
//     is not null when there is no finished sync;
//   - a replica that cannot be read becomes a result instead of a throw.
//
// It runs the handler against a real small replica file through the real
// reader, so the SQL is exercised, not mocked.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clock, HandlerContext, HandlerOutcome } from '../../contracts.ts'
import { openReplica } from '../../replica/index.ts'
import { close, openDatabase, run } from '../../replica/scrub.ts'
import { getSyncStatus } from '../get-sync-status.ts'

const RESULT_KEYS = ['age_seconds', 'data_as_of', 'last_sync_at', 'last_sync_status', 'replica_built_at']

const DATA_AS_OF = '2026-10-28T01:00:00.000Z'
const BUILT_AT = '2026-10-28T01:00:05.000Z'
const ERROR_TEXT = 'akahu said: sentinel-error-7c3a'

interface SyncRunRow {
  readonly started_at: string
  readonly finished_at: string | number | null
  readonly outcome: string
}

// Three finished runs and one running. The middle one is the run meta names,
// so neither "newest finished" nor "first row" picks it by accident.
const RUNS: readonly SyncRunRow[] = [
  { started_at: '2026-10-27T22:00:00.000Z', finished_at: '2026-10-27T22:01:00.000Z', outcome: 'success' },
  { started_at: '2026-10-28T00:57:00.000Z', finished_at: '2026-10-28T00:58:00.000Z', outcome: 'failed' },
  { started_at: '2026-10-28T03:00:00.000Z', finished_at: '2026-10-28T03:01:00.000Z', outcome: 'success' },
  { started_at: '2026-10-28T04:00:00.000Z', finished_at: null, outcome: 'running' },
]

let dir: string
let path: string

/**
 * A small replica: `replica_meta` and `sync_runs` as the scrub writes them.
 * `sync_runs` here also has an `error_message` the real replica never has,
 * so a handler that read every column would leak it into the result.
 */
async function writeReplica(lastSyncAt: string | null, runs: readonly SyncRunRow[] = RUNS): Promise<void> {
  const db = await openDatabase(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
  try {
    await run(db, 'CREATE TABLE replica_meta (built_at TEXT NOT NULL, last_sync_at TEXT, data_as_of TEXT NOT NULL)')
    await run(db, 'INSERT INTO replica_meta VALUES (?, ?, ?)', [BUILT_AT, lastSyncAt, DATA_AS_OF])
    await run(db, 'CREATE TABLE sync_runs (started_at datetime, finished_at datetime, outcome text, error_message text)')
    for (const r of runs) {
      await run(db, 'INSERT INTO sync_runs VALUES (?, ?, ?, ?)', [r.started_at, r.finished_at, r.outcome, ERROR_TEXT])
    }
  } finally {
    await close(db)
  }
}

async function contextAt(iso: string): Promise<HandlerContext> {
  const clock: Clock = { now: () => new Date(iso) }
  return { replica: await openReplica({ path }), clock }
}

async function call(ctx: HandlerContext): Promise<Extract<HandlerOutcome, { ok: true }>> {
  const outcome = await getSyncStatus.handler({}, ctx)
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`)
  return outcome
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'divvy-sync-status-'))
  path = join(dir, 'replica.sqlite3')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('get_sync_status', () => {
  it('returns exactly the result fields, for the run last_sync_at names', async () => {
    await writeReplica('2026-10-28T00:58:00.000Z')
    const outcome = await call(await contextAt('2026-10-28T01:02:03.999Z'))

    expect(Object.keys(outcome.result).sort()).toEqual(RESULT_KEYS)
    expect(outcome.result).toStrictEqual({
      last_sync_at: '2026-10-28T00:58:00.000Z',
      last_sync_status: 'failed',
      replica_built_at: BUILT_AT,
      data_as_of: DATA_AS_OF,
      age_seconds: 123,
    })
    expect(outcome.rowCount).toBe(1)
  })

  it('never carries sync error text, even when the replica holds some', async () => {
    await writeReplica('2026-10-28T00:58:00.000Z')
    const outcome = await call(await contextAt('2026-10-28T01:02:03.000Z'))
    const text = JSON.stringify(outcome.result)

    expect(text).not.toContain('sentinel-error')
    expect(text).not.toContain('error')
  })

  it('picks the later-started run when two finished at the same instant', async () => {
    const at = '2026-10-28T00:58:00.000Z'
    await writeReplica(at, [
      { started_at: '2026-10-28T00:50:00.000Z', finished_at: at, outcome: 'success' },
      { started_at: '2026-10-28T00:57:00.000Z', finished_at: at, outcome: 'failed' },
      { started_at: '2026-10-28T00:40:00.000Z', finished_at: at, outcome: 'success' },
    ])
    const outcome = await call(await contextAt('2026-10-28T01:00:00.000Z'))

    expect(outcome.result).toMatchObject({ last_sync_status: 'failed' })
  })

  it('finds the run when its finished_at is the epoch milliseconds the scrub converted', async () => {
    const at = '2026-10-28T00:58:00.000Z'
    await writeReplica(at, [
      { started_at: '2026-10-28T00:50:00.000Z', finished_at: Date.parse('2026-10-28T00:51:00.000Z'), outcome: 'success' },
      { started_at: '2026-10-28T00:57:00.000Z', finished_at: Date.parse(at), outcome: 'failed' },
    ])
    const outcome = await call(await contextAt('2026-10-28T01:00:00.000Z'))

    expect(outcome.result).toMatchObject({ last_sync_at: at, last_sync_status: 'failed' })
    expect(outcome.rowCount).toBe(1)
  })

  it('reports a null last sync and status when nothing has finished', async () => {
    await writeReplica(null, [{ started_at: '2026-10-28T00:57:00.000Z', finished_at: null, outcome: 'running' }])
    const outcome = await call(await contextAt('2026-10-28T01:00:10.000Z'))

    expect(Object.keys(outcome.result).sort()).toEqual(RESULT_KEYS)
    expect(outcome.result).toMatchObject({ last_sync_at: null, last_sync_status: null, age_seconds: 10 })
    expect(outcome.rowCount).toBe(0)
  })

  it('reports a null status when no run matches last_sync_at', async () => {
    await writeReplica('2026-10-28T00:59:59.000Z')
    const outcome = await call(await contextAt('2026-10-28T01:00:00.000Z'))

    expect(outcome.result).toMatchObject({ last_sync_at: '2026-10-28T00:59:59.000Z', last_sync_status: null })
    expect(outcome.rowCount).toBe(0)
  })

  it('floors age to whole seconds and clamps a clock behind the copy at 0', async () => {
    await writeReplica('2026-10-28T00:58:00.000Z')

    expect((await call(await contextAt('2026-10-28T01:00:00.000Z'))).result).toMatchObject({ age_seconds: 0 })
    expect((await call(await contextAt('2026-10-28T01:00:00.999Z'))).result).toMatchObject({ age_seconds: 0 })
    expect((await call(await contextAt('2026-10-28T01:00:01.000Z'))).result).toMatchObject({ age_seconds: 1 })
    expect((await call(await contextAt('2026-10-29T01:00:00.000Z'))).result).toMatchObject({ age_seconds: 86_400 })
    expect((await call(await contextAt('2026-10-28T00:59:00.000Z'))).result).toMatchObject({ age_seconds: 0 })
  })

  it('throws, rather than returning text, when the replica cannot be read', async () => {
    await expect(getSyncStatus.handler({}, await contextAt('2026-10-28T01:00:00.000Z'))).rejects.toThrow()
  })
})

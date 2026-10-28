// `get_sync_status` (prd-03 Ruling 1, Ruling 2): when the bank data was last
// synced, how that sync ended, and how old the advisor's copy is.
//
// The result carries exactly `last_sync_at`, `last_sync_status`,
// `replica_built_at`, `data_as_of` and `age_seconds`. It never carries sync
// error text: the replica has no `sync_runs.error_message` (the allowlist
// leaves it out), and this handler reads only `outcome` from `sync_runs`.
//
// `last_sync_at` is the replica meta's: the `finished_at` of the newest
// finished run in the copy. The replica's `sync_runs` keeps no `id`, so the
// run is found again by that `finished_at`, as text or as the epoch
// milliseconds the scrub converted to it; two runs finishing at the same
// instant resolve to the later-started one. A failure reading the replica is
// thrown, never returned as text; the dispatcher answers it `internal_error`.

import { READ_ONLY_ANNOTATIONS, staticSql } from '../contracts.ts'
import type { HandlerOutcome, SqlValue, ToolResult } from '../contracts.ts'
import { defineTool, noInputSchema } from './common.ts'

const NAME = 'get_sync_status'

/** How a sync run ended, as `sync_runs.outcome` records it. */
type SyncStatus = 'running' | 'success' | 'failed'

const SYNC_STATUSES: readonly string[] = ['running', 'success', 'failed'] satisfies SyncStatus[]

/** The result, without the `data_as_of` every result carries. */
interface SyncStatusResult {
  readonly last_sync_at: string | null
  readonly last_sync_status: SyncStatus | null
  readonly replica_built_at: string
  readonly age_seconds: number
}

function isSyncStatus(value: SqlValue | undefined): value is SyncStatus {
  return typeof value === 'string' && SYNC_STATUSES.includes(value)
}

export const getSyncStatus = defineTool({
  name: NAME,
  title: 'Sync status',
  description:
    'When the bank data was last synced and how old the advisor copy is. Takes no input. Read-only.',
  inputSchema: noInputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  async handler(_input, ctx): Promise<HandlerOutcome> {
    const meta = await ctx.replica.meta()

    let lastSyncStatus: SyncStatus | null = null
    let rowCount = 0
    if (meta.last_sync_at !== null) {
      // The scrub turns a numeric `finished_at` (epoch ms) into ISO for
      // meta, so the run may hold either form; match both.
      const asMs = Date.parse(meta.last_sync_at)
      const rows = await ctx.replica.select<{ outcome: SqlValue }>({
        sql: staticSql`SELECT outcome FROM sync_runs WHERE finished_at IN (?, ?) ORDER BY started_at DESC LIMIT 1`,
        params: [meta.last_sync_at, Number.isNaN(asMs) ? null : asMs],
        maxRows: 1,
      })
      rowCount = rows.length
      const outcome = rows[0]?.outcome
      if (outcome !== undefined && !isSyncStatus(outcome)) throw new Error('sync_runs.outcome is not a known status')
      lastSyncStatus = outcome ?? null
    }

    // Age is measured from `data_as_of`, not `built_at` or `last_sync_at`:
    // it is the moment the answers reflect (Ruling 2), so it is how stale
    // whatever the advisor says is. A clock behind the copy reads as 0.
    const asOf = Date.parse(meta.data_as_of)
    if (Number.isNaN(asOf)) throw new Error('replica data_as_of is not a timestamp')
    const ageSeconds = Math.max(0, Math.floor((ctx.clock.now().getTime() - asOf) / 1000))

    const result: ToolResult<SyncStatusResult> = {
      last_sync_at: meta.last_sync_at,
      last_sync_status: lastSyncStatus,
      replica_built_at: meta.built_at,
      data_as_of: meta.data_as_of,
      age_seconds: ageSeconds,
    }
    return { ok: true, rowCount, result }
  },
})

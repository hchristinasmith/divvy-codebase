import { useQuery } from '@tanstack/react-query'
import { grabSyncStatus } from '../../apis/apiClient.ts'
import { queryKeys } from '../../apis/queryKeys.ts'
import { formatSyncAge } from '../../hooks/useSyncPill.ts'
// Type only: erased from the client bundle.
import type { SyncStatus } from '../../../server/routes/sync.ts'

// The Dashboard's "last synced" line (prd-01, issue #32), from
// `GET /api/v1/sync/status` (#27): how long ago and exactly when the banks
// last synced, "Never synced" before the first success, and a failed last
// run shown as failed, never hidden behind an older success or behind
// "Never synced". A run in progress is not a failure.
//
// Its own query key: the header's sync pill caches a different value
// (a timestamp, not the body) under `queryKeys.syncStatus.all`, and two
// queryFns under one key would overwrite each other. The key sits under the
// same prefix, so invalidating `syncStatus.all` reaches both.
const LAST_SYNCED_KEY = [...queryKeys.syncStatus.all, 'full'] as const

const MINUTE = 60_000

// The browser's own time zone.
const absoluteTime = new Intl.DateTimeFormat('en-NZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatAbsolute(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? iso : absoluteTime.format(at)
}

// A 200 that is not the status body (an HTML page, `{}`) is an error, never
// "Never synced": that would claim something the body does not say.
function isSyncStatus(body: unknown): body is SyncStatus {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false
  }
  const fields = body as Record<string, unknown>
  if (typeof fields.running !== 'boolean') return false
  if (!('lastSuccessAt' in fields)) return false
  const at = fields.lastSuccessAt
  return (
    at === null || (typeof at === 'string' && !Number.isNaN(Date.parse(at)))
  )
}

async function fetchSyncStatus(): Promise<SyncStatus> {
  const body: unknown = await grabSyncStatus()
  if (!isSyncStatus(body)) throw new Error('Unexpected sync status')
  return body
}

export default function LastSynced() {
  const { data, isPending, isError, dataUpdatedAt } = useQuery({
    queryKey: LAST_SYNCED_KEY,
    queryFn: fetchSyncStatus,
    retry: false,
    refetchInterval: MINUTE,
  })

  if (isError) {
    return (
      <p data-last-synced="error" className="text-body-13 text-ink-muted">
        Sync status unavailable
      </p>
    )
  }
  if (isPending) {
    return (
      <p data-last-synced="loading" className="text-body-13 text-ink-muted">
        Checking sync status…
      </p>
    )
  }

  // A reply is aged against the moment it arrived if that is later than the
  // render (a sleeping machine), never against an older clock.
  const now = Math.max(Date.now(), dataUpdatedAt)
  const successLine =
    data.lastSuccessAt === null
      ? null
      : `${formatSyncAge(now - Date.parse(data.lastSuccessAt))} · ${formatAbsolute(data.lastSuccessAt)}`

  const run = data.lastRun
  if (run?.outcome === 'failed') {
    const failedAt = formatAbsolute(run.finishedAt ?? run.startedAt)
    return (
      <div data-last-synced="failed" className="text-body-13">
        <p className="text-danger">
          Last sync failed at {failedAt}
          {run.error ? ` (${run.error})` : ''}
        </p>
        {successLine !== null && (
          <p className="text-ink-muted">{successLine}</p>
        )}
      </div>
    )
  }

  if (successLine === null) {
    return (
      <p data-last-synced="never" className="text-body-13 text-ink-muted">
        Never synced
      </p>
    )
  }
  return (
    <p data-last-synced="synced" className="text-body-13 text-ink-muted">
      {successLine}
    </p>
  )
}

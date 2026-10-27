import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '../apis/queryKeys.ts'

// The header's sync pill: a status dot and how long ago the banks last
// synced, from prd-01's `GET /api/v1/sync/status` (#27). Whenever that request
// fails or returns something unexpected, the pill is neutral ("Not synced
// yet"): it never shows a time it does not have.

// The part of #27's contract the pill reads. The full body is
// `{ running, lastRun, lastSuccessAt, nextRunAt }`; lastSuccessAt is an
// ISO-8601 UTC string, or null before the first successful sync.
interface SyncStatusBody {
  lastSuccessAt: string | null
}

export type SyncPillState = 'unknown' | 'fresh' | 'stale'

export interface SyncPill {
  state: SyncPillState
  label: string
}

// Older than two missed 15-minute syncs (prd-01 Ruling 6) reads as stale.
export const STALE_AFTER_MS = 30 * 60 * 1000

// A timestamp this far ahead of the browser's clock is clock skew we accept;
// anything further is not a real sync time.
const FUTURE_TOLERANCE_MS = 60 * 1000

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const NEUTRAL: SyncPill = { state: 'unknown', label: 'Not synced yet' }

// The last successful sync as epoch milliseconds, or null when the body does
// not carry a believable one.
export function parseSyncStatus(body: unknown, now: number): number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }
  const { lastSuccessAt } = body as Partial<SyncStatusBody>
  if (typeof lastSuccessAt !== 'string') return null
  const at = Date.parse(lastSuccessAt)
  if (Number.isNaN(at)) return null
  if (at - now > FUTURE_TOLERANCE_MS) return null
  return at
}

export function formatSyncAge(ageMs: number): string {
  const age = Math.max(0, ageMs)
  if (age < MINUTE) return 'Synced just now'
  if (age < HOUR) return `Synced ${Math.floor(age / MINUTE)} min ago`
  if (age < DAY) return `Synced ${Math.floor(age / HOUR)} h ago`
  return `Synced ${Math.floor(age / DAY)} d ago`
}

export function syncPillFor(
  lastSuccessAt: number | null,
  now: number,
): SyncPill {
  if (lastSuccessAt === null) return NEUTRAL
  const age = now - lastSuccessAt
  return {
    state: age > STALE_AFTER_MS ? 'stale' : 'fresh',
    label: formatSyncAge(age),
  }
}

// Lives here rather than in client/apis/apiClient.ts because that file was
// outside this issue's fence; it can move there with the Sync screen (w4).
async function fetchLastSuccessAt(): Promise<number | null> {
  const res = await fetch(new URL('/api/v1/sync/status', document.baseURI))
  if (!res.ok) return null
  return parseSyncStatus(await res.json(), Date.now())
}

export function useSyncPill(): SyncPill {
  const { data, isError, dataUpdatedAt } = useQuery({
    queryKey: queryKeys.syncStatus.all,
    queryFn: fetchLastSuccessAt,
    // A failure shows the neutral pill at once rather than after retries.
    retry: false,
    refetchInterval: MINUTE,
  })

  // Re-render each minute so "N min ago" keeps moving between fetches.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(id)
  }, [])

  if (isError || data === undefined) return NEUTRAL
  // A reply that landed after the last tick (or after the machine woke) is
  // aged against the moment it arrived, never against an older tick.
  return syncPillFor(data, Math.max(now, dataUpdatedAt))
}

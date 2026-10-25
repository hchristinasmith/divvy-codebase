import { queryKeys } from '../../apis/queryKeys.ts'

// What the Privacy screen's Server card reads: prd-01's
// `GET /api/v1/sync/status` (`SyncStatus` in server/routes/sync.ts). Only
// two of its fields are shown, because they are the only things on the
// card the app can report truthfully (issue Done-when 2).
//
// Its own query key, under the sync-status prefix: the header's sync pill
// caches a parsed epoch number at the bare `queryKeys.syncStatus.all`, and
// this card caches an object, so the two must never share an entry. An
// invalidation of the prefix still reaches both.
export const SERVER_STATUS_KEY = [
  ...queryKeys.syncStatus.all,
  'privacy',
] as const

interface ServerStatus {
  // ISO-8601 UTC, or null before the first successful sync.
  lastSuccessAt: string | null
  // ISO-8601 UTC, or null while the scheduler is stopped.
  nextRunAt: string | null
}

function timestampOrNull(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return value
  }
  throw new Error(`sync status: ${field} is not a timestamp or null`)
}

// The two fields the card shows, or a throw when the body does not carry
// them. A throw puts the card in its error state, so a body it cannot read
// is "Unavailable", never "Never synced".
export function parseServerStatus(body: unknown): ServerStatus {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('sync status: the body is not an object')
  }
  // A missing field reads as undefined, which timestampOrNull refuses.
  const fields = body as Record<string, unknown>
  return {
    lastSuccessAt: timestampOrNull(fields.lastSuccessAt, 'lastSuccessAt'),
    nextRunAt: timestampOrNull(fields.nextRunAt, 'nextRunAt'),
  }
}

// Same-origin, built the way the sync pill builds it
// (client/hooks/useSyncPill.ts), so the only host this screen calls is the
// one that served it.
export async function fetchServerStatus(): Promise<ServerStatus> {
  const res = await fetch(new URL('/api/v1/sync/status', document.baseURI))
  if (!res.ok) throw new Error(`sync status: server error (${res.status})`)
  return parseServerStatus(await res.json())
}

const WHEN = new Intl.DateTimeFormat('en-NZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

// An absolute local time, the same format as the Dashboard's last-synced
// line. Only called on a value parseServerStatus accepted.
export function formatWhen(iso: string): string {
  return WHEN.format(Date.parse(iso))
}

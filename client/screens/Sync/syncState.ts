import {
  formatSyncAge,
  parseSyncStatus,
  syncPillFor,
} from '../../hooks/useSyncPill.ts'
import type { SyncScreenStatus } from '../../apis/sync.ts'

// What every row on the Sync screen shows about the last sync. prd-01's
// status is global (one scheduler, one `sync_runs` table), so every row
// carries the same state; there is no per-bank status to show.
//
// Freshness is the header pill's own rule, imported rather than copied
// (client/hooks/useSyncPill.ts): the pill's stale threshold turns the dot
// amber, its fresh one green, and a missing or unbelievable last success is
// "Not synced yet" with no time. A row never shows a time the server did not
// report (issue 59 Done-when 1).

/** Which state a row is in. The first that applies wins, in this order. */
type SyncRowKind = 'running' | 'failed' | 'never' | 'stale' | 'fresh'

/** The dot's colour: the pill's states, plus a failed run's danger. */
type SyncDotTone = 'fresh' | 'stale' | 'failed' | 'unknown'

export interface SyncRowState {
  kind: SyncRowKind
  tone: SyncDotTone
  // Words before the account names, or null when the dot and time say it.
  lead: string | null
  // "4 min ago", or null when there is no server time to show.
  time: string | null
}

// The pill reads "Synced 4 min ago"; a row's time column reads "4 min ago".
function rowTime(pillLabel: string): string {
  return pillLabel.replace(/^Synced /, '')
}

/**
 * The row state for a status, aged against `now` (epoch ms).
 *
 * - running: a sync is in flight on the server. The dot and time stay what
 *   the last success gives, so a row does not claim a new time early.
 * - failed: the last run failed. The time is when it failed, or none when
 *   that time is not believable by the pill's rule.
 * - never, stale, fresh: from the last success, by the pill's rule.
 *
 * A `running` outcome with `running` false is a leftover row from a process
 * that died: it is neither running nor failed, so it falls through to the
 * last success.
 */
export function rowStateFor(
  status: SyncScreenStatus,
  now: number,
): SyncRowState {
  const lastSuccess = parseSyncStatus(status, now)
  const pill = syncPillFor(lastSuccess, now)
  const sinceSuccess = lastSuccess === null ? null : rowTime(pill.label)
  // The pill's 'unknown', 'fresh' or 'stale', as a dot tone.
  const successTone: SyncDotTone = pill.state

  if (status.running) {
    return {
      kind: 'running',
      tone: successTone,
      lead: 'Syncing…',
      time: sinceSuccess,
    }
  }
  const run = status.lastRun
  if (run !== null && run.outcome === 'failed') {
    // The pill's rule for a believable time, so a failure stamped ahead of
    // the browser's clock shows no time rather than "just now".
    const failedAt = parseSyncStatus(
      { lastSuccessAt: run.finishedAt ?? run.startedAt },
      now,
    )
    return {
      kind: 'failed',
      tone: 'failed',
      lead: 'Last sync failed',
      time: failedAt === null ? null : rowTime(formatSyncAge(now - failedAt)),
    }
  }
  if (pill.state === 'unknown') {
    return { kind: 'never', tone: 'unknown', lead: 'Not synced yet', time: null }
  }
  return { kind: pill.state, tone: pill.state, lead: null, time: sinceSuccess }
}

/** What the dot says to a screen reader, per row state. */
export const DOT_LABELS: Record<SyncRowKind, string> = {
  running: 'Syncing',
  failed: 'Last sync failed',
  never: 'Not synced yet',
  stale: 'Out of date',
  fresh: 'Up to date',
}

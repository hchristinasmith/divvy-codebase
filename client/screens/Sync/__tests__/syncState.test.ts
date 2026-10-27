import { describe, expect, it } from 'vitest'
import {
  STALE_AFTER_MS,
  formatSyncAge,
  syncPillFor,
} from '../../../hooks/useSyncPill.ts'
import type { SyncScreenStatus } from '../../../apis/sync.ts'
import { rowStateFor, type SyncRowState } from '../syncState.ts'

// The Sync screen's row state (issue 59 Done-when 1 and 4): first match
// wins, running, failed, never, stale, fresh. Freshness is the header pill's
// rule, so the row and the pill can never disagree on the same status.

const NOW = Date.parse('2026-10-26T09:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000

function status(overrides: Partial<SyncScreenStatus> = {}): SyncScreenStatus {
  return {
    running: false,
    lastRun: null,
    lastSuccessAt: null,
    nextRunAt: null,
    ...overrides,
  }
}

const ROW_KEYS = ['kind', 'tone', 'lead', 'time']

function expectRow(row: SyncRowState, expected: SyncRowState) {
  // Fails if a key stops being produced, which toEqual alone cannot see.
  expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort())
  expect(row).toEqual(expected)
}

describe('rowStateFor', () => {
  it('is fresh and green-toned with the pill time when the last success is recent', () => {
    // Fails if the time is not the pill's age or a lead is invented.
    expectRow(rowStateFor(status({ lastSuccessAt: ago(4 * MIN) }), NOW), {
      kind: 'fresh',
      tone: 'fresh',
      lead: null,
      time: '4 min ago',
    })
  })

  it('turns stale exactly where the pill does', () => {
    // Fails if the row keeps its own threshold instead of the pill's.
    const atLimit = rowStateFor(
      status({ lastSuccessAt: ago(STALE_AFTER_MS) }),
      NOW,
    )
    const past = rowStateFor(
      status({ lastSuccessAt: ago(STALE_AFTER_MS + 1) }),
      NOW,
    )
    expect(atLimit.kind).toBe(syncPillFor(NOW - STALE_AFTER_MS, NOW).state)
    expect(atLimit.kind).toBe('fresh')
    expect(past.kind).toBe('stale')
    expect(past.tone).toBe('stale')
    expect(past.lead).toBeNull()
  })

  it('is never, with no time, when the server reports no success', () => {
    // Fails if a row guesses a time from the last run or from now.
    expectRow(
      rowStateFor(
        status({ lastRun: { startedAt: ago(MIN), finishedAt: null, outcome: 'running' } }),
        NOW,
      ),
      { kind: 'never', tone: 'unknown', lead: 'Not synced yet', time: null },
    )
  })

  it('treats a last success in the future as no success, as the pill does', () => {
    // Fails if an unbelievable server time is shown as "just now".
    const row = rowStateFor(status({ lastSuccessAt: ago(-60 * MIN) }), NOW)
    expect(row.kind).toBe('never')
    expect(row.time).toBeNull()
  })

  it('shows a failed last run as failed, timed from when it finished', () => {
    // Fails if a failure hides behind an older success, or is timed from
    // the success rather than the failure.
    expectRow(
      rowStateFor(
        status({
          lastSuccessAt: ago(90 * MIN),
          lastRun: {
            startedAt: ago(12 * MIN),
            finishedAt: ago(11 * MIN),
            outcome: 'failed',
          },
        }),
        NOW,
      ),
      { kind: 'failed', tone: 'failed', lead: 'Last sync failed', time: '11 min ago' },
    )
  })

  it('times a failed run with no finish from its start', () => {
    // Fails if a null finishedAt is parsed (NaN) instead of falling back.
    const row = rowStateFor(
      status({
        lastRun: { startedAt: ago(7 * MIN), finishedAt: null, outcome: 'failed' },
      }),
      NOW,
    )
    expect(row.time).toBe('7 min ago')
  })

  it('shows no time for a failed run stamped ahead of the clock, never "just now"', () => {
    // Fails if the failure time skips the pill's rule for a believable time.
    expectRow(
      rowStateFor(
        status({
          lastRun: { startedAt: ago(-60 * MIN), finishedAt: ago(-59 * MIN), outcome: 'failed' },
        }),
        NOW,
      ),
      { kind: 'failed', tone: 'failed', lead: 'Last sync failed', time: null },
    )
  })

  it('leads with "Syncing…" while running and keeps the last success time and tone', () => {
    // Fails if a running row claims a new time or a green dot early.
    expectRow(
      rowStateFor(
        status({
          running: true,
          lastSuccessAt: ago(45 * MIN),
          lastRun: { startedAt: ago(0), finishedAt: null, outcome: 'running' },
        }),
        NOW,
      ),
      { kind: 'running', tone: 'stale', lead: 'Syncing…', time: '45 min ago' },
    )
  })

  it('puts running before failed', () => {
    // Fails if the branches are reordered: a new run after a failure is
    // a sync in progress, not a failure.
    const row = rowStateFor(
      status({
        running: true,
        lastRun: { startedAt: ago(MIN), finishedAt: ago(0), outcome: 'failed' },
      }),
      NOW,
    )
    expect(row.kind).toBe('running')
    expect(row.tone).toBe('unknown')
    expect(row.time).toBeNull()
  })

  it('lets a leftover running row from a dead process fall through to the last success', () => {
    // Fails if the row keys on lastRun.outcome instead of `running`.
    expectRow(
      rowStateFor(
        status({
          running: false,
          lastSuccessAt: ago(3 * MIN),
          lastRun: { startedAt: ago(20 * MIN), finishedAt: null, outcome: 'running' },
        }),
        NOW,
      ),
      { kind: 'fresh', tone: 'fresh', lead: null, time: '3 min ago' },
    )
  })

  it('relies on the pill wording starting with "Synced "', () => {
    // The row time is the pill label with "Synced " removed. A reword of
    // formatSyncAge turns this red before rows read "Updated 4 min ago".
    for (const age of [0, 4 * MIN, 3 * 60 * MIN, 2 * 24 * 60 * MIN]) {
      expect(formatSyncAge(age).startsWith('Synced ')).toBe(true)
    }
  })
})

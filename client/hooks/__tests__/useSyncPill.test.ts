import { describe, expect, it } from 'vitest'
import {
  STALE_AFTER_MS,
  formatSyncAge,
  parseSyncStatus,
  syncPillFor,
} from '../useSyncPill.ts'

const NOW = Date.parse('2026-10-23T09:00:00.000Z')
const MIN = 60_000

describe('formatSyncAge', () => {
  it.each([
    [0, 'Synced just now'],
    [59_999, 'Synced just now'],
    [MIN, 'Synced 1 min ago'],
    [4 * MIN, 'Synced 4 min ago'],
    [59 * MIN + 59_999, 'Synced 59 min ago'],
    [60 * MIN, 'Synced 1 h ago'],
    [23 * 60 * MIN + 59 * MIN, 'Synced 23 h ago'],
    [24 * 60 * MIN, 'Synced 1 d ago'],
    [2 * 24 * 60 * MIN, 'Synced 2 d ago'],
    // Within the accepted clock skew a sync can look slightly ahead.
    [-30_000, 'Synced just now'],
  ])('%i ms reads "%s"', (age, label) => {
    expect(formatSyncAge(age)).toBe(label)
  })
})

describe('parseSyncStatus', () => {
  it('reads lastSuccessAt from the #27 status body', () => {
    const body = {
      running: false,
      lastRun: null,
      lastSuccessAt: '2026-10-23T08:56:00.000Z',
      nextRunAt: '2026-10-23T09:11:00.000Z',
    }
    expect(parseSyncStatus(body, NOW)).toBe(
      Date.parse('2026-10-23T08:56:00.000Z'),
    )
  })

  it.each([
    ['null', null],
    ['an array', [{ lastSuccessAt: '2026-10-23T08:56:00.000Z' }]],
    ['a string', '2026-10-23T08:56:00.000Z'],
    ['an empty object', {}],
    ['a null lastSuccessAt', { lastSuccessAt: null }],
    ['a numeric lastSuccessAt', { lastSuccessAt: NOW }],
    ['an unparseable date', { lastSuccessAt: 'yesterday' }],
    [
      'a date over a minute ahead',
      { lastSuccessAt: '2026-10-23T09:01:01.000Z' },
    ],
  ])('returns null for %s', (_why, body) => {
    expect(parseSyncStatus(body, NOW)).toBeNull()
  })

  it('accepts a date up to a minute ahead (clock skew)', () => {
    expect(
      parseSyncStatus({ lastSuccessAt: '2026-10-23T09:00:59.000Z' }, NOW),
    ).not.toBeNull()
  })
})

describe('syncPillFor', () => {
  it('is neutral with no sync time', () => {
    expect(syncPillFor(null, NOW)).toEqual({
      state: 'unknown',
      label: 'Not synced yet',
    })
    expect(Object.keys(syncPillFor(null, NOW)).sort()).toEqual([
      'label',
      'state',
    ])
  })

  it('is fresh up to the stale threshold and stale after it', () => {
    expect(syncPillFor(NOW - STALE_AFTER_MS, NOW).state).toBe('fresh')
    expect(syncPillFor(NOW - STALE_AFTER_MS - 1, NOW).state).toBe('stale')
  })

  it('treats two missed 15-minute syncs as stale', () => {
    expect(STALE_AFTER_MS).toBe(30 * MIN)
  })
})

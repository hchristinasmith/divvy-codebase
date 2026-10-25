import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../../apis/queryKeys.ts'
import {
  SERVER_STATUS_KEY,
  formatWhen,
  parseServerStatus,
} from '../serverStatus.ts'

// The Server card's reading of `GET /api/v1/sync/status`. Every timestamp
// is invented.

const LAST = '2026-10-25T02:41:00.000Z'
const NEXT = '2026-10-25T02:56:00.000Z'

describe('parseServerStatus', () => {
  it('accepts two timestamps and keeps them apart', () => {
    const status = parseServerStatus({ lastSuccessAt: LAST, nextRunAt: NEXT })
    expect(Object.keys(status).sort()).toEqual(['lastSuccessAt', 'nextRunAt'])
    expect(status).toEqual({ lastSuccessAt: LAST, nextRunAt: NEXT })
  })

  it('accepts null for both (never synced, scheduler stopped)', () => {
    const status = parseServerStatus({ lastSuccessAt: null, nextRunAt: null })
    expect(Object.keys(status).sort()).toEqual(['lastSuccessAt', 'nextRunAt'])
    expect(status).toEqual({ lastSuccessAt: null, nextRunAt: null })
  })

  it('keeps only the two fields it shows from the full SyncStatus body', () => {
    const status = parseServerStatus({
      running: false,
      lastRun: null,
      lastSuccessAt: LAST,
      nextRunAt: null,
    })
    expect(Object.keys(status).sort()).toEqual(['lastSuccessAt', 'nextRunAt'])
  })

  it.each([
    ['an empty object', {}],
    // Carries both keys, so only the array guard can refuse it.
    [
      'an array',
      Object.assign([LAST, NEXT], { lastSuccessAt: LAST, nextRunAt: NEXT }),
    ],
    ['null', null],
    ['a number', 42],
    ['a string', LAST],
    ['a body missing nextRunAt', { lastSuccessAt: LAST }],
    ['a body missing lastSuccessAt', { nextRunAt: NEXT }],
    [
      'an unparseable lastSuccessAt',
      { lastSuccessAt: 'soon', nextRunAt: NEXT },
    ],
    ['an unparseable nextRunAt', { lastSuccessAt: LAST, nextRunAt: 'later' }],
    [
      'a numeric lastSuccessAt',
      { lastSuccessAt: 1761360060000, nextRunAt: null },
    ],
    ['an undefined nextRunAt', { lastSuccessAt: LAST, nextRunAt: undefined }],
  ])('refuses %s', (_name, body) => {
    expect(() => parseServerStatus(body)).toThrow(/^sync status: /)
  })
})

describe('SERVER_STATUS_KEY', () => {
  it('sits under the sync-status prefix but is not the pill’s own key', () => {
    expect(SERVER_STATUS_KEY.slice(0, queryKeys.syncStatus.all.length)).toEqual(
      [...queryKeys.syncStatus.all],
    )
    expect(SERVER_STATUS_KEY.length).toBeGreaterThan(
      queryKeys.syncStatus.all.length,
    )
  })
})

describe('formatWhen', () => {
  it('formats as an absolute en-NZ date and time', () => {
    expect(formatWhen(LAST)).toBe(
      new Intl.DateTimeFormat('en-NZ', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(Date.parse(LAST)),
    )
    expect(formatWhen(LAST)).not.toBe(formatWhen(NEXT))
  })
})

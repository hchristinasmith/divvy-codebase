import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { grabSyncStatus } from '../../../apis/apiClient.ts'
import SyncPill from '../../Shell/SyncPill.tsx'
import { renderWithProviders } from '../../Shell/__tests__/renderWithProviders.tsx'
import LastSynced from '../LastSynced.tsx'
import type {
  SyncRunStatus,
  SyncStatus,
} from '../../../../server/routes/sync.ts'

// The Dashboard's "last synced" line (#32). The status comes from a mocked
// `grabSyncStatus`; the clock is fixed so relative times are exact. Every
// value is invented.

vi.mock('../../../apis/apiClient.ts', () => ({ grabSyncStatus: vi.fn() }))
const grab = vi.mocked(grabSyncStatus)

const NOW = Date.parse('2026-10-25T03:00:00.000Z')
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  grab.mockReset()
})

// Intl puts a narrow no-break space before "am"/"pm"; compare with every
// space flattened.
const flat = (text: string | null | undefined) =>
  (text ?? '').replace(/\s/g, ' ')

const absolute = (iso: string) =>
  flat(
    new Intl.DateTimeFormat('en-NZ', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(Date.parse(iso)),
  )

function line() {
  const el = document.querySelector('[data-last-synced]')
  if (!el) throw new Error('no last-synced element rendered')
  return el
}

async function settledState(state: string) {
  await waitFor(() =>
    expect(line().getAttribute('data-last-synced')).toBe(state),
  )
  return line()
}

function status(fields: Partial<SyncStatus>): SyncStatus {
  return {
    running: false,
    lastRun: null,
    lastSuccessAt: null,
    nextRunAt: null,
    ...fields,
  }
}

function run(fields: Partial<SyncRunStatus>): SyncRunStatus {
  return {
    id: 1,
    startedAt: minutesAgo(3),
    finishedAt: minutesAgo(2),
    outcome: 'success',
    counts: { inserted: 0, updated: 0, pendingMirrored: 0 },
    error: null,
    ...fields,
  }
}

describe('LastSynced', () => {
  it('while loading shows a neutral line, never "Never synced"', () => {
    grab.mockReturnValue(new Promise<SyncStatus>(() => {}))

    renderWithProviders(<LastSynced />)

    expect(line().getAttribute('data-last-synced')).toBe('loading')
    expect(line().textContent).not.toMatch(/Never synced/)
    expect(line().className).toContain('text-ink-muted')
  })

  it('shows "Never synced" when nothing has succeeded and nothing failed', async () => {
    grab.mockResolvedValue(status({ lastSuccessAt: null }))

    renderWithProviders(<LastSynced />)

    expect((await settledState('never')).textContent).toBe('Never synced')
  })

  it('shows how long ago and exactly when the last success was', async () => {
    const at = minutesAgo(5)
    grab.mockResolvedValue(
      status({ lastSuccessAt: at, lastRun: run({ finishedAt: at }) }),
    )

    renderWithProviders(<LastSynced />)

    const el = await settledState('synced')
    expect(flat(el.textContent)).toBe(`Synced 5 min ago · ${absolute(at)}`)
  })

  it('shows a failed last run as failed, with its error, beside the last success', async () => {
    const success = minutesAgo(40)
    const failure = minutesAgo(10)
    grab.mockResolvedValue(
      status({
        lastSuccessAt: success,
        lastRun: run({
          outcome: 'failed',
          finishedAt: failure,
          error: 'akahu_unauthorized (HTTP 401)',
        }),
      }),
    )

    renderWithProviders(<LastSynced />)

    const el = await settledState('failed')
    const danger = el.querySelector('.text-danger')
    expect(flat(danger?.textContent)).toBe(
      `Last sync failed at ${absolute(failure)} (akahu_unauthorized (HTTP 401))`,
    )
    // The failure carries no relative time; the success line does.
    expect(danger?.textContent).not.toMatch(/ago/)
    expect(flat(el.textContent)).toContain(
      `Synced 40 min ago · ${absolute(success)}`,
    )
  })

  it('shows a failure even when nothing has ever succeeded', async () => {
    const failure = minutesAgo(1)
    grab.mockResolvedValue(
      status({
        lastSuccessAt: null,
        lastRun: run({
          outcome: 'failed',
          finishedAt: failure,
          error: 'akahu_server (HTTP 500)',
        }),
      }),
    )

    renderWithProviders(<LastSynced />)

    const el = await settledState('failed')
    expect(el.textContent).not.toMatch(/Never synced/)
    expect(flat(el.querySelector('.text-danger')?.textContent)).toBe(
      `Last sync failed at ${absolute(failure)} (akahu_server (HTTP 500))`,
    )
  })

  it('does not show a run in progress as failed', async () => {
    const at = minutesAgo(20)
    grab.mockResolvedValue(
      status({
        running: true,
        lastSuccessAt: at,
        lastRun: run({
          outcome: 'running',
          startedAt: minutesAgo(0),
          finishedAt: null,
        }),
      }),
    )

    renderWithProviders(<LastSynced />)

    const el = await settledState('synced')
    expect(el.querySelector('.text-danger')).toBeNull()
    expect(flat(el.textContent)).toBe(`Synced 20 min ago · ${absolute(at)}`)
  })

  it('shows "Sync status unavailable" when the request fails', async () => {
    grab.mockRejectedValue(new Error('Internal Server Error'))

    renderWithProviders(<LastSynced />)

    expect((await settledState('error')).textContent).toBe(
      'Sync status unavailable',
    )
  })

  it.each([
    ['an empty object', {}],
    ['no lastSuccessAt', { running: false, lastRun: null }],
    [
      'an unparseable lastSuccessAt',
      { running: false, lastSuccessAt: 'yesterday' },
    ],
    // superagent gives a non-JSON response a null body.
    ['an HTML page', null],
  ])(
    'treats a 200 with %s as an error, not "Never synced"',
    async (_why, body) => {
      grab.mockResolvedValue(body as unknown as SyncStatus)

      renderWithProviders(<LastSynced />)

      expect((await settledState('error')).textContent).toBe(
        'Sync status unavailable',
      )
    },
  )

  it('shares a query client with the header pill without either overwriting the other', async () => {
    // The pill reads /sync/status through fetch and caches a timestamp; this
    // line reads the whole body through the API client.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ running: false, lastSuccessAt: minutesAgo(5) }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
      ),
    )
    const failure = minutesAgo(1)
    grab.mockResolvedValue(
      status({
        lastSuccessAt: minutesAgo(5),
        lastRun: run({
          outcome: 'failed',
          finishedAt: failure,
          error: 'akahu_timeout',
        }),
      }),
    )

    renderWithProviders(
      <>
        <SyncPill />
        <LastSynced />
      </>,
    )

    const el = await settledState('failed')
    expect(flat(el.querySelector('.text-danger')?.textContent)).toBe(
      `Last sync failed at ${absolute(failure)} (akahu_timeout)`,
    )
    await waitFor(() =>
      expect(document.querySelector('[data-sync-state]')?.textContent).toBe(
        'Synced 5 min ago',
      ),
    )
  })
})

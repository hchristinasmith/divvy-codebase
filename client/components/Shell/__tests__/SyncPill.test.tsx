import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { queryKeys } from '../../../apis/queryKeys.ts'
import SyncPill from '../SyncPill.tsx'
import { pendingFetch, renderWithProviders } from './renderWithProviders.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    void input
    return impl()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )

function pill() {
  const el = document.querySelector('[data-sync-state]')
  if (!el) throw new Error('no sync pill rendered')
  return el
}

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString()

describe('the sync pill', () => {
  it('asks /api/v1/sync/status', async () => {
    const fetchMock = stubFetch(json({ lastSuccessAt: null }))
    renderWithProviders(<SyncPill />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/api\/v1\/sync\/status$/,
    )
  })

  it('is neutral while the status is loading', () => {
    stubFetch(pendingFetch)
    renderWithProviders(<SyncPill />)
    expect(pill().getAttribute('data-sync-state')).toBe('unknown')
    expect(pill().textContent).toBe('Not synced yet')
    // A grey dot: a neutral pill must not look healthy.
    expect(pill().querySelector('.bg-ink-faint')).not.toBeNull()
    expect(pill().querySelector('.bg-ok, .bg-warn')).toBeNull()
  })

  it.each([
    ['the route does not exist yet', json({ error: 'Not found' }, 404)],
    ['the server fails', json({ error: 'boom' }, 500)],
    [
      'the server fails but the body still carries a time',
      json({ lastSuccessAt: new Date().toISOString() }, 500),
    ],
    ['the network fails', () => Promise.reject(new TypeError('offline'))],
    [
      'the body is not JSON',
      () => Promise.resolve(new Response('<html>', { status: 200 })),
    ],
    ['nothing has synced yet', json({ running: false, lastSuccessAt: null })],
    ['the body has no lastSuccessAt', json({})],
    ['lastSuccessAt is not a date', json({ lastSuccessAt: 'yesterday' })],
    [
      'lastSuccessAt is in the future',
      json({ lastSuccessAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ],
  ])('shows "Not synced yet" when %s', async (_why, impl) => {
    const fetchMock = stubFetch(impl)
    renderWithProviders(<SyncPill />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Let the query settle before asserting it stayed neutral.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pill().getAttribute('data-sync-state')).toBe('unknown')
    expect(pill().textContent).toBe('Not synced yet')
  })

  it('shows how long ago the last successful sync was', async () => {
    stubFetch(
      json({
        running: false,
        lastRun: null,
        lastSuccessAt: minutesAgo(4),
        nextRunAt: null,
      }),
    )
    renderWithProviders(<SyncPill />)
    await waitFor(() => expect(pill().textContent).toBe('Synced 4 min ago'))
    expect(pill().getAttribute('data-sync-state')).toBe('fresh')
    expect(pill().querySelector('.bg-ok')).not.toBeNull()
  })

  it('turns amber when the last sync is stale', async () => {
    stubFetch(json({ lastSuccessAt: minutesAgo(120) }))
    renderWithProviders(<SyncPill />)
    await waitFor(() => expect(pill().textContent).toBe('Synced 2 h ago'))
    expect(pill().getAttribute('data-sync-state')).toBe('stale')
    expect(pill().querySelector('.bg-warn')).not.toBeNull()
  })

  it('ages a freshly fetched time against the clock now, not the last tick', async () => {
    // The pill's own clock ticks once a minute. A fetch landing between
    // ticks must still be judged against the time it arrived, or a stale
    // sync reads fresh until the next tick.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.parse('2026-10-23T09:00:00.000Z')
      vi.setSystemTime(start)
      let reply: (r: Response) => void = () => {}
      stubFetch(() => new Promise<Response>((resolve) => (reply = resolve)))
      renderWithProviders(<SyncPill />)

      vi.setSystemTime(start + 50_000)
      // 30 min 30 s before the moment the reply arrives: stale.
      const lastSuccessAt = new Date(start + 50_000 - 30 * 60_000 - 30_000)
      reply(
        new Response(
          JSON.stringify({ lastSuccessAt: lastSuccessAt.toISOString() }),
        ),
      )
      await waitFor(() =>
        expect(pill().getAttribute('data-sync-state')).toBe('stale'),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('caches the status under the shared syncStatus key', async () => {
    stubFetch(json({ lastSuccessAt: minutesAgo(4) }))
    const { client } = renderWithProviders(<SyncPill />)
    await waitFor(() => expect(pill().textContent).toBe('Synced 4 min ago'))
    expect(client.getQueryData(queryKeys.syncStatus.all)).toBeTypeOf('number')
  })

  it('keeps the age moving and asks again every minute', async () => {
    // Real setTimeout so waitFor still polls; the minute timers are fake.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      const start = Date.parse('2026-10-23T09:00:00.000Z')
      vi.setSystemTime(start)
      const first = json({
        lastSuccessAt: new Date(start - 4 * 60_000).toISOString(),
      })
      // Only the first request answers, so the age can move only by the
      // pill's own clock, not by a fresh reply.
      const fetchMock = stubFetch(() =>
        fetchMock.mock.calls.length === 1 ? first() : pendingFetch(),
      )
      renderWithProviders(<SyncPill />)
      await waitFor(() => expect(pill().textContent).toBe('Synced 4 min ago'))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      await waitFor(() => expect(pill().textContent).toBe('Synced 5 min ago'))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a status, not a way to reach Sync (#33 is open)', () => {
    stubFetch(pendingFetch)
    renderWithProviders(<SyncPill />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  pendingFetch,
  renderWithProviders,
} from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { queryKeys } from '../../../apis/queryKeys.ts'
import ServerCard from '../ServerCard.tsx'
import { SERVER_STATUS_KEY } from '../serverStatus.ts'

// The Privacy screen's Server card (issue Done-when 2): only values the app
// can report, from `GET /api/v1/sync/status`, through a stubbed `fetch`.
// Every timestamp is invented.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LAST = '2026-10-25T02:41:00.000Z'
const NEXT = '2026-10-25T02:56:00.000Z'

// Intl puts a narrow no-break space before "am"/"pm"; compare with every
// space flattened, as the Dashboard's LastSynced test does.
const flat = (text: string | null | undefined) =>
  (text ?? '').replace(/\s/g, ' ')

const absolute = (iso: string) =>
  flat(
    new Intl.DateTimeFormat('en-NZ', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(Date.parse(iso)),
  )

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function card(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="server-card"]')
  if (!el) throw new Error('no server card rendered')
  return el
}

async function settled(state: 'ready' | 'error') {
  await waitFor(() =>
    expect(card().getAttribute('data-server-state')).toBe(state),
  )
  return card()
}

function rowValue(label: string): string {
  const dt = [...card().querySelectorAll('dt')].find(
    (el) => el.textContent === label,
  )
  if (!dt) throw new Error(`no row labelled ${label}`)
  const dd = dt.parentElement?.querySelector('dd')
  if (!dd) throw new Error(`row ${label} has no value`)
  return flat(dd.textContent)
}

describe('the Server card', () => {
  it('says it is checking while the request is in flight', () => {
    stubFetch(pendingFetch)
    renderWithProviders(<ServerCard />)
    expect(card().getAttribute('data-server-state')).toBe('loading')
    expect(rowValue('Last successful sync')).toBe('Checking…')
    expect(rowValue('Next sync')).toBe('Checking…')
    expect(card().textContent).not.toMatch(/Never synced|Unavailable/)
  })

  it('puts the last success and the next run in their own rows', async () => {
    stubFetch(async () =>
      json({
        running: false,
        lastRun: null,
        lastSuccessAt: LAST,
        nextRunAt: NEXT,
      }),
    )
    renderWithProviders(<ServerCard />)
    await settled('ready')
    expect(absolute(LAST)).not.toBe(absolute(NEXT))
    expect(rowValue('Last successful sync')).toBe(absolute(LAST))
    expect(rowValue('Next sync')).toBe(absolute(NEXT))
  })

  it('says never synced and not scheduled when the server sends nulls', async () => {
    stubFetch(async () =>
      json({
        running: false,
        lastRun: null,
        lastSuccessAt: null,
        nextRunAt: null,
      }),
    )
    renderWithProviders(<ServerCard />)
    await settled('ready')
    expect(rowValue('Last successful sync')).toBe('Never synced')
    expect(rowValue('Next sync')).toBe('Not scheduled')
  })

  it.each([
    ['the request is refused', () => Promise.reject(new TypeError('offline'))],
    // A well-formed body on a 500, so only the status check can refuse it.
    [
      'the server answers 500',
      async () => json({ lastSuccessAt: LAST, nextRunAt: NEXT }, 500),
    ],
    ['the body is an empty object', async () => json({})],
    [
      'a timestamp does not parse',
      async () => json({ lastSuccessAt: 'yesterday', nextRunAt: null }),
    ],
  ])('says unavailable, never "Never synced", when %s', async (_name, impl) => {
    stubFetch(impl)
    renderWithProviders(<ServerCard />)
    await settled('error')
    expect(rowValue('Last successful sync')).toBe('Unavailable')
    expect(rowValue('Next sync')).toBe('Unavailable')
    expect(card().textContent).not.toMatch(/Never synced|Not scheduled/)
  })

  it('keeps the values it read when a later refetch fails', async () => {
    const fetchMock = stubFetch(async () =>
      json({ lastSuccessAt: LAST, nextRunAt: NEXT }),
    )
    const { client } = renderWithProviders(<ServerCard />)
    await settled('ready')

    fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')))
    await act(async () => {
      await client.refetchQueries({ queryKey: SERVER_STATUS_KEY })
      // TanStack notifies observers on a later tick; let the card re-render
      // with the failed refetch before asserting it kept its values.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(client.getQueryState(SERVER_STATUS_KEY)?.status).toBe('error')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    expect(card().getAttribute('data-server-state')).toBe('ready')
    expect(rowValue('Last successful sync')).toBe(absolute(LAST))
    expect(rowValue('Next sync')).toBe(absolute(NEXT))
  })

  it('makes exactly one GET, to the same-origin sync status route', async () => {
    const fetchMock = stubFetch(async () =>
      json({ lastSuccessAt: LAST, nextRunAt: NEXT }),
    )
    renderWithProviders(<ServerCard />)
    await settled('ready')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      URL | string,
      RequestInit | undefined,
    ]
    const url = new URL(String(input), document.baseURI)
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/v1/sync/status')
    expect(url.search).toBe('')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('shows nothing it cannot back: no host, uptime, backup or outbound line', async () => {
    stubFetch(async () => json({ lastSuccessAt: LAST, nextRunAt: NEXT }))
    renderWithProviders(<ServerCard />)
    await settled('ready')
    const text = card().textContent ?? ''
    expect(text).not.toMatch(/host|uptime|backup|outbound/i)
    expect(text).not.toContain(window.location.hostname)
    expect(
      [...card().querySelectorAll('dt')].map((el) => el.textContent),
    ).toEqual(['Last successful sync', 'Next sync'])
  })

  it('caches under its own key and leaves the sync pill’s entry alone', async () => {
    stubFetch(async () => json({ lastSuccessAt: LAST, nextRunAt: null }))
    const { client } = renderWithProviders(<ServerCard />, {})
    // The pill caches a parsed epoch number at the bare prefix.
    const pillValue = Date.parse(LAST)
    client.setQueryData(queryKeys.syncStatus.all, pillValue)
    await settled('ready')

    expect(client.getQueryData(queryKeys.syncStatus.all)).toBe(pillValue)
    const own = client.getQueryData(SERVER_STATUS_KEY) as Record<
      string,
      unknown
    >
    expect(Object.keys(own).sort()).toEqual(['lastSuccessAt', 'nextRunAt'])
    expect(own).toEqual({ lastSuccessAt: LAST, nextRunAt: null })
  })
})

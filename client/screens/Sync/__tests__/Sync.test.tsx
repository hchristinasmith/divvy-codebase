import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { ScopeProvider } from '../../../context/ScopeContext.tsx'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { SYNC_NOW_ERROR } from '../../../apis/sync.ts'
import { queryKeys } from '../../../apis/queryKeys.ts'
import Sync from '../index.tsx'
import {
  ACCOUNTS_BODY,
  SENTINEL,
  accountItem,
  installFetch,
  minutesBefore,
  run,
  statusBody,
  type Handler,
  type Handlers,
  type Reply,
} from './fixtures.ts'

// The Sync screen (prd-02 issue 59), one describe per Done-when line. The
// requests go through the real client/apis/sync.ts to a routing fetch stub
// (./fixtures.ts); the header pill's status read reaches the same stub.
// Timer tests fake only Date and the interval timers, so waitFor still
// polls on real timeouts. Every name is invented.

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const START = Date.parse('2026-10-26T09:00:00.000Z')

const json =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body })

function setup(handlers: Handlers) {
  const fx = installFetch(handlers)
  const view = renderWithProviders(<Sync />, { path: '/sync' })
  return { fx, ...view }
}

function main(): HTMLElement {
  return document.body
}

function rows(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Bank connections' })
  return list ? within(list).queryAllByRole('listitem') : []
}

async function findRows(): Promise<HTMLElement[]> {
  const list = await screen.findByRole('list', { name: 'Bank connections' })
  return within(list).getAllByRole('listitem')
}

function dot(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>('[data-sync-state]')
  if (!el) throw new Error('row has no status dot')
  return el
}

function time(row: HTMLElement): string {
  return row.querySelector('[data-sync-time]')?.textContent ?? ''
}

function pillLabel(): string {
  return document.querySelector('header [data-sync-state]')?.textContent ?? ''
}

function syncButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Sync now|Syncing…)$/ })
}

function useClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(START)
}

const statusCalls = (fx: ReturnType<typeof installFetch>) =>
  fx.callsTo('GET', '/api/v1/sync/status').length

describe('loading, empty and error states (Done-when 6)', () => {
  it('shows a loading status, and no rows or button, until both reads arrive', async () => {
    // Accounts answer, status never does: fails if rows render without a
    // status.
    setup({ accounts: json(ACCOUNTS_BODY) })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Loading sync status…'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByRole('status').textContent).toBe('Loading sync status…')
    expect(rows()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
  })

  it('shows one "No bank accounts yet" row that still carries the status, and the button', async () => {
    // Fails if an empty list leaves a blank card or drops "Sync now".
    setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json({ success: true, items: [] }),
    })
    const [only, ...rest] = await findRows()
    expect(rest).toEqual([])
    expect(only.textContent).toContain('No bank accounts yet')
    expect(dot(only).getAttribute('data-sync-state')).toBe('fresh')
    expect(time(only)).toBe('4 min ago')
    expect(syncButton().textContent).toBe('Sync now')
  })

  it.each([
    ['status', 'Could not read sync status'],
    ['accounts', 'Could not read accounts'],
  ] as const)(
    'shows the %s read failing, and "Try again" asks both again',
    async (which, message) => {
      const ok: Handlers = {
        status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
        accounts: json(ACCOUNTS_BODY),
      }
      const { fx } = setup({ ...ok, [which]: json({ error: message }, 500) })

      // Fails if a failed read is silent or leaves a blank screen.
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain(message)
      expect(rows()).toEqual([])

      const before = fx.calls.length
      fx.handlers[which] = ok[which]
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
      expect(await findRows()).toHaveLength(2)
      // Fails if Try again refetches only one of the two reads.
      const again = fx.calls.slice(before).map((c) => c.url.pathname)
      expect(again).toContain('/api/v1/sync/status')
      expect(again).toContain('/api/v1/accounts')
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it('keeps the last rows with a banner when a later read fails', async () => {
    useClock()
    const { fx } = setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(START, 4) })),
      accounts: json(ACCOUNTS_BODY),
    })
    await findRows()
    fx.handlers.status = json({ error: 'Could not read sync status' }, 500)

    // The screen's own minute poll fails.
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    const banner = await screen.findByRole('alert')
    // Fails if a failed refresh blanks the rows or hides the failure.
    expect(banner.textContent).toContain("Couldn't refresh. Showing the last status.")
    expect(rows()).toHaveLength(2)
    expect(time(rows()[0])).toBe('5 min ago')
  })
})

describe('rows come from the server status (Done-when 1)', () => {
  it('gives one row per bank with its account names, and nothing it must not show', async () => {
    setup({
      status: json(
        statusBody({
          lastSuccessAt: minutesBefore(Date.now(), 4),
          lastRun: run('success', minutesBefore(Date.now(), 5), minutesBefore(Date.now(), 4)),
        }),
      ),
      accounts: json(ACCOUNTS_BODY),
    })
    const [first, second, ...rest] = await findRows()
    expect(rest).toEqual([])
    // Fails if rows are per account, sorted, or lose their account names.
    expect(first.textContent).toContain('Test Bank')
    expect(first.textContent).toContain('Sample Everyday, Sample Savings')
    expect(second.textContent).toContain('Other Test Bank')
    expect(second.textContent).toContain('Sample Business')

    const text = main().textContent ?? ''
    // Fails if an id, account number, logo, balance or the run's error code
    // is rendered.
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain('98765')
    expect(text).not.toContain('87654')
  })

  it('shows the same status on every row: the status is global', async () => {
    setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 45) })),
      accounts: json(ACCOUNTS_BODY),
    })
    const all = await findRows()
    // Fails if one row computes its own state or time.
    expect(new Set(all.map((r) => dot(r).getAttribute('data-sync-state')))).toEqual(
      new Set(['stale']),
    )
    expect(new Set(all.map(time))).toEqual(new Set(['45 min ago']))
  })

  it.each([
    {
      why: 'fresh',
      body: () => statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) }),
      state: 'fresh',
      colour: 'bg-ok',
      label: 'Up to date',
      when: '4 min ago',
      lead: null,
    },
    {
      why: 'stale',
      body: () => statusBody({ lastSuccessAt: minutesBefore(Date.now(), 120) }),
      state: 'stale',
      colour: 'bg-warn',
      label: 'Out of date',
      when: '2 h ago',
      lead: null,
    },
    {
      why: 'failed',
      body: () =>
        statusBody({
          lastSuccessAt: minutesBefore(Date.now(), 120),
          lastRun: run('failed', minutesBefore(Date.now(), 11), minutesBefore(Date.now(), 10)),
        }),
      state: 'failed',
      colour: 'bg-danger',
      label: 'Last sync failed',
      when: '10 min ago',
      lead: 'Last sync failed',
    },
    {
      why: 'never synced',
      body: () => statusBody(),
      state: 'never',
      colour: 'bg-ink-faint',
      label: 'Not synced yet',
      when: '',
      lead: 'Not synced yet',
    },
    {
      why: 'running',
      body: () =>
        statusBody({
          running: true,
          lastSuccessAt: minutesBefore(Date.now(), 4),
          lastRun: run('running', minutesBefore(Date.now(), 0), null),
        }),
      state: 'running',
      colour: 'bg-ok',
      label: 'Syncing',
      when: '4 min ago',
      lead: 'Syncing…',
    },
    {
      why: 'a leftover running row from a dead process',
      body: () =>
        statusBody({
          running: false,
          lastSuccessAt: minutesBefore(Date.now(), 4),
          lastRun: run('running', minutesBefore(Date.now(), 25), null),
        }),
      state: 'fresh',
      colour: 'bg-ok',
      label: 'Up to date',
      when: '4 min ago',
      lead: null,
    },
  ])('draws $why', async ({ body, state, colour, label, when, lead }) => {
    setup({ status: json(body()), accounts: json(ACCOUNTS_BODY) })
    const [row] = await findRows()
    const d = dot(row)
    // Fails if the state, the dot colour or its accessible name is wrong.
    expect(d.getAttribute('data-sync-state')).toBe(state)
    expect(d.getAttribute('role')).toBe('img')
    expect(d.getAttribute('aria-label')).toBe(label)
    expect(d.classList.contains(colour)).toBe(true)
    expect(
      ['bg-ok', 'bg-warn', 'bg-danger', 'bg-ink-faint'].filter((c) =>
        d.classList.contains(c),
      ),
    ).toEqual([colour])
    // Fails if the row shows a time the server did not report.
    expect(time(row)).toBe(when)
    if (lead === null) {
      expect(row.textContent).not.toMatch(/Syncing…|Last sync failed|Not synced yet/)
    } else {
      expect(row.textContent).toContain(`${lead} · Sample Everyday`)
    }
    expect(main().textContent).not.toContain(SENTINEL)
  })

  it('sets the time in DM Mono', async () => {
    setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json(ACCOUNTS_BODY),
    })
    const [row] = await findRows()
    // Fails if the time loses the mono role or its 12px size.
    const el = row.querySelector('[data-sync-time]')
    expect(el?.classList.contains('font-mono')).toBe(true)
    expect(el?.classList.contains('text-body-12')).toBe(true)
    // Fails if a long account list can push the time onto two lines or
    // the name column can grow past the card.
    expect(el?.classList.contains('whitespace-nowrap')).toBe(true)
    expect(row.classList.contains('grid-cols-[minmax(0,1fr)_auto]')).toBe(true)
  })

  it('titles a bank with no connection by its account name', async () => {
    setup({
      status: json(statusBody()),
      accounts: json({
        success: true,
        items: [accountItem('Sample Cash', undefined, 4), accountItem('Sample Card', null, 5)],
      }),
    })
    const all = await findRows()
    // Fails if connection-less accounts vanish or merge.
    expect(all.map((r) => r.querySelector('.text-body-15')?.textContent)).toEqual([
      'Sample Cash',
      'Sample Card',
    ])
  })

  it('ages "4 min ago" to "5 min ago" on the minute tick, with no new reply', async () => {
    useClock()
    let answered = 0
    setup({
      // Only the first reads answer (the pill's and the screen's), so the
      // age can move only by the screen's own clock.
      status: () => {
        if (answered === 2) return 'pending'
        answered += 1
        return { body: statusBody({ lastSuccessAt: minutesBefore(START, 4) }) }
      },
      accounts: json(ACCOUNTS_BODY),
    })
    const [row] = await findRows()
    expect(time(row)).toBe('4 min ago')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    // Fails if the rows age only when a reply lands.
    await waitFor(() => expect(time(rows()[0])).toBe('5 min ago'))
  })

  it('ages a reply that lands after a missed tick from its arrival, not from the old tick', async () => {
    useClock()
    const { fx, client } = setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(START, 4) })),
      accounts: json(ACCOUNTS_BODY),
    })
    const [row] = await findRows()
    expect(time(row)).toBe('4 min ago')

    // The machine sleeps for three hours: the clock moves, no tick fires.
    const woke = START + 180 * 60_000
    vi.setSystemTime(woke)
    fx.handlers.status = json(statusBody({ lastSuccessAt: minutesBefore(woke, 10) }))
    await act(() => client.invalidateQueries({ queryKey: queryKeys.syncStatus.all }))
    // Fails if the reply is aged against the tick from before the sleep,
    // which puts the success in the future and reads "just now".
    await waitFor(() => expect(time(rows()[0])).toBe('10 min ago'))
  })
})

describe('Sync now calls the trigger and shows its progress (Done-when 2)', () => {
  it('sends exactly one POST with no body, even on a double press', async () => {
    const { fx } = setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json(ACCOUNTS_BODY),
      run: () => 'pending',
    })
    await findRows()
    const button = syncButton()
    fireEvent.click(button)
    fireEvent.click(button)

    // Fails if the button animates without calling the server, or a fast
    // second press, before the button re-renders disabled, starts a second
    // POST.
    await waitFor(() => expect(fx.callsTo('POST', '/api/v1/sync/run')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const posts = fx.callsTo('POST', '/api/v1/sync/run')
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toBeUndefined()
    await waitFor(() => expect(syncButton().disabled).toBe(true))
    fireEvent.click(syncButton())
    expect(fx.callsTo('POST', '/api/v1/sync/run')).toHaveLength(1)
  })

  it('does not poll at 2 s while idle, even with a leftover running row', async () => {
    useClock()
    const { fx } = setup({
      status: json(
        statusBody({
          running: false,
          lastSuccessAt: minutesBefore(START, 4),
          lastRun: run('running', minutesBefore(START, 25), null),
        }),
      ),
      accounts: json(ACCOUNTS_BODY),
    })
    await findRows()
    const before = statusCalls(fx)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Fails if the fast poll keys on anything but `running`.
    expect(statusCalls(fx)).toBe(before)
  })

  it.each([
    ['202 started', 202, { started: true }],
    ['409 already running', 409, { started: false, reason: 'already running' }],
  ])(
    'after %s: spins and polls every 2 s until the server says it stopped, then shows the server time',
    async (_why, code, answer) => {
      useClock()
      const { fx } = setup({
        status: json(statusBody({ lastSuccessAt: minutesBefore(START, 40) })),
        accounts: json(ACCOUNTS_BODY),
        run: json(answer, code),
      })
      await findRows()
      fx.handlers.status = json(
        statusBody({
          running: true,
          lastSuccessAt: minutesBefore(START, 40),
          lastRun: run('running', new Date(START).toISOString(), null),
        }),
      )
      fireEvent.click(syncButton())

      await waitFor(() => expect(rows()[0].textContent).toContain('Syncing…'))
      // Fails if a 409 is shown as an error, or the spinner is missing.
      expect(screen.queryByRole('alert')).toBeNull()
      expect(syncButton().textContent).toBe('Syncing…')
      expect(syncButton().disabled).toBe(true)
      expect(syncButton().getAttribute('aria-busy')).toBe('true')
      expect(syncButton().querySelector('[data-spinner]')).not.toBeNull()
      // No optimistic "just now": the row keeps the last server time.
      expect(time(rows()[0])).toBe('40 min ago')

      // Fails if the screen does not poll fast while running.
      const before = statusCalls(fx)
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      await waitFor(() => expect(statusCalls(fx)).toBe(before + 1))
      expect(syncButton().textContent).toBe('Syncing…')

      // The run finishes three minutes after it started, by the server's
      // record; the client's clock is START + 4 s.
      fx.handlers.status = json(
        statusBody({
          running: false,
          lastSuccessAt: minutesBefore(START, 3),
          lastRun: run('success', minutesBefore(START, 4), minutesBefore(START, 3)),
        }),
      )
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      // Fails if the spinner stops before the server says so, or the row
      // shows anything but the server's time.
      await waitFor(() => expect(syncButton().textContent).toBe('Sync now'))
      expect(syncButton().querySelector('[data-spinner]')).toBeNull()
      expect(syncButton().disabled).toBe(false)
      expect(time(rows()[0])).toBe('3 min ago')
      expect(main().textContent).not.toContain('just now')
    },
  )

  it('changes no row while the press is in flight', async () => {
    const { fx } = setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 40) })),
      accounts: json(ACCOUNTS_BODY),
    })
    await findRows()
    fx.handlers.run = json({ started: true }, 202)
    fx.handlers.status = () => 'pending'
    fireEvent.click(syncButton())

    await waitFor(() => expect(fx.callsTo('POST', '/api/v1/sync/run')).toHaveLength(1))
    await waitFor(() => expect(syncButton().textContent).toBe('Syncing…'))
    // Fails if the screen claims a fresh sync before the server reports one.
    expect(time(rows()[0])).toBe('40 min ago')
    expect(main().textContent).not.toContain('just now')
  })

  it.each([
    ['a 403', json({ error: 'Forbidden SENTINEL' }, 403)],
    ['a 500', json({ error: 'boom SENTINEL' }, 500)],
    ['an unreachable server', (() => 'reject') as Handler],
  ])('shows one fixed message on %s, and the next press clears it', async (_why, refusal) => {
    const { fx } = setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json(ACCOUNTS_BODY),
      run: refusal,
    })
    await findRows()
    fireEvent.click(syncButton())

    const alert = await screen.findByRole('alert')
    // Fails if a failure is silent, or the server's text is shown.
    expect(alert.textContent).toBe(SYNC_NOW_ERROR)
    expect(main().textContent).not.toContain(SENTINEL)
    await waitFor(() => expect(syncButton().textContent).toBe('Sync now'))

    fx.handlers.run = () => 'pending'
    fireEvent.click(syncButton())
    // Fails if an old failure stays up under a new press.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(fx.callsTo('POST', '/api/v1/sync/run')).toHaveLength(2)
  })
})

describe('a press outlives leaving the screen', () => {
  // The same client and providers as renderWithProviders, so the screen can
  // be left and opened again with the mutation cache intact.
  function tree(client: QueryClient, ui: ReactNode) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/sync']}>
          <ScopeProvider>{ui}</ScopeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  it('shows busy on return while the press is in flight, then its failure', async () => {
    let settle: (answer: Reply) => void = () => {}
    const { fx, client, rerender } = setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json(ACCOUNTS_BODY),
      run: () =>
        new Promise<Reply>((resolve) => {
          settle = resolve
        }),
    })
    await findRows()
    fireEvent.click(syncButton())
    await waitFor(() => expect(syncButton().disabled).toBe(true))

    rerender(tree(client, <p>Elsewhere</p>))
    expect(screen.queryByRole('button')).toBeNull()
    rerender(tree(client, <Sync />))
    await findRows()
    // Fails if the returning screen offers an enabled "Sync now" whose press
    // the in-flight guard would silently drop.
    expect(syncButton().textContent).toBe('Syncing…')
    expect(syncButton().disabled).toBe(true)
    fireEvent.click(syncButton())
    expect(fx.callsTo('POST', '/api/v1/sync/run')).toHaveLength(1)

    act(() => settle({ status: 500, body: { error: 'boom SENTINEL' } }))
    // Fails if the press's failure is lost with the observer that made it.
    expect((await screen.findByRole('alert')).textContent).toBe(SYNC_NOW_ERROR)
    expect(syncButton().disabled).toBe(false)
  })

  it('gives the pink button a visible focus offset and no hover while disabled', async () => {
    setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json(ACCOUNTS_BODY),
    })
    await findRows()
    const classes = syncButton().classList
    // Fails if the outline sits flush on the pink, or a disabled button
    // still darkens on hover.
    expect(classes.contains('focus-visible:outline-offset-2')).toBe(true)
    expect(classes.contains('enabled:hover:bg-pink-hover')).toBe(true)
    expect(classes.contains('hover:bg-pink-hover')).toBe(false)
  })
})

describe('no Xero (Done-when 3, prd-02 Ruling 4)', () => {
  it('names banks only, in the header, rows and footer', async () => {
    setup({
      status: json(statusBody({ lastSuccessAt: minutesBefore(Date.now(), 4) })),
      accounts: json(ACCOUNTS_BODY),
    })
    await findRows()
    const text = main().textContent ?? ''
    // Fails if a Xero row, list or footer half comes back.
    expect(text).not.toMatch(/xero/i)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sync')
    expect(text).toContain('Banks')
    expect(text).toContain('Auto-sync every 15 min. Banks via read-only Open Banking.')
  })
})

describe('the header pill and the rows agree (Done-when 4)', () => {
  it('moves the pill with the screen fast poll, before the pill own minute', async () => {
    useClock()
    const { fx } = setup({
      status: json(
        statusBody({
          running: true,
          lastSuccessAt: minutesBefore(START, 10),
          lastRun: run('running', new Date(START).toISOString(), null),
        }),
      ),
      accounts: json(ACCOUNTS_BODY),
    })
    await findRows()
    await waitFor(() => expect(pillLabel()).toBe('Synced 10 min ago'))
    expect(pillLabel()).toBe(`Synced ${time(rows()[0])}`)

    fx.handlers.status = json(
      statusBody({ running: false, lastSuccessAt: minutesBefore(START, 2) }),
    )
    // Two seconds: only the screen's running poll is due, not the pill's
    // own minute read. Fails if the screen's reply is not written into the
    // pill's entry.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    await waitFor(() => expect(time(rows()[0])).toBe('2 min ago'))
    await waitFor(() => expect(pillLabel()).toBe('Synced 2 min ago'))
    expect(pillLabel()).toBe(`Synced ${time(rows()[0])}`)
  })
})

beforeEach(() => {
  // A leftover clock from a failed timer test would skew every age.
  vi.useRealTimers()
})

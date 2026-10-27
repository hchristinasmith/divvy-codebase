import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { overviewQuery } from '../../../apis/overview.ts'
import type { HabitsResponse, Scope } from '../../../../shared/contracts.ts'
import Habits from '../index.tsx'
import PatternsCard from '../PatternsCard.tsx'
import {
  habitsResponse,
  installFetch,
  streak,
  verdictRow,
  verdictServer,
  type Handler,
} from './fixtures.ts'

// The Habits screen (prd-02, issue 57). Every habits request goes through
// the real client/apis/habits.ts to a routing fetch stub (./fixtures.ts).
// The sync pill's fetch never settles. Every value is invented, in integer
// cents.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const LIST = '/api/v1/habits'
const OVERVIEW = '/api/v1/overview'
const verdictPath = (id: string) => `/api/v1/habits/verdicts/${id}`

const GROCER = verdictRow()
const SUPPLIER = verdictRow({
  transactionId: '201',
  date: '2026-10-21',
  merchant: 'EXAMPLE SUPPLIER',
  category: null,
  amountCents: -64000,
  verdict: 'worth_it',
})
const CAFE = verdictRow({
  transactionId: '305',
  date: '2026-10-25',
  merchant: 'Example Cafe',
  category: 'Eating out',
  amountCents: -940,
  verdict: 'not_really',
})

const THREE = habitsResponse({ verdicts: [CAFE, SUPPLIER, GROCER] })

// Reads the overview through its one query definition, as the Overview
// screen does, so a test can see whether it refetches.
function OverviewProbe() {
  useQuery(overviewQuery('all'))
  return null
}

function setup(
  body: HabitsResponse | Handler,
  {
    scope = 'all',
    verdict,
    probe = false,
  }: { scope?: Scope; verdict?: Handler; probe?: boolean } = {},
) {
  const fx = installFetch({
    list: typeof body === 'function' ? body : () => ({ body }),
    verdict,
    overview: () => ({ body: {} }),
  })
  const view = renderWithProviders(
    <>
      <Habits />
      {probe && <OverviewProbe />}
    </>,
    { initialScope: scope },
  )
  return { fx, ...view }
}

async function loaded(): Promise<void> {
  await screen.findByRole('region', { name: 'Worth it?' })
}

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

/** The Worth it? row for one spend. */
function row(id: string): HTMLElement {
  const li = card('Worth it?').querySelector<HTMLElement>(`[data-transaction-id="${id}"]`)
  if (!li) throw new Error(`no row ${id}`)
  return li
}

function pill(id: string, label: 'Worth it' | 'Not really'): HTMLButtonElement {
  return within(row(id)).getByRole('button', { name: label }) as HTMLButtonElement
}

function pressed(id: string): string[] {
  return within(row(id))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent ?? '')
}

function summary(): string {
  return screen.getByTestId('verdict-summary').textContent ?? ''
}

describe('loading and failure', () => {
  it('shows a loading card until the habits arrive', () => {
    setup(() => undefined)

    expect(screen.getByRole('status').textContent).toBe('Loading your habits…')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Habits')
    expect(screen.getByText('An honest mirror · last 90 days')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Runway' })).toBeNull()
  })

  it("shows the server's message and a retry when the read fails", async () => {
    const { fx } = setup(() => ({
      status: 500,
      body: { error: 'Could not read habits' },
    }))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Could not read habits')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Runway' })).toBeNull()

    fx.handlers.list = () => ({ body: THREE })
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
  })

  it('says so when the server cannot be reached', async () => {
    setup(() => {
      throw new TypeError('fetch failed')
    })

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The server could not be reached')).not.toBeNull()
  })
})

describe('the figures are the route’s', () => {
  it('reads the scope chosen in the header', async () => {
    const { fx } = setup(THREE, { scope: 'personal' })
    await loaded()

    const [call] = fx.callsTo('GET', LIST)
    expect([...call.url.searchParams.entries()]).toEqual([['scope', 'personal']])
  })

  it('shows runway from its tenths, unchanged', async () => {
    setup(habitsResponse({ runwayTenths: 78 }))
    await loaded()

    const runway = card('Runway')
    expect(screen.getByTestId('runway-value').textContent).toBe('7.8')
    expect(
      within(runway).getByText(
        "months you could live with zero income, at this month's spending.",
      ),
    ).not.toBeNull()
  })

  it('shows unbounded runway as the infinity sign, with why', async () => {
    setup(habitsResponse({ runwayTenths: null }))
    await loaded()

    expect(screen.getByTestId('runway-value').textContent).toBe('∞')
    expect(
      within(card('Runway')).getByText(
        'No spending in the last month, so there is nothing to divide by yet.',
      ),
    ).not.toBeNull()
  })

  it('shows each streak the route sends, with its label and days', async () => {
    setup(
      habitsResponse({
        streaks: [streak(), streak({ key: 'invented_one', label: 'Invented streak', days: 1 })],
      }),
    )
    await loaded()

    const items = within(card('Streaks')).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-streak-key'))).toEqual([
      'no_overdraft',
      'invented_one',
    ])
    expect(items.map((li) => li.textContent)).toEqual([
      'No overdraft58 days',
      'Invented streak1 day',
    ])
  })

  it('says so when no streak can be counted', async () => {
    setup(habitsResponse({ streaks: [] }))
    await loaded()

    const streaks = card('Streaks')
    expect(within(streaks).queryAllByRole('listitem')).toEqual([])
    expect(
      within(streaks).getByText('No streak can be counted from your data yet.'),
    ).not.toBeNull()
  })

  it('lists the spending in the route’s order, with merchant and meta', async () => {
    setup(THREE)
    await loaded()

    const items = within(card('Worth it?')).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-transaction-id'))).toEqual([
      '305',
      '201',
      '101',
    ])
    expect(within(row('305')).getByText('Example Cafe')).not.toBeNull()
    expect(within(row('305')).getByText('Eating out · -$9.40 · 25 Oct')).not.toBeNull()
    expect(within(row('201')).getByText('-$640.00 · 21 Oct')).not.toBeNull()
    expect(within(row('101')).getByText('Groceries · -$1,280.00 · 20 Oct')).not.toBeNull()
  })

  it('selects the pill of each row’s stored verdict, and counts them', async () => {
    setup(THREE)
    await loaded()

    expect(pressed('305')).toEqual(['Not really'])
    expect(pressed('201')).toEqual(['Worth it'])
    expect(pressed('101')).toEqual([])
    expect(summary()).toBe('1 not worth it · 1 worth it')
  })

  it('says so when there is no spending to judge', async () => {
    setup(habitsResponse({ verdicts: [] }))
    await loaded()

    const worth = card('Worth it?')
    expect(within(worth).queryAllByRole('listitem')).toEqual([])
    expect(within(worth).getByText('No spending in the last 90 days to judge.')).not.toBeNull()
    expect(summary()).toBe('Untagged')
  })
})

describe('what is not faked', () => {
  it('shows no Freedom date card or text', async () => {
    setup(THREE)
    await loaded()

    expect(document.body.textContent).not.toMatch(/freedom/i)
    expect(screen.queryByRole('region', { name: /freedom/i })).toBeNull()
    // Exactly these cards, so a projected-date card under another name
    // fails too.
    expect(
      screen.getAllByRole('region').map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Runway', 'Streaks', 'Worth it?', 'Patterns', 'Weekly truth report'])
  })

  it('the Patterns card is an empty state saying insights arrive later', async () => {
    setup(THREE)
    await loaded()

    const patterns = card('Patterns')
    expect(within(patterns).queryAllByRole('listitem')).toEqual([])
    expect(screen.getByTestId('patterns-empty').textContent).toBe(
      'No patterns yet. Insights from your own spending arrive here later.',
    )
  })

  it('the Patterns card shows what is mounted in it instead of the empty state', () => {
    render(
      <PatternsCard>
        <ul>
          <li>Mounted insight</li>
        </ul>
      </PatternsCard>,
    )

    expect(screen.getByText('Mounted insight')).not.toBeNull()
    expect(screen.queryByTestId('patterns-empty')).toBeNull()
  })

  it('the Weekly truth report says to ask Claude desktop, and opens nothing', async () => {
    const { fx } = setup(THREE)
    await loaded()
    const before = fx.calls.length

    const truth = card('Weekly truth report')
    expect(truth.textContent).toContain("Ask Claude desktop for this week's honest read.")
    expect(within(truth).queryAllByRole('button')).toEqual([])
    expect(within(truth).queryAllByRole('link')).toEqual([])
    expect(truth.querySelector('textarea, input, form')).toBeNull()
    fireEvent.click(truth)

    expect(fx.calls).toHaveLength(before)
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('tapping a verdict', () => {
  it('persists the tapped verdict, and it survives a reload', async () => {
    const server = verdictServer(habitsResponse({ verdicts: [GROCER] }))
    const { fx, unmount } = setup(server.list, { verdict: server.verdict })
    await loaded()

    fireEvent.click(pill('101', 'Not really'))

    await waitFor(() => expect(pressed('101')).toEqual(['Not really']))
    expect(fx.bodiesTo('PUT', verdictPath('101'))).toEqual([{ verdict: 'not_really' }])
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(summary()).toBe('1 not worth it · 0 worth it')

    // A reload: a fresh render with a fresh cache reads the stored verdict.
    unmount()
    setup(server.list, { verdict: server.verdict })
    await loaded()
    expect(pressed('101')).toEqual(['Not really'])
  })

  it('tapping the selected pill again clears it', async () => {
    const server = verdictServer(habitsResponse({ verdicts: [GROCER] }))
    const { fx } = setup(server.list, { verdict: server.verdict })
    await loaded()

    fireEvent.click(pill('101', 'Worth it'))
    await waitFor(() => expect(pressed('101')).toEqual(['Worth it']))
    await waitFor(() => expect(pill('101', 'Worth it').disabled).toBe(false))
    fireEvent.click(pill('101', 'Worth it'))

    await waitFor(() => expect(pressed('101')).toEqual([]))
    expect(fx.bodiesTo('PUT', verdictPath('101'))).toEqual([
      { verdict: 'worth_it' },
      { verdict: null },
    ])
    expect(server.rows[0].verdict).toBeNull()
    expect(summary()).toBe('Untagged')
  })

  it('tapping the other pill switches the verdict', async () => {
    const server = verdictServer(habitsResponse({ verdicts: [SUPPLIER] }))
    const { fx } = setup(server.list, { verdict: server.verdict })
    await loaded()

    fireEvent.click(pill('201', 'Not really'))

    await waitFor(() => expect(pressed('201')).toEqual(['Not really']))
    expect(fx.bodiesTo('PUT', verdictPath('201'))).toEqual([{ verdict: 'not_really' }])
  })

  it('keeps the server’s verdict on screen and waits while the write is in flight', async () => {
    const { fx } = setup(habitsResponse({ verdicts: [GROCER, CAFE] }), {
      verdict: () => undefined,
    })
    await loaded()

    fireEvent.click(pill('101', 'Worth it'))
    // A second tap in the same tick is refused before the pills disable.
    fireEvent.click(pill('305', 'Worth it'))

    await waitFor(() => expect(pill('101', 'Worth it').disabled).toBe(true))
    expect(pill('305', 'Not really').disabled).toBe(true)
    expect(pressed('101')).toEqual([])
    expect(fx.callsTo('PUT', verdictPath('101'))).toHaveLength(1)
    expect(fx.callsTo('PUT', verdictPath('305'))).toEqual([])
  })

  it("shows the server's message when a verdict is refused", async () => {
    setup(habitsResponse({ verdicts: [GROCER] }), {
      verdict: () => ({
        status: 409,
        body: { error: 'Transaction is still pending; it can be tagged once it settles' },
      }),
    })
    await loaded()

    fireEvent.click(pill('101', 'Worth it'))

    const alert = await within(card('Worth it?')).findByRole('alert')
    expect(alert.textContent).toBe(
      'Transaction is still pending; it can be tagged once it settles',
    )
    expect(pressed('101')).toEqual([])
  })

  it('says so when the server cannot be reached for a verdict', async () => {
    setup(habitsResponse({ verdicts: [GROCER] }), {
      verdict: () => {
        throw new TypeError('fetch failed')
      },
    })
    await loaded()

    fireEvent.click(pill('101', 'Not really'))

    const alert = await within(card('Worth it?')).findByRole('alert')
    expect(alert.textContent).toBe('The server could not be reached')
  })

  it('never refetches the Overview', async () => {
    const server = verdictServer(habitsResponse({ verdicts: [GROCER] }))
    const { fx } = setup(server.list, { verdict: server.verdict, probe: true })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))

    fireEvent.click(pill('101', 'Worth it'))
    await waitFor(() => expect(pressed('101')).toEqual(['Worth it']))
    await act(async () => {
      await Promise.resolve()
    })

    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1)
  })
})

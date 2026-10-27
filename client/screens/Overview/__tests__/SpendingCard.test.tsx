import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { grabSettings } from '../../../apis/settings.ts'
import { useScope } from '../../../context/ScopeContext.tsx'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { formatCents } from '../../../../shared/money.ts'
import Overview from '../index.tsx'
import SpendingCard from '../SpendingCard.tsx'
import {
  GROUPS,
  installFetch,
  overviewByScope,
  overviewFixture,
  spendingByScope,
  spendingFixture,
} from './fixtures.ts'

// The Overview's "Spending by category" card (#271). Its request goes
// through the real client/apis/overview.ts to the routing fetch stub
// (./fixtures.ts); anything without a handler never settles. Settings are
// read with superagent by the tax card, so that module is mocked to never
// answer. Every value is invented.

vi.mock('../../../apis/settings.ts', () => ({ grabSettings: vi.fn() }))

const SPENDING = '/api/v1/spending/categories'

beforeEach(() => {
  vi.mocked(grabSettings).mockReturnValue(new Promise(() => {}))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

// The card under the scope context, with a button that switches it, so the
// card stays mounted across a switch (the Overview remounts it).
function ScopedCard() {
  const { scope, setScope } = useScope()
  return (
    <>
      <button type="button" onClick={() => setScope('strawb')}>
        Switch to Strawb
      </button>
      <SpendingCard scope={scope} />
    </>
  )
}

function card(): HTMLElement {
  return screen.getByTestId('spending-card')
}

async function total(): Promise<string> {
  return (await screen.findByTestId('spending-total')).textContent ?? ''
}

function segments(): HTMLElement[] {
  return [
    ...card().querySelectorAll<HTMLElement>('[data-spending-segment]'),
  ]
}

function listRows(): string[][] {
  const list = within(card()).getByRole('list', {
    name: 'Top spending categories',
  })
  return within(list)
    .getAllByRole('listitem')
    .map((li) => [...li.querySelectorAll('span')].map((s) => s.textContent ?? ''))
}

describe('the request', () => {
  it('asks for the scope with the card’s top of 5', async () => {
    const fx = installFetch({ spending: spendingByScope() })
    renderWithProviders(<SpendingCard scope="strawb" />)
    await total()

    const gets = fx.callsTo('GET', SPENDING)
    expect(gets).toHaveLength(1)
    expect([...gets[0].url.searchParams]).toEqual([
      ['scope', 'strawb'],
      ['top', '5'],
    ])
  })
})

describe('what it shows', () => {
  it('shows the server’s total, not a sum of the lines', async () => {
    // The lines add up to 101773 in the fixture; the server says 123457.
    installFetch({
      spending: spendingByScope({ all: { totalCents: 123457 } }),
    })
    renderWithProviders(<SpendingCard scope="all" />)

    expect(await total()).toBe('$1,234.57')
    expect(within(card()).getByText('This month')).not.toBeNull()
  })

  it('draws one segment per line, sized by its cents, then Other, then Uncategorised', async () => {
    installFetch({ spending: spendingByScope() })
    renderWithProviders(<SpendingCard scope="all" />)
    await total()
    const fx = spendingFixture('all')

    const shown = segments()
    expect(shown.map((s) => s.getAttribute('data-spending-segment'))).toEqual([
      'category',
      'category',
      'category',
      'category',
      'category',
      'other',
      'uncategorised',
    ])
    expect(shown.map((s) => s.style.flexGrow)).toEqual(
      [
        ...fx.categories.map((line) => line.spentCents),
        fx.otherCents,
        fx.uncategorisedCents,
      ].map(String),
    )
    // Ranks in theme colours, the tail muted, uncategorised ink.
    expect(shown.map((s) => s.className.split(' ').at(-1))).toEqual([
      'bg-deep',
      'bg-pink',
      'bg-rose',
      'bg-blush-hover',
      'bg-ink-faint',
      'bg-ink-muted',
      'bg-ink',
    ])
  })

  it('hides the bar from assistive tech; the named list carries the figures', async () => {
    installFetch({ spending: spendingByScope() })
    renderWithProviders(<SpendingCard scope="all" />)
    await total()
    const fx = spendingFixture('all')

    expect(screen.getByTestId('spending-bar').getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(listRows()).toEqual([
      ...fx.categories.map((line) => [
        '',
        line.category,
        formatCents(line.spentCents),
      ]),
      ['', 'Other', formatCents(fx.otherCents)],
      ['', 'Uncategorised', formatCents(fx.uncategorisedCents)],
    ])
    expect(listRows()[0]).toEqual(['', 'Groceries Invented', '$312.17'])
  })

  it('leaves Other out when it is 0', async () => {
    installFetch({ spending: spendingByScope() })
    renderWithProviders(<SpendingCard scope="personal" />)
    await total()

    expect(listRows().map((row) => row[1])).toEqual([
      'Groceries Invented',
      'Takeaways Invented',
      'Books Invented',
      'Uncategorised',
    ])
    expect(card().querySelector('[data-spending-segment="other"]')).toBeNull()
  })

  it('leaves Uncategorised out when it is 0', async () => {
    installFetch({
      spending: spendingByScope({
        strawb: { totalCents: 36961, uncategorisedCents: 0 },
      }),
    })
    renderWithProviders(<SpendingCard scope="strawb" />)
    await total()

    expect(listRows().map((row) => row[1])).toEqual([
      'Software Invented',
      'Fuel Invented',
      'Other',
    ])
    expect(
      card().querySelector('[data-spending-segment="uncategorised"]'),
    ).toBeNull()
  })

  it('links the whole card to the Spending screen', async () => {
    installFetch({ spending: spendingByScope() })
    renderWithProviders(<SpendingCard scope="all" />)
    await total()

    const links = within(card()).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('/spending')
    expect(links[0].textContent).toBe('Spending by category')
    expect(
      within(card()).getByRole('heading', { level: 2 }).textContent,
    ).toBe('Spending by category')
    expect(card().getAttribute('aria-labelledby')).toBe(
      card().querySelector('h2')?.id,
    )
  })

  it('says so when nothing was spent this month, with no bar or list', async () => {
    installFetch({
      spending: spendingByScope({
        all: {
          totalCents: 0,
          categories: [],
          otherCents: 0,
          uncategorisedCents: 0,
        },
      }),
    })
    renderWithProviders(<SpendingCard scope="all" />)

    expect(
      await within(card()).findByText('No spending yet this month.'),
    ).not.toBeNull()
    expect(screen.queryByTestId('spending-bar')).toBeNull()
    expect(screen.queryByTestId('spending-total')).toBeNull()
    expect(within(card()).queryByRole('list')).toBeNull()
  })

  it('shows only Uncategorised when nothing spent has a category', async () => {
    installFetch({
      spending: spendingByScope({
        all: {
          totalCents: 4321,
          categories: [],
          otherCents: 0,
          uncategorisedCents: 4321,
        },
      }),
    })
    renderWithProviders(<SpendingCard scope="all" />)

    expect(await total()).toBe(formatCents(4321))
    const shown = segments()
    expect(shown.map((s) => s.getAttribute('data-spending-segment'))).toEqual([
      'uncategorised',
    ])
    expect(shown[0].className.split(' ').at(-1)).toBe('bg-ink')
    expect(listRows()).toEqual([['', 'Uncategorised', formatCents(4321)]])
    expect(within(card()).queryByText('No spending yet this month.')).toBeNull()
  })

  it.each(['all', 'personal', 'strawb'] as const)(
    'in %s says nothing estimated, owed to you, invoiced or from Xero',
    async (scope) => {
      installFetch({ spending: spendingByScope() })
      renderWithProviders(<SpendingCard scope={scope} />)
      await total()

      const text = card().textContent ?? ''
      expect(text).not.toMatch(/owed to you|xero|invoice|estimated/i)
      expect(text).not.toContain('~')
    },
  )
})

describe('loading and errors', () => {
  it('keeps no figure from the old scope while the new one loads', async () => {
    const answer = spendingByScope()
    const fx = installFetch({
      spending: (call) =>
        call.url.searchParams.get('scope') === 'strawb'
          ? undefined
          : answer(call),
    })
    renderWithProviders(<ScopedCard />, { initialScope: 'all' })
    expect(await total()).toBe('$1,017.73')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Strawb' }))

    expect(
      await within(card()).findByText('Loading spending…'),
    ).not.toBeNull()
    expect(fx.callsTo('GET', SPENDING).at(-1)?.url.searchParams.get('scope')).toBe(
      'strawb',
    )
    expect(card().textContent).not.toContain('$1,017.73')
    expect(card().textContent).not.toContain('$312.17')
  })

  it('shows a plain loading line, not a status region', () => {
    installFetch({ spending: () => undefined })
    renderWithProviders(<SpendingCard scope="all" />)

    expect(within(card()).getByText('Loading spending…')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('shows the server’s message and recovers on Try again', async () => {
    const fx = installFetch({
      spending: () => ({
        status: 500,
        body: { error: 'spending input invalid' },
      }),
    })
    renderWithProviders(<SpendingCard scope="all" />)

    const alert = await within(card()).findByRole('alert')
    expect(alert.querySelector('p')?.textContent).toBe('spending input invalid')
    fx.handlers.spending = spendingByScope()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await total()).toBe('$1,017.73')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fx.callsTo('GET', SPENDING)).toHaveLength(2)
  })
})

describe('on the Overview', () => {
  function setup() {
    const fx = installFetch({
      overview: overviewByScope(),
      categories: () => ({ body: { items: GROUPS } }),
      spending: spendingByScope(),
    })
    const view = renderWithProviders(<Overview />, { initialScope: 'all' })
    return { fx, ...view }
  }

  it('sits between the top cards and the alerts', async () => {
    setup()
    await total()

    const section = screen.getByRole('region', { name: 'Overview' })
    const order = [...section.children].map(
      (el) =>
        el.getAttribute('data-testid') ??
        el.querySelector('[data-testid]')?.getAttribute('data-testid') ??
        '',
    )
    const at = order.indexOf('spending-card')
    expect(at).toBeGreaterThan(0)
    expect(section.children[at - 1].querySelector('[data-testid="hero-amount"]')).not.toBeNull()
    expect(
      section.children[at + 1].querySelector('#alerts-heading'),
    ).not.toBeNull()
  })

  it('shows no figure from the old scope while the new one loads', async () => {
    const { fx } = setup()
    expect(await total()).toBe('$1,017.73')
    const answer = spendingByScope()
    fx.handlers.spending = (call) =>
      call.url.searchParams.get('scope') === 'strawb' ? undefined : answer(call)

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Scope' })).getByRole('button', {
        name: 'Strawb',
      }),
    )

    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,000.00'),
    )
    expect(within(card()).getByText('Loading spending…')).not.toBeNull()
    expect(fx.callsTo('GET', SPENDING).at(-1)?.url.searchParams.get('scope')).toBe(
      'strawb',
    )
    expect(card().textContent).not.toContain('$1,017.73')
    expect(card().textContent).not.toContain('$312.17')
  })

  it('refetches after an inline category edit succeeds', async () => {
    const { fx } = setup()
    await total()
    fx.handlers.patch = () => ({ body: { transaction: { id: 101 } } })
    fx.handlers.overview = overviewByScope()
    const before = fx.callsTo('GET', SPENDING).length

    fireEvent.change(
      await screen.findByLabelText<HTMLSelectElement>(
        'Category for Cafe Invented',
      ),
      { target: { value: 'Supermarkets and grocery stores' } },
    )

    await waitFor(() =>
      expect(fx.callsTo('GET', SPENDING).length).toBeGreaterThan(before),
    )
    expect(fx.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  it('a spending failure leaves the rest of the Overview standing', async () => {
    installFetch({
      overview: overviewByScope(),
      categories: () => ({ body: { items: GROUPS } }),
      spending: () => ({ status: 500, body: { error: 'Could not read spending' } }),
    })
    renderWithProviders(<Overview />, { initialScope: 'all' })
    const spending = await screen.findByTestId('spending-card')

    expect(
      (await within(spending).findByRole('alert')).querySelector('p')?.textContent,
    ).toBe('Could not read spending')
    expect(screen.getByTestId('hero-amount').textContent).toBe(
      formatCents(overviewFixture('all').safeToSpend.safeCents),
    )
  })
})

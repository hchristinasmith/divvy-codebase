import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { formatCents } from '../../../../shared/money.ts'
import type {
  Scope,
  SpendingByCategoryResponse,
} from '../../../../shared/contracts.ts'
import type { TransactionRow } from '../../../../models/transactions.ts'
import {
  installFetch,
  type Handler,
} from '../../Overview/__tests__/fixtures.ts'
import Spending from '../index.tsx'

// The Spending screen (issue 272). Requests go through the real
// client/apis/overview.ts to the Overview's routing fetch stub; anything
// without a handler never settles. The clock is fixed at 23:30 UTC on 27
// October 2026, 12:30 NZDT on the 28th, so the screen opens on October 2026.
// Every value is invented.

const SPENDING = '/api/v1/spending/categories'
const TRANSACTIONS = '/api/v1/transactions'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2026-10-27T23:30:00.000Z')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

// More categories than the card's top of 5, so a folded "Other" would show.
// The lines and uncategorised add up to the total.
const CATEGORIES = [
  { category: 'Groceries Invented', spentCents: 31217 },
  { category: 'Takeaways Invented', spentCents: 18833 },
  { category: 'Software Invented', spentCents: 14451 },
  { category: 'Fuel Invented', spentCents: 9119 },
  { category: 'Books Invented', spentCents: 7707 },
  { category: 'Plants Invented', spentCents: 7200 },
  { category: 'Stamps Invented', spentCents: 6191 },
]

function month(
  scope: Scope,
  monthValue: string,
  overrides: Partial<SpendingByCategoryResponse> = {},
): SpendingByCategoryResponse {
  return {
    scope,
    month: monthValue,
    totalCents: 101773,
    categories: CATEGORIES,
    otherCents: 0,
    uncategorisedCents: 7055,
    ...overrides,
  }
}

/** Answers each request with that scope and month's response. */
function byMonth(
  overrides: Partial<SpendingByCategoryResponse> = {},
): Handler {
  return (call) => ({
    body: month(
      call.url.searchParams.get('scope') as Scope,
      call.url.searchParams.get('month') ?? '',
      overrides,
    ),
  })
}

function row(fields: Partial<TransactionRow>): TransactionRow {
  return {
    id: 1,
    akahu_id: 'trans_invented',
    account_id: 'acc_invented',
    user_id: null,
    connection_id: null,
    created_at: null,
    updated_at: null,
    date: '2026-10-05T00:00:00.000Z',
    description: 'INVENTED SHOP 0001',
    amount_cents: -2310,
    balance_cents: null,
    type: 'EFTPOS',
    hash: null,
    particulars: null,
    code: null,
    reference: null,
    other_account: null,
    logo: null,
    card_suffix: null,
    merchant_id: null,
    merchant_name: null,
    merchant_website: null,
    merchant_logo: null,
    category: 'Groceries Invented',
    category_source: 'akahu',
    status: 'settled',
    ...fields,
  }
}

const GROCERY_ROWS = [
  row({
    id: 12,
    date: '2026-10-06T00:00:00.000Z',
    merchant_name: 'Grocer Invented',
    amount_cents: -1205,
    status: 'pending',
  }),
  row({ id: 11, description: 'CORNER SHOP INVENTED', amount_cents: -2310 }),
  // 12:30 UTC on the 30th of September is 1 October in NZ.
  row({
    id: 10,
    date: '2026-09-30T12:30:00.000Z',
    merchant_name: 'Market Invented',
    amount_cents: -999,
  }),
]

function setup(
  handlers: { spending?: Handler; transactions?: Handler } = {},
) {
  const fx = installFetch({
    spending: byMonth(),
    transactions: () => ({ body: { txns: GROCERY_ROWS } }),
    ...handlers,
  })
  const view = renderWithProviders(<Spending />, { initialScope: 'all' })
  return { fx, ...view }
}

async function total(): Promise<string> {
  return (await screen.findByTestId('spending-total')).textContent ?? ''
}

function categoryList(): HTMLElement {
  return screen.getByRole('list', { name: 'Spending categories' })
}

function lineNames(): string[] {
  return within(categoryList())
    .getAllByRole('listitem')
    .filter((li) => li.hasAttribute('data-spending-line'))
    .map((li) => li.querySelectorAll('span')[1]?.textContent ?? '')
}

function categoryButton(name: string): HTMLElement {
  return within(categoryList()).getByRole('button', {
    name: new RegExp(`^${name}`),
  })
}

function lastParams(fx: ReturnType<typeof installFetch>, path: string) {
  return [...(fx.callsTo('GET', path).at(-1)?.url.searchParams ?? [])]
}

describe('the month', () => {
  it('opens on this NZ month and asks for every category, with no top', async () => {
    const { fx } = setup()
    await total()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Spending')
    expect(screen.getByTestId('spending-month').textContent).toBe('October 2026')
    expect(fx.callsTo('GET', SPENDING)).toHaveLength(1)
    expect(lastParams(fx, SPENDING)).toEqual([
      ['scope', 'all'],
      ['month', '2026-10'],
    ])
  })

  it('lists every category with its total, then Uncategorised, and no Other', async () => {
    setup()

    expect(await total()).toBe('$1,017.73')
    expect(lineNames()).toEqual([
      ...CATEGORIES.map((line) => line.category),
      'Uncategorised',
    ])
    for (const line of CATEGORIES) {
      expect(categoryButton(line.category).textContent).toBe(
        `${line.category}${formatCents(line.spentCents)}`,
      )
    }
    expect(within(categoryList()).queryByText('Other')).toBeNull()
    expect(
      screen.getByTestId('spending-bar').querySelector('[data-spending-segment="other"]'),
    ).toBeNull()
    expect(
      screen
        .getByTestId('spending-bar')
        .querySelectorAll('[data-spending-segment="category"]'),
    ).toHaveLength(CATEGORIES.length)
  })

  it('shows the server’s total, not a sum of the lines', async () => {
    setup({ spending: byMonth({ totalCents: 123457 }) })

    expect(await total()).toBe('$1,234.57')
  })

  it('moves back and forward a month and asks for that month', async () => {
    const { fx } = setup()
    await total()

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByTestId('spending-month').textContent).toBe('September 2026')
    await waitFor(() =>
      expect(lastParams(fx, SPENDING)).toEqual([
        ['scope', 'all'],
        ['month', '2026-09'],
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByTestId('spending-month').textContent).toBe('November 2026')
    await waitFor(() =>
      expect(lastParams(fx, SPENDING)).toEqual([
        ['scope', 'all'],
        ['month', '2026-11'],
      ]),
    )
  })

  it('crosses a year going back from January', async () => {
    vi.setSystemTime('2026-01-10T00:00:00.000Z')
    const { fx } = setup()
    await total()

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))

    expect(screen.getByTestId('spending-month').textContent).toBe('December 2025')
    await waitFor(() =>
      expect(lastParams(fx, SPENDING)).toContainEqual(['month', '2025-12']),
    )
  })

  it('asks for the toggle’s scope', async () => {
    const { fx } = setup()
    await total()

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Scope' })).getByRole('button', {
        name: 'Strawb',
      }),
    )

    await waitFor(() =>
      expect(lastParams(fx, SPENDING)).toEqual([
        ['scope', 'strawb'],
        ['month', '2026-10'],
      ]),
    )
  })

  it('says so when nothing was spent in the month, with no bar or list', async () => {
    setup({
      spending: byMonth({
        totalCents: 0,
        categories: [],
        uncategorisedCents: 0,
      }),
    })

    expect(await screen.findByText('No spending in October 2026.')).not.toBeNull()
    expect(screen.queryByTestId('spending-bar')).toBeNull()
    expect(screen.queryByTestId('spending-total')).toBeNull()
  })

  it('shows the server’s message and recovers on Try again', async () => {
    const { fx } = setup({
      spending: () => ({ status: 500, body: { error: 'spending input invalid' } }),
    })

    const alert = await screen.findByRole('alert')
    expect(alert.querySelector('p')?.textContent).toBe('spending input invalid')
    fx.handlers.spending = byMonth()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await total()).toBe('$1,017.73')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a category’s transactions', () => {
  it('lists the category’s rows for the scope and month when it is tapped', async () => {
    const { fx } = setup()
    await total()
    const button = categoryButton('Groceries Invented')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(fx.callsTo('GET', TRANSACTIONS)).toHaveLength(0)

    fireEvent.click(button)

    const list = await screen.findByRole('list', {
      name: 'Groceries Invented transactions',
    })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(list.parentElement?.id)
    expect(lastParams(fx, TRANSACTIONS)).toEqual([
      ['scope', 'all'],
      ['month', '2026-10'],
      ['category', 'Groceries Invented'],
    ])
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      // Merchant over description; the NZ day; the row's own amount.
      `6 OctGrocer InventedPending${formatCents(-1205)}`,
      `5 OctCORNER SHOP INVENTED${formatCents(-2310)}`,
      `1 OctMarket Invented${formatCents(-999)}`,
    ])
  })

  it('closes on a second tap', async () => {
    setup()
    await total()

    fireEvent.click(categoryButton('Groceries Invented'))
    await screen.findByRole('list', { name: 'Groceries Invented transactions' })
    fireEvent.click(categoryButton('Groceries Invented'))

    expect(
      screen.queryByRole('list', { name: 'Groceries Invented transactions' }),
    ).toBeNull()
    expect(categoryButton('Groceries Invented').getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('leaves Uncategorised as a line, not a button', async () => {
    setup()
    await total()

    const uncategorised = within(categoryList())
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('data-spending-line') === 'uncategorised')
    expect(uncategorised?.textContent).toBe(`Uncategorised${formatCents(7055)}`)
    expect(uncategorised?.querySelector('button')).toBeNull()
    expect(within(categoryList()).getAllByRole('button')).toHaveLength(
      CATEGORIES.length,
    )
  })

  it('closes the list when the month changes', async () => {
    const { fx } = setup()
    await total()
    fireEvent.click(categoryButton('Groceries Invented'))
    await screen.findByRole('list', { name: 'Groceries Invented transactions' })

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(lastParams(fx, SPENDING)).toContainEqual(['month', '2026-09']))
    await total()

    expect(
      screen.queryByRole('list', { name: 'Groceries Invented transactions' }),
    ).toBeNull()
    expect(categoryButton('Groceries Invented').getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(fx.callsTo('GET', TRANSACTIONS)).toHaveLength(1)
  })

  it('closes the list when the scope changes', async () => {
    const { fx } = setup()
    await total()
    fireEvent.click(categoryButton('Groceries Invented'))
    await screen.findByRole('list', { name: 'Groceries Invented transactions' })

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Scope' })).getByRole('button', {
        name: 'Strawb',
      }),
    )
    await waitFor(() => expect(lastParams(fx, SPENDING)).toContainEqual(['scope', 'strawb']))
    await total()

    expect(
      screen.queryByRole('list', { name: 'Groceries Invented transactions' }),
    ).toBeNull()
    expect(fx.callsTo('GET', TRANSACTIONS)).toHaveLength(1)
  })

  it('shows the server’s message for the list and recovers on Try again', async () => {
    const { fx } = setup({
      transactions: () => ({
        status: 500,
        body: { error: "Couldn't list transactions" },
      }),
    })
    await total()
    fireEvent.click(categoryButton('Groceries Invented'))

    const alert = await screen.findByRole('alert')
    expect(alert.querySelector('p')?.textContent).toBe("Couldn't list transactions")
    fx.handlers.transactions = () => ({ body: { txns: GROCERY_ROWS } })
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(
      await screen.findByRole('list', { name: 'Groceries Invented transactions' }),
    ).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

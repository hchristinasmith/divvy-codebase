import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  CategoriseGroupsResponse,
  Scope,
} from '../../../../shared/contracts.ts'
import Sort from '../index.tsx'
import {
  APPLY,
  BAKERY,
  CAFE,
  CATEGORIES,
  FUEL,
  GROUPS,
  group,
  groupsResponse,
  installFetch,
  type Handler,
  type Handlers,
} from './fixtures.ts'

// The Sort screen (prd-02 Ruling 17, issue 259; Done-when 6). Every
// request goes through the real client/apis/categorise.ts to a routing fetch
// stub (./fixtures.ts). The sync pill's fetch never settles. Every value is
// invented. Each test names the wrong behaviour it fails on.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const CAFES = 'Cafes and restaurants'

function serve(body: CategoriseGroupsResponse): Handler {
  return () => ({ body })
}

function setup(
  handlers: Handlers = {},
  initialScope: Scope = 'all',
) {
  const fx = installFetch({
    groups: serve(groupsResponse()),
    apply: () => ({ body: { changed: 5 } }),
    categories: () => ({ body: CATEGORIES }),
    ...handlers,
  })
  const view = renderWithProviders(<Sort />, { initialScope })
  return { fx, ...view }
}

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Merchant' })
}

function merchant(): string {
  return screen.getByTestId('sort-merchant').textContent ?? ''
}

function progress(): string {
  return screen.getByTestId('sort-progress').textContent ?? ''
}

/** Lets a write that was started reach `fetch`, so its absence is real. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

async function firstCard() {
  await screen.findByTestId('sort-merchant')
  await screen.findByRole('button', { name: CAFES })
}

describe('the queue', () => {
  it('shows one card at a time, with its place in the queue', async () => {
    setup()
    await firstCard()

    // Fails if every group is rendered at once, or the progress counts
    // from 0.
    expect(screen.getAllByRole('region', { name: 'Merchant' })).toHaveLength(1)
    expect(merchant()).toBe('EXAMPLE CAFE')
    expect(progress()).toBe('1 / 3')
    expect(screen.getByTestId('sort-progress').classList.contains('font-mono')).toBe(true)
    expect(screen.queryByText('EXAMPLE BAKERY')).toBeNull()
  })

  it('shows the count, total and latest date and amount from the server', async () => {
    setup()
    await firstCard()

    expect(within(card()).getByText('5 transactions')).not.toBeNull()
    expect(screen.getByTestId('sort-total').textContent).toBe('$24.50 spent')
    expect(screen.getByTestId('sort-latest').textContent).toBe(
      'Latest 5 Oct\u00a02026 · -$3.90',
    )
    // No money in, no received line.
    expect(screen.queryByTestId('sort-received')).toBeNull()
  })

  it('shows money in on its own line only when there is some', async () => {
    setup({ groups: serve(groupsResponse([BAKERY])) })
    await screen.findByTestId('sort-merchant')

    expect(screen.getByTestId('sort-received').textContent).toBe(
      '+$3.00 received',
    )
    expect(screen.getByTestId('sort-latest').textContent).toBe(
      'Latest 24 Dec\u00a02025 · $3.00',
    )
  })

  it('leaves the date out when the server has none', async () => {
    setup({ groups: serve(groupsResponse([FUEL])) })
    await screen.findByTestId('sort-merchant')

    expect(screen.getByTestId('sort-latest').textContent).toBe(
      'Latest -$8.00',
    )
    expect(within(card()).getByText('1 transaction')).not.toBeNull()
  })

  it('renders HTML in a merchant name as text', async () => {
    const name = '<img src=x onerror="alert(1)">EXAMPLE <b>BOLD</b>'
    setup({ groups: serve(groupsResponse([group({ name })])) })
    await screen.findByTestId('sort-merchant')

    // Fails if the name is set as markup.
    expect(merchant()).toBe(name)
    expect(card().querySelector('img')).toBeNull()
    expect(card().querySelector('b')).toBeNull()
  })

  it('asks for the scope in view', async () => {
    const { fx } = setup({}, 'strawb')
    await firstCard()

    expect(
      fx.callsTo('GET', GROUPS).map((c) => c.url.searchParams.get('scope')),
    ).toEqual(['strawb'])
  })
})

describe('applying a category', () => {
  it('sends the merchant, scope and category, then moves to the next card', async () => {
    const { fx } = setup({}, 'personal')
    await firstCard()

    fireEvent.click(screen.getByRole('button', { name: CAFES }))

    await waitFor(() => expect(merchant()).toBe('EXAMPLE BAKERY'))
    expect(progress()).toBe('2 / 3')
    expect(screen.getByRole('status').textContent).toBe('Categorised 5')
    const bodies = fx.bodiesTo('POST', APPLY)
    expect(bodies).toEqual([
      { scope: 'personal', merchant_key: CAFE.merchantKey, category: CAFES },
    ])
    expect(Object.keys(bodies[0]).sort()).toEqual([
      'category',
      'merchant_key',
      'scope',
    ])
  })

  it('keeps the card and shows the message when the server refuses', async () => {
    setup({
      apply: () => ({
        status: 400,
        body: { error: 'category is not in the category list' },
      }),
    })
    await firstCard()

    fireEvent.click(screen.getByRole('button', { name: CAFES }))

    // Fails if a refusal advances the cursor or swallows the text.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('category is not in the category list')
    expect(merchant()).toBe('EXAMPLE CAFE')
    expect(progress()).toBe('1 / 3')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('disables every control while the write is in flight', async () => {
    setup({ apply: () => undefined })
    await firstCard()

    fireEvent.click(screen.getByRole('button', { name: CAFES }))

    await waitFor(() =>
      expect(
        within(card())
          .getAllByRole('button')
          .every((b) => (b as HTMLButtonElement).disabled),
      ).toBe(true),
    )
  })

  it('sends one request for two taps before the next render', async () => {
    const { fx } = setup({ apply: () => undefined })
    await firstCard()
    const cafes = screen.getByRole('button', { name: CAFES })
    const fuel = screen.getByRole('button', { name: 'Fuel stations' })

    // Both taps land inside one act, so neither button has re-rendered
    // disabled yet: only the mutation-cache guard can drop the second. Fails
    // if that guard is removed.
    act(() => {
      cafes.click()
      fuel.click()
    })

    await waitFor(() => expect(fx.callsTo('POST', APPLY)).toHaveLength(1))
    expect(fx.bodiesTo('POST', APPLY)[0].category).toBe(CAFES)
  })

  it('invalidates the Overview, budgets, both transaction lists and the groups', async () => {
    const { client } = setup()
    await firstCard()
    const spy = vi.spyOn(client, 'invalidateQueries')

    fireEvent.click(screen.getByRole('button', { name: CAFES }))
    await waitFor(() => expect(merchant()).toBe('EXAMPLE BAKERY'))

    // Fails if any one of these is dropped from `invalidateAfterApply`.
    await waitFor(() =>
      expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
        expect.arrayContaining([
          ['overview'],
          ['budgets'],
          ['transactions'],
          ['txns'],
          ['categorise'],
        ]),
      ),
    )
  })

  it('keeps its queue when the refetch after an apply answers a new order', async () => {
    const { fx } = setup()
    await firstCard()
    // After the apply, the server would list fuel first and no cafe.
    fx.handlers.groups = serve(groupsResponse([FUEL, BAKERY]))

    fireEvent.click(screen.getByRole('button', { name: CAFES }))
    await waitFor(() => expect(fx.callsTo('GET', GROUPS)).toHaveLength(2))

    // Fails if the queue follows the refetch instead of its snapshot.
    expect(merchant()).toBe('EXAMPLE BAKERY')
    expect(progress()).toBe('2 / 3')
  })
})

describe('skip', () => {
  it('moves on and sends nothing', async () => {
    const { fx } = setup()
    await firstCard()

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await settle()

    // Fails if Skip writes, or does not move.
    expect(merchant()).toBe('EXAMPLE BAKERY')
    expect(progress()).toBe('2 / 3')
    expect(fx.callsTo('POST', APPLY)).toEqual([])
  })

  it('clears a refusal from the card it leaves', async () => {
    setup({
      apply: () => ({ status: 500, body: { error: 'Could not apply the category' } }),
    })
    await firstCard()
    fireEvent.click(screen.getByRole('button', { name: CAFES }))
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the category choices', () => {
  it('offers the common categories the server lists, and More…', async () => {
    setup()
    await firstCard()

    const common = within(
      screen.getByRole('group', { name: 'Common categories' }),
    )
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(common).toEqual([
      'Supermarkets and grocery stores',
      CAFES,
      'Fast food stores',
      'Fuel stations',
      'Media and entertainment streaming services',
      'Business software and cloud services',
      'More…',
    ])
  })

  it('never offers a common category the server does not list', async () => {
    setup({
      categories: () => ({
        body: { items: [{ name: 'Lifestyle', categories: [CAFES] }] },
      }),
    })
    await firstCard()

    expect(screen.queryByRole('button', { name: 'Fuel stations' })).toBeNull()
  })

  it('writes nothing when a category is chosen in More…, only on Apply', async () => {
    const { fx } = setup()
    await firstCard()

    fireEvent.click(screen.getByRole('button', { name: 'More…' }))
    const select = screen.getByRole('combobox', {
      name: 'Category for EXAMPLE CAFE',
    })
    expect(
      [...select.querySelectorAll('optgroup')].map((g) => g.label),
    ).toEqual(CATEGORIES.items.map((g) => g.name))
    fireEvent.change(select, { target: { value: 'Parking services' } })
    await settle()

    // Fails if a select change fires the bulk write.
    expect(fx.callsTo('POST', APPLY)).toEqual([])
    expect(merchant()).toBe('EXAMPLE CAFE')

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(merchant()).toBe('EXAMPLE BAKERY'))
    expect(fx.bodiesTo('POST', APPLY)[0].category).toBe('Parking services')
  })

  it('keeps Apply disabled until a category is chosen', async () => {
    setup()
    await firstCard()

    fireEvent.click(screen.getByRole('button', { name: 'More…' }))

    expect(
      (screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('makes every control at least 48px tall', async () => {
    setup()
    await firstCard()
    fireEvent.click(screen.getByRole('button', { name: 'More…' }))

    const controls = [
      ...within(card()).getAllByRole('button'),
      screen.getByRole('combobox'),
    ]
    for (const control of controls) {
      expect(control.classList.contains('min-h-12')).toBe(true)
    }
  })
})

describe('the end of the queue', () => {
  it('says all sorted after the last card, and Check again starts a fresh queue', async () => {
    const { fx } = setup({ groups: serve(groupsResponse([CAFE])) })
    await firstCard()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(screen.getByRole('heading', { name: 'All sorted' })).not.toBeNull()

    fx.handlers.groups = serve(groupsResponse([BAKERY, FUEL]))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    await waitFor(() => expect(merchant()).toBe('EXAMPLE BAKERY'))
    expect(progress()).toBe('1 / 2')
  })

  it('says all sorted when nothing is uncategorised', async () => {
    setup({ groups: serve(groupsResponse([])) })

    expect(
      await screen.findByRole('heading', { name: 'All sorted' }),
    ).not.toBeNull()
    expect(
      screen.getByText('Nothing is uncategorised in this scope.'),
    ).not.toBeNull()
  })
})

describe('loading and errors', () => {
  it('shows a loading state until the groups arrive', () => {
    setup({ groups: () => undefined })

    expect(screen.getByRole('status').textContent).toBe(
      'Loading uncategorised transactions…',
    )
  })

  it('shows the server’s text and Try again when the read fails', async () => {
    const { fx } = setup({
      groups: () => ({ status: 500, body: { error: 'categorise input invalid' } }),
    })

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('categorise input invalid')).not.toBeNull()

    fx.handlers.groups = serve(groupsResponse())
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(merchant()).toBe('EXAMPLE CAFE'))
  })
})

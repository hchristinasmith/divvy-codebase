import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { overviewFixture } from '../../Overview/__tests__/fixtures.ts'
import type { BudgetsResponse, Scope } from '../../../../shared/contracts.ts'
import Budgets from '../index.tsx'
import {
  GROUPS,
  budget,
  installFetch,
  response,
  type FetchCall,
  type Handler,
} from './fixtures.ts'

// The Budgets screen (prd-02, issue 53). Every budgets request goes through
// the real client/apis/budgets.ts to a routing fetch stub (./fixtures.ts);
// the overview and the category list are answered by the same stub. The
// sync pill's fetch never settles. Every value is invented, in integer
// cents.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const LIST = '/api/v1/budgets'
const OVERVIEW = '/api/v1/overview'
const budgetPath = (id: string) => `/api/v1/budgets/${id}`

const CREATE_KEYS = ['category', 'limitCents', 'scope']

// Left: 4520 of 15000 is 30%.
const GROCERIES = budget()
// Near: 8500 of 10000 is 85%, so amber while still left.
const CAFES = budget({
  id: '8',
  category: 'Cafes and restaurants',
  limitCents: 10000,
  spentCents: 8500,
  remainingCents: 1500,
  overCents: 0,
  note: null,
})
// Over: 6230 of 5000.
const SOFTWARE = budget({
  id: '9',
  scope: 'strawb',
  category: 'Business software and cloud services',
  limitCents: 5000,
  spentCents: 6230,
  remainingCents: 0,
  overCents: 1230,
  note: 'Invented: hosting and tools',
})

const THREE = response({ items: [GROCERIES, CAFES, SOFTWARE] })

function serve(body: BudgetsResponse): Handler {
  return () => ({ body })
}

/** Answers GET /overview for the requested scope, with `daysToPayday` set. */
function overviewWith(daysToPayday: number): Handler {
  return (call: FetchCall) => {
    const scope = (call.url.searchParams.get('scope') ?? 'all') as Scope
    return { body: overviewFixture(scope, { safeToSpend: { daysToPayday } }) }
  }
}

function setup(
  body: BudgetsResponse | Handler,
  {
    scope = 'all',
    overview = overviewWith(6),
  }: { scope?: Scope; overview?: Handler } = {},
) {
  const fx = installFetch({
    list: typeof body === 'function' ? body : serve(body),
    overview,
    categories: () => ({ body: { items: GROUPS } }),
  })
  const view = renderWithProviders(<Budgets />, { initialScope: scope })
  return { fx, ...view }
}

async function loaded(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Budgets' })
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name })
}

function part(root: HTMLElement, testId: string): HTMLElement {
  return within(root).getByTestId(testId)
}

function names(): string[] {
  return screen.queryAllByTestId('budget-name').map((n) => n.textContent ?? '')
}

function minus(name: string): HTMLButtonElement {
  return screen.getByRole('button', {
    name: `Lower the ${name} limit by $10`,
  }) as HTMLButtonElement
}

function plus(name: string): HTMLButtonElement {
  return screen.getByRole('button', {
    name: `Raise the ${name} limit by $10`,
  }) as HTMLButtonElement
}

function form(): HTMLElement {
  return screen.getByRole('form', { name: 'Add a budget' })
}

function control<T extends HTMLElement>(root: HTMLElement, label: string): T {
  return within(root).getByLabelText(label) as T
}

function type(f: HTMLElement, label: string, value: string): void {
  fireEvent.change(control(f, label), { target: { value } })
}

function scopeToggle(label: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Scope' })).getByRole(
    'button',
    { name: label },
  )
}

/** Opens the add form and waits for its category picker to load. */
async function openAdd(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
  const f = form()
  await waitFor(() =>
    expect(control<HTMLSelectElement>(f, 'Category').disabled).toBe(false),
  )
  return f
}

describe('the cards', () => {
  it('show each budget’s name, status, spent, limit, bar and note from the route', async () => {
    setup(THREE)
    await loaded()

    expect(names()).toEqual([
      'Supermarkets and grocery stores',
      'Cafes and restaurants',
      'Business software and cloud services',
    ])

    const groceries = card('Supermarkets and grocery stores')
    expect(part(groceries, 'budget-status').textContent).toBe('$104.80 left')
    expect(part(groceries, 'budget-spent').textContent).toBe('$45.20')
    expect(part(groceries, 'budget-limit').textContent).toBe('of $150.00')
    expect(part(groceries, 'budget-note').textContent).toBe('Invented: the weekly shop')
    const bar = within(groceries).getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    expect(part(groceries, 'budget-fill').style.width).toBe('30%')

    const software = card('Business software and cloud services')
    expect(part(software, 'budget-status').textContent).toBe('$12.30 over')
    expect(part(software, 'budget-spent').textContent).toBe('$62.30')
    expect(part(software, 'budget-limit').textContent).toBe('of $50.00')
    // Clamped: a bar never runs past its track.
    expect(part(software, 'budget-fill').style.width).toBe('100%')

    expect(part(card('Cafes and restaurants'), 'budget-note').textContent).toBe('')
  })

  it.each([
    ['Supermarkets and grocery stores', 'left', 'text-ok', 'bg-pink'],
    ['Cafes and restaurants', 'near', 'text-warn', 'bg-warn'],
    ['Business software and cloud services', 'over', 'text-danger', 'bg-danger'],
  ])('colour %s as %s: green, amber past 80%%, red over', async (name, tone, text, fill) => {
    setup(THREE)
    await loaded()

    const status = part(card(name), 'budget-status')
    expect(status.dataset.tone).toBe(tone)
    expect(status.className.split(' ')).toContain(text)
    expect(part(card(name), 'budget-fill').className.split(' ')).toContain(fill)
  })

  it('reads the status from the route, so spent exactly at the limit is $0.00 left in amber', async () => {
    setup(
      response({
        items: [
          budget({ limitCents: 5000, spentCents: 5000, remainingCents: 0, overCents: 0 }),
        ],
      }),
    )
    await loaded()

    const status = part(card('Supermarkets and grocery stores'), 'budget-status')
    expect(status.textContent).toBe('$0.00 left')
    expect(status.dataset.tone).toBe('near')
  })

  it('asks for the chosen scope', async () => {
    const { fx } = setup(THREE, { scope: 'strawb' })
    await loaded()

    expect(fx.callsTo('GET', LIST).map((c) => c.url.searchParams.get('scope'))).toEqual([
      'strawb',
    ])
  })
})

describe('the − / + buttons', () => {
  it('+ sends the limit plus $10 as limitCents, then refetches the budgets and the overview', async () => {
    const { fx, client } = setup(THREE)
    fx.handlers.update = () => ({ status: 200, body: { ...GROCERIES, limitCents: 16000 } })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    // Another scope's overview, cached but not on screen.
    client.setQueryData(['overview', 'strawb'], overviewFixture('strawb'))
    fx.handlers.list = serve(
      response({ items: [{ ...GROCERIES, limitCents: 16000, remainingCents: 11480 }, CAFES, SOFTWARE] }),
    )

    fireEvent.click(plus('Supermarkets and grocery stores'))

    await waitFor(() => expect(fx.callsTo('PATCH', budgetPath('7'))).toHaveLength(1))
    const [body] = fx.bodiesTo('PATCH', budgetPath('7'))
    expect(Object.keys(body)).toEqual(['limitCents'])
    expect(body.limitCents).toBe(16000)

    await waitFor(() =>
      expect(part(card('Supermarkets and grocery stores'), 'budget-limit').textContent).toBe(
        'of $160.00',
      ),
    )
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2)
    expect(client.getQueryState(['overview', 'strawb'])?.isInvalidated).toBe(true)
  })

  it('− sends the limit minus $10 and refetches the overview', async () => {
    const { fx } = setup(THREE)
    fx.handlers.update = () => ({ status: 200, body: CAFES })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))

    fireEvent.click(minus('Cafes and restaurants'))

    await waitFor(() => expect(fx.callsTo('PATCH', budgetPath('8'))).toHaveLength(1))
    expect(fx.bodiesTo('PATCH', budgetPath('8'))).toEqual([{ limitCents: 9000 }])
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2))
  })

  it('− stops at $10: from $15 it sends $10, and at $10 it is disabled', async () => {
    const { fx } = setup(
      response({
        items: [
          budget({ id: '1', category: 'Bakeries', limitCents: 1500, spentCents: 0, remainingCents: 1500, note: null }),
          budget({ id: '2', category: 'Cafes and restaurants', limitCents: 1000, spentCents: 0, remainingCents: 1000, note: null }),
        ],
      }),
    )
    fx.handlers.update = () => ({ status: 200, body: budget() })
    await loaded()

    expect(minus('Cafes and restaurants').disabled).toBe(true)
    expect(plus('Cafes and restaurants').disabled).toBe(false)

    fireEvent.click(minus('Bakeries'))
    await waitFor(() => expect(fx.callsTo('PATCH', budgetPath('1'))).toHaveLength(1))
    expect(fx.bodiesTo('PATCH', budgetPath('1'))).toEqual([{ limitCents: 1000 }])
  })

  it('disables every step while a write is in flight, and sends one PATCH for a double click', async () => {
    const { fx } = setup(THREE)
    // The PATCH never settles.
    fx.handlers.update = () => undefined
    await loaded()

    fireEvent.click(plus('Cafes and restaurants'))
    fireEvent.click(plus('Cafes and restaurants'))

    await waitFor(() => expect(plus('Cafes and restaurants').disabled).toBe(true))
    expect(plus('Supermarkets and grocery stores').disabled).toBe(true)
    expect(minus('Supermarkets and grocery stores').disabled).toBe(true)
    expect(fx.callsTo('PATCH', budgetPath('8'))).toHaveLength(1)
  })

  it("shows the server's refusal, and reads the budgets again but not the overview", async () => {
    const { fx } = setup(THREE)
    fx.handlers.update = () => ({ status: 404, body: { error: 'Budget not found' } })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))

    fireEvent.click(plus('Cafes and restaurants'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Budget not found')
    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1)
  })
})

describe('the add form', () => {
  it('offers the server’s categories, without Drawings, and a scope only in All', async () => {
    setup(THREE)
    await loaded()
    const f = await openAdd()

    const select = control<HTMLSelectElement>(f, 'Category')
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'Bakeries',
      'Supermarkets and grocery stores',
      'Cafes and restaurants',
    ])
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
      'Food',
      'Lifestyle',
    ])
    expect(control<HTMLSelectElement>(f, 'Scope').value).toBe('personal')
  })

  it('posts integer cents and the three fields, refetches, closes and shows the new card', async () => {
    const created = budget({
      id: '20',
      scope: 'strawb',
      category: 'Bakeries',
      limitCents: 12050,
      spentCents: 0,
      remainingCents: 12050,
      note: null,
    })
    const { fx } = setup(THREE)
    fx.handlers.create = () => ({ status: 201, body: created })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    const f = await openAdd()
    fx.handlers.list = serve(response({ items: [...THREE.items, created] }))

    type(f, 'Category', 'Bakeries')
    type(f, 'Limit ($)', '120.50')
    type(f, 'Scope', 'strawb')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('POST', LIST)).toHaveLength(1))
    const [body] = fx.bodiesTo('POST', LIST)
    expect(Object.keys(body).sort()).toEqual(CREATE_KEYS)
    expect(body).toEqual({ scope: 'strawb', category: 'Bakeries', limitCents: 12050 })
    expect(Number.isInteger(body.limitCents)).toBe(true)

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a budget' })).toBeNull())
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2)
    expect(names()).toContain('Bakeries')
  })

  it('sends the note when one is typed, and the chosen scope when not in All', async () => {
    const { fx } = setup(THREE, { scope: 'personal' })
    fx.handlers.create = () => ({ status: 201, body: GROCERIES })
    await loaded()
    const f = await openAdd()

    expect(within(f).queryByLabelText('Scope')).toBeNull()
    expect(within(f).getByText('Added to Personal budgets')).not.toBeNull()
    type(f, 'Category', 'Bakeries')
    type(f, 'Limit ($)', '40')
    type(f, 'Note', '  Invented: Friday buns  ')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('POST', LIST)).toHaveLength(1))
    const [body] = fx.bodiesTo('POST', LIST)
    expect(Object.keys(body).sort()).toEqual([...CREATE_KEYS, 'note'].sort())
    expect(body).toEqual({
      scope: 'personal',
      category: 'Bakeries',
      limitCents: 4000,
      note: 'Invented: Friday buns',
    })
  })

  it('refuses a missing category and a non-amount before sending anything', async () => {
    const { fx } = setup(THREE)
    await loaded()
    const f = await openAdd()

    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))
    expect(within(f).getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'Choose a category',
      'Required',
    ])

    type(f, 'Category', 'Bakeries')
    type(f, 'Limit ($)', 'lots')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))
    expect(within(f).getByRole('alert').textContent).toBe(
      'Enter dollars and cents, like 1049.99',
    )
    expect(fx.callsTo('POST', LIST)).toHaveLength(0)
  })

  it("shows the server's duplicate refusal and keeps what was typed", async () => {
    const { fx } = setup(THREE)
    fx.handlers.create = () => ({
      status: 409,
      body: { error: 'A budget for that category already exists in this scope' },
    })
    await loaded()
    const f = await openAdd()

    type(f, 'Category', 'Cafes and restaurants')
    type(f, 'Limit ($)', '80')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    const alert = await within(f).findByRole('alert')
    expect(alert.textContent).toBe(
      'A budget for that category already exists in this scope',
    )
    expect(form()).toBe(f)
    expect(control<HTMLSelectElement>(f, 'Category').value).toBe('Cafes and restaurants')
    expect(control<HTMLInputElement>(f, 'Limit ($)').value).toBe('80')
  })
})

describe('delete', () => {
  it('asks first, then deletes and refetches the budgets and the overview', async () => {
    const { fx } = setup(THREE)
    fx.handlers.remove = () => ({ status: 204 })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Delete the Cafes and restaurants budget' }))
    const cafes = card('Cafes and restaurants')
    expect(within(cafes).getByText('Delete the “Cafes and restaurants” budget?')).not.toBeNull()
    expect(fx.callsTo('DELETE', budgetPath('8'))).toHaveLength(0)
    fx.handlers.list = serve(response({ items: [GROCERIES, SOFTWARE] }))

    fireEvent.click(within(cafes).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(names()).not.toContain('Cafes and restaurants'))
    expect(fx.callsTo('DELETE', budgetPath('8'))).toHaveLength(1)
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2)
  })

  it('Keep backs out without a request', async () => {
    const { fx } = setup(THREE)
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Delete the Cafes and restaurants budget' }))
    fireEvent.click(within(card('Cafes and restaurants')).getByRole('button', { name: 'Keep' }))

    expect(
      screen.getByRole('button', { name: 'Delete the Cafes and restaurants budget' }),
    ).not.toBeNull()
    expect(fx.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it("shows the server's refusal on the card", async () => {
    const { fx } = setup(THREE)
    fx.handlers.remove = () => ({ status: 404, body: { error: 'Budget not found' } })
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Delete the Cafes and restaurants budget' }))
    const cafes = card('Cafes and restaurants')
    fireEvent.click(within(cafes).getByRole('button', { name: 'Delete' }))

    const alert = await within(cafes).findByRole('alert')
    expect(alert.textContent).toBe('Budget not found')
  })
})

describe('what the PRD overrides', () => {
  it.each([
    ['with budgets', THREE],
    ['with none', response({ items: [] })],
  ])('neither says Claude sets budgets nor offers Ask why, %s', async (_label, body) => {
    setup(body)
    await screen.findByRole('button', { name: 'Add budget' })

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/Claude/i)
    expect(text).not.toMatch(/owns budget/i)
    expect(text).not.toMatch(/Ask why/i)
    expect(text).not.toMatch(/Advisor/i)
  })
})

describe('the subtitle', () => {
  it("counts the days from the overview's daysToPayday, not from the period", async () => {
    // The period ends 3 Nov, six days on from its start; the server says 4.
    setup(THREE, { overview: overviewWith(4) })

    expect(await screen.findByText('Resets on payday · 4 days left')).not.toBeNull()
  })

  it('says 1 day in the singular', async () => {
    setup(THREE, { overview: overviewWith(1) })

    expect(await screen.findByText('Resets on payday · 1 day left')).not.toBeNull()
  })

  it("shows the period's end until the overview has loaded", async () => {
    setup(THREE, { overview: () => undefined })
    await loaded()

    expect(screen.getByText('Resets on payday · 3 Nov')).not.toBeNull()
  })

  it('asks the overview for the chosen scope', async () => {
    const { fx } = setup(THREE, { scope: 'personal' })
    await screen.findByText('Resets on payday · 6 days left')

    expect(fx.callsTo('GET', OVERVIEW).map((c) => c.url.searchParams.get('scope'))).toEqual([
      'personal',
    ])
  })
})

describe('states', () => {
  it('shows a loading card until the budgets arrive', async () => {
    setup(() => undefined)

    expect((await screen.findByRole('status')).textContent).toBe('Loading your budgets…')
    // The overview can answer before the budgets do.
    expect(await screen.findByText('Resets on payday · 6 days left')).not.toBeNull()
    expect(screen.getByRole('status')).not.toBeNull()
  })

  it('shows the empty state with the add button', async () => {
    setup(response({ items: [] }))

    expect(await screen.findByText('No budgets yet')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Budgets' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(form()).not.toBeNull()
  })

  it('a failed first fetch shows the message and Try again reads again', async () => {
    let fail = true
    const { fx } = setup(() =>
      fail
        ? { status: 500, body: { error: 'Could not read the budgets' } }
        : { body: THREE },
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not read the budgets')
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(names()).toHaveLength(3)
  })

  it('a failed refetch keeps the last budgets with a banner', async () => {
    const { fx, client } = setup(THREE)
    await loaded()
    fx.handlers.list = () => ({ status: 500, body: { error: 'Internal server error' } })

    await client.refetchQueries({ queryKey: ['budgets'] })

    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain("Couldn't refresh. Showing the last budgets.")
    expect(names()).toHaveLength(3)
  })

  it('a scope switch shows that scope’s budgets, never the previous ones', async () => {
    const { fx } = setup((call) =>
      call.url.searchParams.get('scope') === 'strawb'
        ? { body: response({ items: [SOFTWARE] }) }
        : { body: THREE },
    )
    await loaded()

    fireEvent.click(scopeToggle('Strawb'))

    await waitFor(() => expect(names()).toEqual(['Business software and cloud services']))
    expect(fx.callsTo('GET', LIST).map((c) => c.url.searchParams.get('scope'))).toEqual([
      'all',
      'strawb',
    ])
  })
})

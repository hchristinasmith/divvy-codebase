import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { overviewQuery } from '../../../apis/overview.ts'
import { grabSettingsAccounts } from '../../../apis/settings.ts'
import { queryKeys } from '../../../apis/queryKeys.ts'
import type { BillsResponse, Scope } from '../../../../shared/contracts.ts'
import Bills from '../index.tsx'
import {
  ACCOUNTS,
  bill,
  installFetch,
  response,
  type Handler,
} from './fixtures.ts'

// The Bills screen (prd-02, issue 54). Every bills request goes through the
// real client/apis/bills.ts to a routing fetch stub (./fixtures.ts); the
// account list for the picker is mocked, as the Settings tests do. The sync
// pill's fetch never settles. Every value is invented, in integer cents.

vi.mock('../../../apis/settings.ts', () => ({ grabSettingsAccounts: vi.fn() }))

beforeEach(() => {
  vi.mocked(grabSettingsAccounts).mockResolvedValue(ACCOUNTS)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const LIST = '/api/v1/bills'
const OVERVIEW = '/api/v1/overview'
const billPath = (id: string) => `/api/v1/bills/${id}`
const payPath = (id: string) => `/api/v1/bills/${id}/payments`

const CREATE_KEYS = ['amountCents', 'firstDueDate', 'name', 'repeat', 'scope']

const POWER = bill()
const HOSTING = bill({
  id: '13',
  scope: 'strawb',
  name: 'Invented Hosting',
  amountCents: 2500,
  dueDate: '2026-11-03',
  firstDueDate: '2025-11-03',
  repeat: 'yearly',
  accountName: null,
})
const WATER = bill({
  id: '14',
  name: 'Invented Water',
  amountCents: 4550,
  dueDate: '2026-11-20',
  firstDueDate: '2026-10-23',
  repeat: 'weekly',
})
const RATES = bill({
  id: '15',
  name: 'Invented Rates',
  amountCents: 80000,
  dueDate: '2026-10-15',
  firstDueDate: '2026-10-15',
  repeat: 'none',
  paid: true,
  paidAt: '2026-10-14T01:00:00.000Z',
})

const FOUR = response({ items: [POWER, HOSTING, WATER, RATES] })

function serve(body: BillsResponse): Handler {
  return () => ({ body })
}

// Reads the overview through its one query definition, as the Overview
// screen and the nav badge do, so a test can see it refetch.
function OverviewProbe() {
  useQuery(overviewQuery('all'))
  return null
}

function setup(
  body: BillsResponse | Handler,
  { scope = 'all', probe = false }: { scope?: Scope; probe?: boolean } = {},
) {
  const fx = installFetch({
    list: typeof body === 'function' ? body : serve(body),
    overview: () => ({ body: {} }),
  })
  const view = renderWithProviders(
    <>
      <Bills />
      {probe && <OverviewProbe />}
    </>,
    { initialScope: scope },
  )
  return { fx, ...view }
}

async function loaded(): Promise<void> {
  await screen.findByRole('region', { name: 'Bills' })
}

function list(): HTMLElement {
  return screen.getByRole('region', { name: 'Bills' })
}

/** The list's row for one bill. */
function row(id: string): HTMLElement {
  const li = list().querySelector<HTMLElement>(`[data-bill-id="${id}"]`)
  if (!li) throw new Error(`no row ${id}`)
  return li
}

function names(): string[] {
  return within(list())
    .queryAllByTestId('bill-name')
    .map((n) => n.textContent ?? '')
}

function payButton(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name: `Mark ${name} paid` }) as HTMLButtonElement
}

function payButtons(): HTMLButtonElement[] {
  return screen.queryAllByRole<HTMLButtonElement>('button', { name: /^Mark .* paid$/ })
}

function form(name: string): HTMLElement {
  return screen.getByRole('form', { name })
}

function control<T extends HTMLElement>(root: HTMLElement, label: string): T {
  return within(root).getByLabelText(label) as T
}

function type(f: HTMLElement, label: string, value: string): void {
  fireEvent.change(control(f, label), { target: { value } })
}

function optionTexts(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.textContent ?? '')
}

function scopeToggle(label: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Scope' })).getByRole(
    'button',
    { name: label },
  )
}

/** Opens the add form and waits for its account picker to load. */
async function openAdd(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
  const f = form('Add a bill')
  await waitFor(() =>
    expect(control<HTMLSelectElement>(f, 'Paid from').disabled).toBe(false),
  )
  return f
}

async function openEdit(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` }))
  const f = form(`Edit ${name}`)
  await waitFor(() =>
    expect(control<HTMLSelectElement>(f, 'Paid from').disabled).toBe(false),
  )
  return f
}

function fillAdd(f: HTMLElement): void {
  type(f, 'Name', 'Invented Broadband')
  type(f, 'Amount ($)', '1,200.50')
  type(f, 'First due date', '2026-11-15')
  type(f, 'Repeat', 'weekly')
}

describe('the tiles', () => {
  it("show the route's figures, not a sum of the rows", async () => {
    setup(FOUR)
    await loaded()

    expect(screen.getByTestId('tile-due').textContent).toBe('$987.65')
    expect(screen.getByTestId('tile-paid').textContent).toBe('$43.21')
    expect(screen.getByTestId('tile-next').textContent).toBe('$1,200.00 · 1 Nov')
    expect(screen.getByText('$987.65 due before payday')).not.toBeNull()
  })

  it("read the next one from the route's nextBill, not the first row", async () => {
    setup(response({ items: [POWER, WATER], nextBill: WATER }))
    await loaded()
    expect(screen.getByTestId('tile-next').textContent).toBe('$45.50 · 20 Nov')
    cleanup()

    setup(response({ items: [POWER, WATER], nextBill: null }))
    await loaded()
    expect(screen.getByTestId('tile-next').textContent).toBe('None')
  })

  it.each([
    ['all', true],
    ['strawb', true],
    ['personal', false],
  ] as const)(
    'in %s, says the due figure includes the Strawb pot\'s bills: %s',
    async (scope, shown) => {
      setup(FOUR, { scope })
      await loaded()

      const caption = screen.queryByText('Includes bills the Strawb tax pot covers.')
      expect(caption !== null).toBe(shown)
    },
  )
})

describe('the rows', () => {
  it('keep the order the route sent', async () => {
    setup(response({ items: [WATER, HOSTING, POWER, RATES] }))
    await loaded()

    expect(names()).toEqual([
      'Invented Water',
      'Invented Hosting',
      'Invented Power Co',
      'Invented Rates',
    ])
  })

  it('show the due day and month, name, meta line and amount', async () => {
    setup(FOUR)
    await loaded()

    const power = row('12')
    const date = within(power).getByTestId('bill-date')
    expect([...date.children].map((c) => c.textContent)).toEqual(['1', 'Nov'])
    expect(within(power).getByTestId('bill-name').textContent).toBe('Invented Power Co')
    expect(within(power).getByTestId('bill-meta').textContent).toBe(
      'Personal · Test Everyday · Monthly',
    )
    expect(within(power).getByTestId('bill-amount').textContent).toBe('$1,200.00')
    expect(within(row('13')).getByTestId('bill-meta').textContent).toBe(
      'Strawb · Yearly',
    )
  })

  it('colour the next two unpaid date tiles pink, later ones blush, a paid one canvas', async () => {
    setup(FOUR)
    await loaded()

    const tile = (id: string) => within(row(id)).getByTestId('bill-date').classList
    expect(tile('12').contains('bg-pink')).toBe(true)
    expect(tile('13').contains('bg-pink')).toBe(true)
    expect(tile('14').contains('bg-blush')).toBe(true)
    expect(tile('14').contains('bg-pink')).toBe(false)
    expect(tile('15').contains('bg-canvas')).toBe(true)
  })

  it('dim and strike a paid one-off, with a disabled Paid pill and no Edit', async () => {
    setup(FOUR)
    await loaded()

    const rates = row('15')
    expect(rates.classList.contains('opacity-55')).toBe(true)
    expect(
      within(rates).getByTestId('bill-name').classList.contains('line-through'),
    ).toBe(true)
    const paid = within(rates).getByRole('button', { name: 'Paid' }) as HTMLButtonElement
    expect(paid.disabled).toBe(true)
    expect(within(rates).queryByRole('button', { name: /Mark/ })).toBeNull()
    expect(within(rates).queryByRole('button', { name: /Edit/ })).toBeNull()
  })

  it('leave an unpaid row clear, with Mark paid and Edit', async () => {
    setup(FOUR)
    await loaded()

    const power = row('12')
    expect(power.classList.contains('opacity-55')).toBe(false)
    expect(
      within(power).getByTestId('bill-name').classList.contains('line-through'),
    ).toBe(false)
    expect(payButton('Invented Power Co').disabled).toBe(false)
    expect(payButton('Invented Power Co').textContent).toBe('Mark paid')
    expect(within(power).queryByRole('button', { name: 'Paid' })).toBeNull()
    expect(
      within(power).getByRole('button', { name: 'Edit Invented Power Co' }),
    ).not.toBeNull()
  })
})

describe('Mark paid', () => {
  const ONE_OFF = bill({ repeat: 'none', firstDueDate: '2026-11-01' })

  it('posts with no body, then refetches the bills and the overview', async () => {
    const { fx } = setup(response({ items: [ONE_OFF] }), { probe: true })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    fx.handlers.pay = () => ({
      status: 201,
      body: { bill: { ...ONE_OFF, paid: true } },
    })
    fx.handlers.list = serve(
      response({
        items: [{ ...ONE_OFF, paid: true, paidAt: '2026-10-28T00:00:00.000Z' }],
        nextBill: null,
      }),
    )

    fireEvent.click(payButton('Invented Power Co'))

    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2))
    const posts = fx.callsTo('POST', payPath('12'))
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toBeUndefined()
    const lists = fx.calls.filter((c) => c.method === 'GET' && c.url.pathname === LIST)
    expect(lists).toHaveLength(2)
    expect(fx.calls.indexOf(posts[0])).toBeLessThan(fx.calls.indexOf(lists[1]))

    const paid = await within(list()).findByRole('button', { name: 'Paid' })
    expect((paid as HTMLButtonElement).disabled).toBe(true)
    expect(row('12').classList.contains('opacity-55')).toBe(true)
  })

  it('changes nothing and holds every pill and form button until the refetch lands', async () => {
    const { fx } = setup(FOUR)
    await loaded()
    const f = await openEdit('Invented Water')
    fx.handlers.pay = () => ({ status: 201, body: { bill: POWER } })
    // The refetch after the write never settles.
    fx.handlers.list = () => undefined

    fireEvent.click(payButton('Invented Power Co'))

    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect(payButton('Invented Power Co').textContent).toBe('Mark paid')
    expect(row('12').classList.contains('opacity-55')).toBe(false)
    expect(payButtons().length).toBeGreaterThan(0)
    for (const button of payButtons()) expect(button.disabled).toBe(true)
    for (const label of ['Save', 'Cancel', 'Delete bill']) {
      const button = within(f).getByRole('button', { name: label }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    }

    fireEvent.click(payButton('Invented Power Co'))
    expect(fx.callsTo('POST', payPath('12'))).toHaveLength(1)
  })

  it('pays once for two clicks that land before the pill re-renders', async () => {
    const { fx } = setup(response({ items: [POWER] }))
    await loaded()
    fx.handlers.pay = () => ({ status: 201, body: { bill: POWER } })

    // Both in one task: React has not yet drawn the pill disabled.
    fireEvent.click(payButton('Invented Power Co'))
    fireEvent.click(payButton('Invented Power Co'))

    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect(fx.callsTo('POST', payPath('12'))).toHaveLength(1)
  })

  it('shows a repeating bill on its next due date, still to pay', async () => {
    const { fx } = setup(response({ items: [POWER] }))
    await loaded()
    const next = { ...POWER, dueDate: '2026-12-01' }
    fx.handlers.pay = () => ({ status: 201, body: { bill: next } })
    fx.handlers.list = serve(response({ items: [next] }))

    fireEvent.click(payButton('Invented Power Co'))

    await waitFor(() =>
      expect(
        [...within(row('12')).getByTestId('bill-date').children].map(
          (c) => c.textContent,
        ),
      ).toEqual(['1', 'Dec']),
    )
    expect(payButton('Invented Power Co').textContent).toBe('Mark paid')
    expect(within(list()).queryByRole('button', { name: 'Paid' })).toBeNull()
  })

  it("shows a refusal, and reads the bills again but not the overview", async () => {
    const { fx } = setup(FOUR, { probe: true })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    fx.handlers.pay = () => ({
      status: 409,
      body: { error: 'This bill is already paid' },
    })

    fireEvent.click(payButton('Invented Power Co'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This bill is already paid')
    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1)
  })
})

describe('the add form', () => {
  it('offers exactly the four repeats the schema has', async () => {
    setup(FOUR)
    await loaded()
    const f = await openAdd()

    const repeat = control<HTMLSelectElement>(f, 'Repeat')
    expect([...repeat.options].map((o) => o.value)).toEqual([
      'none',
      'weekly',
      'monthly',
      'yearly',
    ])
    expect(optionTexts(repeat)).toEqual(['One-off', 'Weekly', 'Monthly', 'Yearly'])
  })

  it('in All, asks which scope, Personal first', async () => {
    setup(FOUR)
    await loaded()
    const f = await openAdd()

    const scope = control<HTMLSelectElement>(f, 'Scope')
    expect(scope.value).toBe('personal')
    expect(optionTexts(scope)).toEqual(['Personal', 'Strawb'])
  })

  it('in Strawb, adds to Strawb without asking', async () => {
    const { fx } = setup(response({ items: [HOSTING] }), { scope: 'strawb' })
    fx.handlers.create = () => ({ status: 201, body: HOSTING })
    await loaded()
    const f = await openAdd()

    expect(within(f).queryByLabelText('Scope')).toBeNull()
    expect(within(f).getByText('Added to Strawb bills')).not.toBeNull()
    fillAdd(f)
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('POST', LIST)).toHaveLength(1))
    expect(fx.bodiesTo('POST', LIST)[0].scope).toBe('strawb')
  })

  it("lists only the form scope's accounts, and starts over when the scope changes", async () => {
    const { fx } = setup(FOUR)
    fx.handlers.create = () => ({ status: 201, body: HOSTING })
    await loaded()
    const f = await openAdd()

    const account = control<HTMLSelectElement>(f, 'Paid from')
    expect(optionTexts(account)).toEqual(['No account', 'Test Everyday', 'Test Savings'])
    fireEvent.change(account, { target: { value: '2' } })
    expect(account.value).toBe('2')

    type(f, 'Scope', 'strawb')

    expect(optionTexts(account)).toEqual(['No account', 'Test Trading'])
    expect(account.value).toBe('')
    // The select shows "No account" either way; the request says what was kept.
    fillAdd(f)
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fx.callsTo('POST', LIST)).toHaveLength(1))
    const [body] = fx.bodiesTo('POST', LIST)
    expect(body.scope).toBe('strawb')
    expect('accountId' in body).toBe(false)
  })

  it('stays open, saying so, until the refetch after the write lands', async () => {
    const { fx } = setup(FOUR)
    fx.handlers.create = () => ({ status: 201, body: POWER })
    await loaded()
    const f = await openAdd()
    // The refetch after the write never settles.
    fx.handlers.list = () => undefined

    fillAdd(f)
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect(form('Add a bill')).toBe(f)
    const saving = within(f).getByRole('button', { name: 'Saving…' }) as HTMLButtonElement
    expect(saving.disabled).toBe(true)
    expect(control<HTMLInputElement>(f, 'Name').disabled).toBe(true)
  })

  it('sends integer cents and the five fields, refetches, closes and shows the new row', async () => {
    const created = bill({
      id: '20',
      name: 'Invented Broadband',
      amountCents: 120050,
      dueDate: '2026-11-15',
      firstDueDate: '2026-11-15',
      repeat: 'weekly',
      accountName: null,
    })
    const { fx } = setup(FOUR, { probe: true })
    fx.handlers.create = () => ({ status: 201, body: created })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    const f = await openAdd()
    fx.handlers.list = serve(response({ items: [POWER, HOSTING, created, WATER, RATES] }))

    fillAdd(f)
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('POST', LIST)).toHaveLength(1))
    const [body] = fx.bodiesTo('POST', LIST)
    expect(Object.keys(body).sort()).toEqual(CREATE_KEYS)
    expect(body).toEqual({
      scope: 'personal',
      name: 'Invented Broadband',
      amountCents: 120050,
      firstDueDate: '2026-11-15',
      repeat: 'weekly',
    })
    expect(Number.isInteger(body.amountCents)).toBe(true)

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a bill' })).toBeNull())
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2)
    expect(names()).toContain('Invented Broadband')
  })

  it('adds the chosen account as its string id', async () => {
    const { fx } = setup(FOUR)
    fx.handlers.create = () => ({ status: 201, body: POWER })
    await loaded()
    const f = await openAdd()

    fillAdd(f)
    type(f, 'Paid from', '1')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('POST', LIST)).toHaveLength(1))
    const [body] = fx.bodiesTo('POST', LIST)
    expect(Object.keys(body).sort()).toEqual([...CREATE_KEYS, 'accountId'].sort())
    expect(body.accountId).toBe('1')
  })

  it('refuses a blank form, a zero and a non-amount before sending anything', async () => {
    const { fx } = setup(FOUR)
    await loaded()
    const f = await openAdd()

    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    const errors = within(f).getAllByRole('alert').map((a) => a.textContent)
    expect(errors).toEqual(['Required', 'Required', 'Required'])
    expect(control<HTMLInputElement>(f, 'Name').getAttribute('aria-invalid')).toBe('true')

    type(f, 'Name', 'Invented Broadband')
    type(f, 'First due date', '2026-11-15')
    type(f, 'Amount ($)', '0')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))
    expect(within(f).getByRole('alert').textContent).toBe('Must be more than 0')

    type(f, 'Amount ($)', 'abc')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))
    expect(within(f).getByRole('alert').textContent).toBe(
      'Enter dollars and cents, like 1049.99',
    )
    expect(fx.callsTo('POST', LIST)).toHaveLength(0)
  })

  it("shows the server's refusal and keeps what was typed", async () => {
    const { fx } = setup(FOUR)
    fx.handlers.create = () => ({
      status: 400,
      body: { error: 'That schedule leaves too many unpaid occurrences' },
    })
    await loaded()
    const f = await openAdd()

    fillAdd(f)
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    const alert = await within(f).findByRole('alert')
    expect(alert.textContent).toBe('That schedule leaves too many unpaid occurrences')
    expect(form('Add a bill')).toBe(f)
    expect(control<HTMLInputElement>(f, 'Name').value).toBe('Invented Broadband')
    expect(control<HTMLInputElement>(f, 'Amount ($)').value).toBe('1,200.50')
  })
})

describe('the edit form', () => {
  it('starts from the bill, keeps the current account, and has no scope', async () => {
    setup(FOUR)
    await loaded()
    const f = await openEdit('Invented Power Co')

    expect(control<HTMLInputElement>(f, 'Name').value).toBe('Invented Power Co')
    expect(control<HTMLInputElement>(f, 'Amount ($)').value).toBe('1200.00')
    expect(control<HTMLInputElement>(f, 'First due date').value).toBe('2026-10-01')
    expect(control<HTMLSelectElement>(f, 'Repeat').value).toBe('monthly')
    const account = control<HTMLSelectElement>(f, 'Paid from')
    expect(account.selectedOptions[0].textContent).toBe('Keep current (Test Everyday)')
    expect(optionTexts(account)).toEqual([
      'Keep current (Test Everyday)',
      'No account',
      'Test Everyday',
      'Test Savings',
    ])
    expect(within(f).queryByLabelText('Scope')).toBeNull()
    const save = within(f).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    type(f, 'Name', 'Invented Power Ltd')
    expect(save.disabled).toBe(false)
  })

  it('offers one No account when the bill has none', async () => {
    setup(FOUR)
    await loaded()
    const f = await openEdit('Invented Hosting')

    expect(optionTexts(control(f, 'Paid from'))).toEqual(['No account', 'Test Trading'])
  })

  it('sends only the amount when only the amount changed, then refetches the bills and the overview', async () => {
    const edited = { ...POWER, amountCents: 125000 }
    const { fx } = setup(FOUR, { probe: true })
    fx.handlers.update = () => ({ body: edited })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    const f = await openEdit('Invented Power Co')
    fx.handlers.list = serve(response({ items: [edited, HOSTING, WATER, RATES] }))

    type(f, 'Amount ($)', '1250.00')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('PATCH', billPath('12'))).toHaveLength(1))
    const [body] = fx.bodiesTo('PATCH', billPath('12'))
    expect(Object.keys(body)).toEqual(['amountCents'])
    expect(body.amountCents).toBe(125000)
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Edit Invented Power Co' })).toBeNull(),
    )
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2)
    expect(within(row('12')).getByTestId('bill-amount').textContent).toBe('$1,250.00')
  })

  it('closes without sending anything when the retyped amount is the same bill', async () => {
    const { fx } = setup(FOUR)
    // Answered, so a PATCH sent anyway would still close the form and only
    // the call count can tell.
    fx.handlers.update = () => ({ body: POWER })
    await loaded()
    const f = await openEdit('Invented Power Co')

    type(f, 'Amount ($)', '1200')
    const save = within(f).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Edit Invented Power Co' })).toBeNull(),
    )
    expect(fx.callsTo('PATCH', billPath('12'))).toHaveLength(0)
  })

  it.each([
    ['another account', '2', { accountId: '2' }],
    ['no account', 'none', { accountId: null }],
  ])('sends the account when %s is picked', async (_label, value, expected) => {
    const { fx } = setup(FOUR)
    fx.handlers.update = () => ({ body: POWER })
    await loaded()
    const f = await openEdit('Invented Power Co')

    type(f, 'Paid from', value)
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fx.callsTo('PATCH', billPath('12'))).toHaveLength(1))
    const [body] = fx.bodiesTo('PATCH', billPath('12'))
    expect(Object.keys(body)).toEqual(['accountId'])
    expect(body).toEqual(expected)
  })

  it("shows the server's refusal and stays open", async () => {
    const { fx } = setup(FOUR)
    fx.handlers.update = () => ({
      status: 409,
      body: {
        error: 'Bill has payments, so its first due date and repeat cannot be changed',
      },
    })
    await loaded()
    const f = await openEdit('Invented Power Co')

    type(f, 'Repeat', 'yearly')
    fireEvent.click(within(f).getByRole('button', { name: 'Save' }))

    const alert = await within(f).findByRole('alert')
    expect(alert.textContent).toBe(
      'Bill has payments, so its first due date and repeat cannot be changed',
    )
    expect(form('Edit Invented Power Co')).toBe(f)
    expect(control<HTMLSelectElement>(f, 'Repeat').value).toBe('yearly')
  })
})

describe('deleting', () => {
  it('asks first, and Keep sends nothing', async () => {
    const { fx } = setup(FOUR)
    await loaded()
    const f = await openEdit('Invented Water')

    fireEvent.click(within(f).getByRole('button', { name: 'Delete bill' }))

    expect(within(f).getByText("Delete “Invented Water”? This can't be undone.")).not.toBeNull()
    expect(fx.callsTo('DELETE', billPath('14'))).toHaveLength(0)
    fireEvent.click(within(f).getByRole('button', { name: 'Keep' }))
    expect(within(f).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(within(f).getByRole('button', { name: 'Delete bill' })).not.toBeNull()
    expect(fx.callsTo('DELETE', billPath('14'))).toHaveLength(0)
  })

  it('deletes on confirm, then refetches the bills and the overview', async () => {
    const { fx } = setup(FOUR, { probe: true })
    fx.handlers.remove = () => ({ status: 204 })
    await loaded()
    await waitFor(() => expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1))
    const f = await openEdit('Invented Water')
    fx.handlers.list = serve(response({ items: [POWER, HOSTING, RATES] }))

    fireEvent.click(within(f).getByRole('button', { name: 'Delete bill' }))
    fireEvent.click(within(f).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(names()).not.toContain('Invented Water'))
    expect(fx.callsTo('DELETE', billPath('14'))).toHaveLength(1)
    expect(fx.callsTo('DELETE', billPath('14'))[0].body).toBeUndefined()
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("shows the server's refusal in the form", async () => {
    const { fx } = setup(FOUR)
    fx.handlers.remove = () => ({
      status: 409,
      body: { error: 'Bill has payments, so it cannot be deleted' },
    })
    await loaded()
    const f = await openEdit('Invented Power Co')

    fireEvent.click(within(f).getByRole('button', { name: 'Delete bill' }))
    fireEvent.click(within(f).getByRole('button', { name: 'Delete' }))

    const alert = await within(f).findByRole('alert')
    expect(alert.textContent).toBe('Bill has payments, so it cannot be deleted')
    expect(names()).toContain('Invented Water')
  })
})

describe('one form at a time', () => {
  it('opening Add closes an edit, and opening an edit closes Add', async () => {
    setup(FOUR)
    await loaded()
    await openEdit('Invented Power Co')

    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))

    expect(screen.queryByRole('form', { name: 'Edit Invented Power Co' })).toBeNull()
    expect(form('Add a bill')).not.toBeNull()
    expect(names()).toContain('Invented Power Co')

    fireEvent.click(screen.getByRole('button', { name: 'Edit Invented Water' }))

    expect(screen.queryByRole('form', { name: 'Add a bill' })).toBeNull()
    expect(form('Edit Invented Water')).not.toBeNull()
  })

  it('Cancel closes the form and sends nothing', async () => {
    const { fx } = setup(FOUR)
    await loaded()
    const f = await openAdd()
    fillAdd(f)

    fireEvent.click(within(f).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form', { name: 'Add a bill' })).toBeNull()
    expect(fx.callsTo('POST', LIST)).toHaveLength(0)
  })
})

describe('the screen states', () => {
  it('says it is loading until the bills arrive', async () => {
    setup(() => undefined)

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Loading your bills…')
    expect(screen.queryByRole('region', { name: 'Bills' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Upcoming bills')
  })

  it("shows the server's error with Try again, which reads again", async () => {
    const { fx } = setup(() => ({ status: 500, body: { error: 'Could not list bills' } }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not list bills')
    fx.handlers.list = serve(FOUR)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(names()).toHaveLength(4)
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
  })

  it('keeps the last bills with a banner when a refetch fails', async () => {
    const { fx, client } = setup(FOUR)
    await loaded()
    fx.handlers.list = () => ({ status: 500, body: { error: 'Could not list bills' } })

    await act(() => client.invalidateQueries({ queryKey: queryKeys.bills.all }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't refresh. Showing the last bills.")
    expect(names()).toHaveLength(4)
    expect(screen.getByTestId('tile-due').textContent).toBe('$987.65')
  })

  it("says so when there are none, and the tiles still show the route's figures", async () => {
    setup(
      response({
        items: [],
        dueBeforePaydayCents: 0,
        nextBill: null,
        paidThisMonthCents: 2500,
      }),
    )
    await loaded()

    expect(
      screen.getByText('No bills yet. Use Add bill to add the first one.'),
    ).not.toBeNull()
    expect(screen.getByTestId('tile-due').textContent).toBe('$0.00')
    expect(screen.getByTestId('tile-next').textContent).toBe('None')
    expect(screen.getByTestId('tile-paid').textContent).toBe('$25.00')
    expect(screen.getByRole('button', { name: 'Add bill' })).not.toBeNull()
  })

  it("reads the new scope on a switch and never shows the old scope's bills", async () => {
    const { fx } = setup(
      (call) =>
        call.url.searchParams.get('scope') === 'strawb'
          ? undefined
          : { body: response({ items: [POWER] }) },
      { scope: 'personal' },
    )
    await loaded()
    expect(names()).toEqual(['Invented Power Co'])

    fireEvent.click(scopeToggle('Strawb'))

    await screen.findByRole('status')
    expect(screen.queryByRole('region', { name: 'Bills' })).toBeNull()
    const scopes = fx.callsTo('GET', LIST).map((c) => c.url.searchParams.get('scope'))
    expect(scopes).toEqual(['personal', 'strawb'])
  })

  it('drops an open form and a pay refusal when the scope changes', async () => {
    // Personal is read first so it is cached: switching back shows its list
    // at once, so only the body's key can drop the form and the message.
    const { fx } = setup(
      (call) => ({
        body:
          call.url.searchParams.get('scope') === 'strawb'
            ? response({ items: [HOSTING] })
            : response({ items: [POWER, WATER] }),
      }),
      { scope: 'personal' },
    )
    await loaded()
    fireEvent.click(scopeToggle('Strawb'))
    await waitFor(() => expect(names()).toEqual(['Invented Hosting']))
    fireEvent.click(scopeToggle('Personal'))
    await waitFor(() => expect(names()).toEqual(['Invented Power Co', 'Invented Water']))
    fx.handlers.pay = () => ({ status: 404, body: { error: 'Bill not found' } })
    fireEvent.click(payButton('Invented Power Co'))
    await screen.findByText('Bill not found')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    expect(form('Add a bill')).not.toBeNull()

    fireEvent.click(scopeToggle('Strawb'))
    await waitFor(() => expect(names()).toEqual(['Invented Hosting']))
    fireEvent.click(scopeToggle('Personal'))

    await waitFor(() => expect(names()).toEqual(['Invented Power Co', 'Invented Water']))
    expect(screen.queryByText('Bill not found')).toBeNull()
    expect(screen.queryByRole('form', { name: 'Add a bill' })).toBeNull()
  })
})

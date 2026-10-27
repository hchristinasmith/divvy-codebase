import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { grabSettings } from '../../../apis/settings.ts'
import { invalidateOverview } from '../../../apis/queryKeys.ts'
import ShellSidebar from '../../../components/Shell/ShellSidebar.tsx'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import {
  formatCents,
  parseDollars,
  sumCents,
} from '../../../../shared/money.ts'
import type { Scope, SettingsResponse } from '../../../../shared/contracts.ts'
import Overview from '../index.tsx'
import {
  BILL_OVERDUE,
  BILL_SOON,
  BUSINESS,
  BUSINESS_POT,
  CAFE_ROW,
  CARD_ACCOUNT,
  EVERYDAY,
  GROUPS,
  INCOME_ROW,
  OVER_BUDGET,
  installFetch,
  overviewByScope,
  overviewFixture,
  type OverviewOverrides,
} from './fixtures.ts'

// The Overview screen (prd-02, issue 45). One describe per Done-when line
// in the issue. The overview, dismiss, categories and category-edit
// requests go through the real client/apis/overview.ts to a routing fetch
// stub (./fixtures.ts); settings are read with superagent, so that module
// is mocked. The sync pill's fetch never settles. Every value is invented.

vi.mock('../../../apis/settings.ts', () => ({ grabSettings: vi.fn() }))
const grab = vi.mocked(grabSettings)

const SETTINGS: SettingsResponse = {
  taxRateBasisPoints: 2500,
  profitCents: 1000000,
  paydayWeekday: 2,
  personalTaxOwedCents: 0,
  currency: '$',
}

const NEW_CATEGORY = 'Supermarkets and grocery stores'

beforeEach(() => {
  grab.mockResolvedValue(SETTINGS)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

function setup(
  initialScope: Scope = 'all',
  overrides: Partial<Record<Scope, OverviewOverrides>> = {},
) {
  const fx = installFetch({
    overview: overviewByScope(overrides),
    categories: () => ({ body: { items: GROUPS } }),
  })
  const view = renderWithProviders(<Overview />, { initialScope })
  return { fx, ...view }
}

async function hero(): Promise<string> {
  return (await screen.findByTestId('hero-amount')).textContent ?? ''
}

function ledger(key: string): string {
  const value = document.querySelector(`[data-ledger="${key}"] dd`)
  if (!value) throw new Error(`no ledger row ${key}`)
  return value.textContent ?? ''
}

function scopeToggle(label: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Scope' })).getByRole(
    'button',
    { name: label },
  )
}

function filterPills(): HTMLElement[] {
  return within(
    screen.getByRole('group', { name: 'Activity filter' }),
  ).getAllByRole('button')
}

function activityRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-activity-id="${id}"]`)
  if (!row) throw new Error(`no activity row ${id}`)
  return row
}

function shownRowScopes(): string[] {
  return [...document.querySelectorAll('[data-activity-id]')].map(
    (row) => row.getAttribute('data-scope') ?? '',
  )
}

describe('the hero shows exactly the safeCents the server sent', () => {
  it('shows safeCents even when the parts do not add up to it', async () => {
    // The parts add up to 555000; the server says 123457. A client that
    // recomputed from the parts would show $5,550.00. There is no
    // goal-contribution field in the contract, so safeCents is the hero's
    // only input (prd-02 Ruling 5).
    setup('all', { all: { safeToSpend: { safeCents: 123457 } } })

    expect(await hero()).toBe('$1,234.57')
    // perDayCents stays the fixture's 92500; a client that divided
    // safeCents by the days itself would show $205.76.
    expect(screen.getByTestId('hero-per-day').textContent).toBe(
      '$925.00 a day for the next 6 days',
    )
  })

  it('shows the per-day line and the payday when the result is positive', async () => {
    setup()

    expect(await hero()).toBe('$5,550.00')
    expect(screen.getByTestId('hero-per-day').textContent).toBe(
      '$925.00 a day for the next 6 days',
    )
    expect(screen.queryByTestId('hero-short-by')).toBeNull()
    expect(screen.getByText(/until payday on 3 Nov · after tax/)).not.toBeNull()
  })

  it('sets the bar to safeCents as a share of liquidCents', async () => {
    setup()
    await hero()

    const bar = screen.getByRole('progressbar', { name: /Safe to spend/ })
    expect(bar.getAttribute('aria-valuenow')).toBe('65')
  })

  it('leaves the bar empty when nothing is liquid', async () => {
    setup('all', {
      all: { safeToSpend: { liquidCents: 0, safeCents: 0, perDayCents: 0 } },
    })
    await hero()

    const bar = screen.getByRole('progressbar', { name: /Safe to spend/ })
    expect(bar.getAttribute('aria-valuenow')).toBe('0')
  })

  it('lists every ledger line the server sent, and they add up to the hero', async () => {
    setup()
    const shown = parseDollars(await hero())

    expect(ledger('liquid')).toBe('$8,500.00')
    expect(ledger('tax')).toBe('$1,000.00')
    expect(ledger('bills')).toBe('$1,200.00')
    expect(ledger('budgets')).toBe('$300.00')
    expect(ledger('cards')).toBe('$450.00')
    expect(ledger('safe')).toBe('$5,550.00')
    const taken = ['tax', 'bills', 'budgets', 'cards'].map((k) =>
      parseDollars(ledger(k)),
    )
    expect(parseDollars(ledger('liquid')) - sumCents(taken)).toBe(shown)
  })
})

describe('a negative result shows $0 and a short-by line (Ruling 3)', () => {
  it('clamps the hero and says how short it is', async () => {
    // shortByCents deliberately differs from −safeCents: a client that
    // worked the shortfall out from safeCents would show $42.50.
    setup('all', {
      all: {
        safeToSpend: { safeCents: -4250, shortByCents: 4321, perDayCents: -709 },
      },
    })

    expect(await hero()).toBe('$0.00')
    expect(screen.getByTestId('hero-short-by').textContent).toBe(
      'short by $43.21',
    )
    expect(screen.queryByTestId('hero-per-day')).toBeNull()
    expect(document.body.textContent).not.toContain('-$7.09')
    // The ledger keeps the sign, so its column still adds up.
    expect(ledger('safe')).toBe('-$42.50')
  })
})

describe('switching scope changes every card (handoff "Scope toggle")', () => {
  it('in Personal shows the Personal card and hides Strawb and Tax', async () => {
    setup('personal')
    await hero()

    expect(screen.getByTestId('accounts-personal')).not.toBeNull()
    expect(screen.queryByTestId('accounts-strawb')).toBeNull()
    expect(screen.queryByTestId('tax-card')).toBeNull()
    expect(screen.queryByText('Tax set-aside')).toBeNull()
    expect(filterPills().map((b) => b.textContent)).toEqual(['Personal'])
    expect(shownRowScopes().every((s) => s === 'personal')).toBe(true)
  })

  it('in Strawb shows Strawb and Tax and hides Personal', async () => {
    setup('strawb')
    await hero()

    expect(screen.queryByTestId('accounts-personal')).toBeNull()
    expect(screen.getByTestId('accounts-strawb')).not.toBeNull()
    expect(screen.getByTestId('tax-card')).not.toBeNull()
    expect(filterPills().map((b) => b.textContent)).toEqual(['Strawb'])
  })

  it('in All shows every card and every filter pill', async () => {
    setup('all')
    await hero()

    expect(screen.getByTestId('accounts-personal')).not.toBeNull()
    expect(screen.getByTestId('accounts-strawb')).not.toBeNull()
    expect(screen.getByTestId('tax-card')).not.toBeNull()
    expect(filterPills().map((b) => b.textContent)).toEqual([
      'All',
      'Personal',
      'Strawb',
    ])
  })

  it('never shows a personal account under Strawb, even if the route sent one', async () => {
    setup('strawb', {
      strawb: { accounts: [EVERYDAY, CARD_ACCOUNT, BUSINESS, BUSINESS_POT] },
    })
    await hero()

    expect(document.body.textContent).not.toContain(EVERYDAY.name)
    expect(document.body.textContent).not.toContain(CARD_ACCOUNT.name)
    expect(document.body.textContent).toContain(BUSINESS.name)
  })

  it('asks for the new scope and shows no old figure while it loads', async () => {
    const { fx } = setup('all')
    expect(await hero()).toBe('$5,550.00')
    const answer = overviewByScope()
    fx.handlers.overview = (call) =>
      call.url.searchParams.get('scope') === 'strawb' ? undefined : answer(call)

    fireEvent.click(scopeToggle('Strawb'))

    await screen.findByRole('status')
    const gets = fx.callsTo('GET', '/api/v1/overview')
    expect(gets.at(-1)?.url.searchParams.get('scope')).toBe('strawb')
    expect(screen.queryByTestId('hero-amount')).toBeNull()
    expect(document.body.textContent).not.toContain('$5,550.00')
    expect(screen.getByRole('status').textContent).toBe('Loading your overview…')
  })

  it("shows the new scope's numbers once they arrive", async () => {
    setup('all')
    await hero()

    fireEvent.click(scopeToggle('Strawb'))

    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,000.00'),
    )
    expect(screen.queryByTestId('accounts-personal')).toBeNull()
  })
})

describe('the activity sub-filter', () => {
  it('in All, Personal shows only personal rows', async () => {
    setup('all')
    await hero()
    expect(shownRowScopes().sort()).toEqual(['personal', 'personal', 'strawb'])

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Activity filter' })).getByRole(
        'button',
        { name: 'Personal' },
      ),
    )

    expect(shownRowScopes()).toEqual(['personal', 'personal'])
  })

  it('resets to the scope whenever the scope changes', async () => {
    setup('all')
    await hero()
    // Load Strawb once, so later switches render from the cache without
    // the loading card in between and the card stays mounted.
    fireEvent.click(scopeToggle('Strawb'))
    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,000.00'),
    )
    fireEvent.click(scopeToggle('All'))
    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,550.00'),
    )
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Activity filter' })).getByRole(
        'button',
        { name: 'Personal' },
      ),
    )

    fireEvent.click(scopeToggle('Strawb'))
    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,000.00'),
    )
    expect(
      filterPills().map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([['Strawb', 'true']])
    expect(shownRowScopes()).toEqual(['strawb'])

    fireEvent.click(scopeToggle('All'))
    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,550.00'),
    )
    const pressed = filterPills().filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    )
    expect(pressed.map((b) => b.textContent)).toEqual(['All'])
  })

  it('draws the filter with the shared pill shape: semibold, with the pink focus outline', async () => {
    setup('all')
    await hero()
    const pills = filterPills()
    expect(pills.map((b) => b.textContent)).toEqual(['All', 'Personal', 'Strawb'])
    for (const pill of pills) {
      expect(pill.classList.contains('font-semibold')).toBe(true)
      expect(pill.classList.contains('font-medium')).toBe(false)
      expect(pill.classList.contains('focus-visible:outline-pink')).toBe(true)
    }
  })
})

describe('no Owed to you, invoice, Xero or estimated line (Ruling 4)', () => {
  it.each(['all', 'personal', 'strawb'] as const)(
    'renders none in %s',
    async (scope) => {
      setup(scope)
      await hero()
      await screen.findAllByLabelText(/^Category for /)

      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/owed to you|xero|invoice|estimated|~\$/i)
      expect(text).not.toContain('~')
    },
  )
})

describe('an invalidation of the overview key refetches the hero', () => {
  it('shows the new number after invalidateOverview, with no reload', async () => {
    const { fx, client } = setup('all')
    expect(await hero()).toBe('$5,550.00')

    fx.handlers.overview = overviewByScope({
      all: { safeToSpend: { safeCents: 777700 } },
    })
    await act(() => invalidateOverview(client))

    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$7,777.00'),
    )
  })
})

describe("a date from another year than today's shows its year", () => {
  function alertText(id: string): string {
    const row = document.querySelector<HTMLElement>(`[data-alert-id="${id}"]`)
    if (!row) throw new Error(`no alert ${id}`)
    return row.textContent ?? ''
  }

  function paydayLine(): string {
    return screen.getByText(/until payday on/).textContent ?? ''
  }

  it('shows the year on a payday in another year', async () => {
    setup('all', {
      all: { safeToSpend: { today: '2026-12-29', nextPayday: '2027-01-01' } },
    })
    await hero()

    expect(paydayLine()).toContain('until payday on 1 Jan\u00a02027 · after tax')
  })

  it('leaves the year off a payday in this year', async () => {
    setup('all', {
      all: { safeToSpend: { today: '2026-12-29', nextPayday: '2026-12-31' } },
    })
    await hero()

    expect(paydayLine()).toContain('until payday on 31 Dec · after tax')
  })

  it('shows the year on an alert due in another year, and none on this year', async () => {
    setup('all', {
      all: {
        alerts: [
          {
            ...BILL_OVERDUE,
            id: 'bill_overdue:5:2025-12-18',
            subject: 'Old Invented',
            dueDate: '2025-12-18',
          },
          BILL_SOON,
          {
            ...BILL_SOON,
            id: 'bill_due_soon:6:2027-01-04',
            subject: 'New Invented',
            dueDate: '2027-01-04',
          },
        ],
      },
    })
    await hero()

    expect(alertText('bill_overdue:5:2025-12-18')).toContain(
      'Old Invented ($18.00) is overdue, due 18 Dec\u00a02025.',
    )
    expect(alertText(BILL_SOON.id)).toContain(
      'Rent Invented ($1,200.00) is due 30 Oct.',
    )
    expect(alertText(BILL_SOON.id)).not.toContain('30 Oct\u00a02026')
    expect(alertText('bill_due_soon:6:2027-01-04')).toContain(
      'New Invented ($1,200.00) is due 4 Jan\u00a02027.',
    )
  })

  it('shows the year on an activity row dated in another year, and none on this year', async () => {
    setup('all', {
      all: {
        recentActivity: [
          { ...CAFE_ROW, id: '201', date: '2025-12-30' },
          { ...INCOME_ROW, id: '202', date: '2026-10-20' },
          { ...INCOME_ROW, id: '203', date: '2027-01-02' },
        ],
      },
    })
    await hero()

    // getByText's default normalizer folds U+00A0 into a space, so the
    // exact separator is pinned on textContent.
    expect(
      within(activityRow('201')).getByText('30 Dec 2025').textContent,
    ).toBe('30 Dec\u00a02025')
    expect(within(activityRow('202')).getByText('20 Oct')).not.toBeNull()
    expect(
      within(activityRow('203')).getByText('2 Jan 2027').textContent,
    ).toBe('2 Jan\u00a02027')
  })

  it("takes this year from the server's today, not the browser's clock or the last payday", async () => {
    // The server's today is in 2027; the browser's clock (pinned here, in
    // Auckland too) and the last payday are in 2026. An alert and a row
    // dated in 2026 show their year only if the cards read
    // safeToSpend.today. Only Date is faked, so react-query keeps real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T23:00:00Z'))
    setup('all', {
      all: {
        safeToSpend: {
          today: '2027-01-04',
          lastPayday: '2026-12-29',
          nextPayday: '2027-01-05',
        },
        alerts: [BILL_SOON],
        recentActivity: [CAFE_ROW],
      },
    })
    await hero()

    expect(paydayLine()).toContain('until payday on 5 Jan · after tax')
    expect(alertText(BILL_SOON.id)).toContain(
      'Rent Invented ($1,200.00) is due 30 Oct\u00a02026.',
    )
    expect(
      within(activityRow(CAFE_ROW.id)).getByText('21 Oct 2026').textContent,
    ).toBe('21 Oct\u00a02026')
  })
})

describe('the account and tax cards', () => {
  it('totals the Personal card from the balances shown, card debt included', async () => {
    setup('all')
    await hero()
    const card = screen.getByTestId('accounts-personal')

    expect(within(card).getByTestId('accounts-total').textContent).toBe(
      formatCents(sumCents([EVERYDAY.balanceCents, CARD_ACCOUNT.balanceCents])),
    )
    expect(within(card).getByText(EVERYDAY.name)).not.toBeNull()
    expect(within(card).getByText('-$450.00')).not.toBeNull()
    expect(within(card).getByText('Credit card')).not.toBeNull()
    expect(within(card).queryByText(BUSINESS.name)).toBeNull()
  })

  it('shows the Strawb tax pot as a tile on the Strawb card', async () => {
    setup('strawb')
    await hero()
    const card = screen.getByTestId('accounts-strawb')

    expect(within(card).getByTestId('accounts-total').textContent).toBe(
      '$7,500.00',
    )
    expect(within(card).getByText(BUSINESS_POT.name)).not.toBeNull()
    expect(within(card).getByText('Tax pot')).not.toBeNull()
  })

  it('says when an account has no role', async () => {
    setup('personal', {
      personal: { accounts: [{ ...EVERYDAY, role: null }] },
    })
    await hero()

    expect(screen.getByText('No role set')).not.toBeNull()
  })

  it('shows the pot, what is owed, the shortfall and the rate', async () => {
    // A bills buffer makes the server's hold 250000 − (150000 − 20000), not
    // owed − pot: a client that subtracted the two itself would show $1,000.00.
    setup('strawb', {
      strawb: {
        safeToSpend: { strawbBillsBufferCents: 20000, strawbTaxHoldCents: 120000 },
      },
    })
    await hero()
    const card = screen.getByTestId('tax-card')

    expect(within(card).getByTestId('tax-pot').textContent).toBe('$1,500.00')
    expect(within(card).getByTestId('tax-owed').textContent).toBe(
      'of $2,500.00 owed so far',
    )
    expect(within(card).getByTestId('tax-short').textContent).toBe(
      '$1,200.00 short',
    )
    expect((await within(card).findByTestId('tax-rate')).textContent).toBe(
      '25% of profit',
    )
    expect(
      within(card).getByRole('progressbar').getAttribute('aria-valuenow'),
    ).toBe('60')
  })

  it('leaves the shortfall out when nothing is held', async () => {
    setup('strawb', { strawb: { safeToSpend: { strawbTaxHoldCents: 0 } } })
    await hero()

    expect(screen.queryByTestId('tax-short')).toBeNull()
  })

  it('leaves the rate label out when settings cannot be read', async () => {
    grab.mockRejectedValue(new Error('Server error (500)'))
    setup('strawb')
    await hero()
    await waitFor(() => expect(grab).toHaveBeenCalled())
    await act(async () => {})

    expect(screen.queryByTestId('tax-rate')).toBeNull()
    expect(screen.getByTestId('tax-pot').textContent).toBe('$1,500.00')
  })
})

describe('alerts: dot, text, link, dismiss, badge and empty state', () => {
  function alertRow(id: string): HTMLElement {
    const row = document.querySelector<HTMLElement>(`[data-alert-id="${id}"]`)
    if (!row) throw new Error(`no alert ${id}`)
    return row
  }

  it('shows each kind with its dot, text and link', async () => {
    setup('all')
    await hero()

    const over = alertRow(OVER_BUDGET.id)
    expect(over.querySelector('[data-alert-kind]')?.className).toContain(
      'bg-danger',
    )
    expect(over.textContent).toContain(
      'Cafes and restaurants is $30.00 over budget.',
    )
    const overLink = within(over).getByRole('link')
    expect(overLink.textContent).toBe('See budget')
    expect(overLink.getAttribute('href')).toBe('/budgets')

    const soon = alertRow(BILL_SOON.id)
    expect(soon.querySelector('[data-alert-kind]')?.className).toContain(
      'bg-warn',
    )
    expect(soon.textContent).toContain('Rent Invented ($1,200.00) is due 30 Oct.')
    expect(within(soon).getByRole('link').getAttribute('href')).toBe('/bills')
    expect(within(soon).getByRole('link').textContent).toBe('View bills')

    const overdue = alertRow(BILL_OVERDUE.id)
    expect(overdue.querySelector('[data-alert-kind]')?.className).toContain(
      'bg-warn',
    )
    expect(overdue.textContent).toContain(
      'Hosting Invented ($18.00) is overdue, due 18 Oct.',
    )

    expect(screen.getByTestId('alerts-open').textContent).toBe('3 open')
  })

  it('dismisses through the route, then drops the row on the refetch', async () => {
    const { fx } = setup('all')
    await hero()
    let dismissed = false
    fx.handlers.dismiss = () => {
      dismissed = true
      return {
        body: { id: OVER_BUDGET.id, dismissedAt: '2026-10-28T00:00:00.000Z' },
      }
    }
    fx.handlers.overview = overviewByScope({
      get all() {
        return dismissed ? { alerts: [BILL_SOON, BILL_OVERDUE] } : {}
      },
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss: Cafes and restaurants is $30.00 over budget.',
      }),
    )

    await waitFor(() =>
      expect(
        document.querySelector(`[data-alert-id="${OVER_BUDGET.id}"]`),
      ).toBeNull(),
    )
    const posts = fx.calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.url.pathname)).toEqual([
      '/api/v1/overview/alerts/over_budget%3A12%3A2026-10-20/dismiss',
    ])
    expect(screen.getByTestId('alerts-open').textContent).toBe('2 open')
  })

  it("shows the server's message when a dismissal fails, and keeps the row", async () => {
    const { fx } = setup('all')
    await hero()
    fx.handlers.dismiss = () => ({
      status: 500,
      body: { error: 'Could not dismiss alert' },
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss: Cafes and restaurants is $30.00 over budget.',
      }),
    )

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not dismiss alert',
    )
    expect(alertRow(OVER_BUDGET.id)).not.toBeNull()
    expect(fx.callsTo('GET', '/api/v1/overview')).toHaveLength(1)
  })

  it("drops a failed dismissal's message when the scope changes", async () => {
    const { fx } = setup('all')
    await hero()
    // Load Strawb once, so the switch back renders from the cache and the
    // alerts card would stay mounted without its scope key.
    fireEvent.click(scopeToggle('Strawb'))
    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,000.00'),
    )
    fireEvent.click(scopeToggle('All'))
    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,550.00'),
    )
    fx.handlers.dismiss = () => ({
      status: 404,
      body: { error: 'Alert not found' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss: Cafes and restaurants is $30.00 over budget.',
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Alert not found',
    )

    fireEvent.click(scopeToggle('Strawb'))

    await waitFor(() =>
      expect(screen.getByTestId('hero-amount').textContent).toBe('$5,000.00'),
    )
    expect(screen.queryByRole('alert')?.textContent ?? null).toBeNull()
  })

  it('says all clear when there are none', async () => {
    setup('all', { all: { alerts: [] } })
    await hero()

    expect(
      screen.getByText('All clear. Nothing needs you right now.'),
    ).not.toBeNull()
    expect(screen.getByTestId('alerts-open').textContent).toBe('')
  })

  it('keeps the nav badge equal to the alerts listed, from one request', async () => {
    const fx = installFetch({
      overview: overviewByScope(),
      categories: () => ({ body: { items: GROUPS } }),
    })
    renderWithProviders(
      <>
        <ShellSidebar />
        <Overview />
      </>,
    )
    await hero()

    expect(screen.getByTestId('nav-badge').textContent).toBe('3')
    expect(document.querySelectorAll('[data-alert-id]')).toHaveLength(3)
    expect(fx.callsTo('GET', '/api/v1/overview')).toHaveLength(1)

    let dismissed = false
    fx.handlers.dismiss = () => {
      dismissed = true
      return {
        body: { id: OVER_BUDGET.id, dismissedAt: '2026-10-28T00:00:00.000Z' },
      }
    }
    fx.handlers.overview = overviewByScope({
      get all() {
        return dismissed ? { alerts: [BILL_SOON, BILL_OVERDUE] } : {}
      },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss: Cafes and restaurants is $30.00 over budget.',
      }),
    )

    await waitFor(() =>
      expect(screen.getByTestId('nav-badge').textContent).toBe('2'),
    )
    expect(document.querySelectorAll('[data-alert-id]')).toHaveLength(2)
  })
})

describe('inline category edit', () => {
  it('sends the chosen category to the update route and shows it as yours', async () => {
    const { fx } = setup('all')
    await hero()
    let saved = false
    fx.handlers.patch = () => {
      saved = true
      return { body: { transaction: { id: 101 } } }
    }
    fx.handlers.overview = overviewByScope({
      get all(): OverviewOverrides {
        return saved
          ? {
              recentActivity: [
                { ...CAFE_ROW, category: NEW_CATEGORY, categorySource: 'user' },
              ],
            }
          : {}
      },
    })
    const picker = await screen.findByLabelText<HTMLSelectElement>(
      'Category for Cafe Invented',
    )
    expect(picker.value).toBe('Cafes and restaurants')

    fireEvent.change(picker, { target: { value: NEW_CATEGORY } })

    await waitFor(() =>
      expect(
        activityRow(CAFE_ROW.id)
          .querySelector('[data-category-source]')
          ?.getAttribute('data-category-source'),
      ).toBe('user'),
    )
    const patches = fx.calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0].url.pathname).toBe('/api/v1/transactions/101')
    const body = JSON.parse(patches[0].body ?? 'null') as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['category'])
    expect(body).toStrictEqual({ category: NEW_CATEGORY })
    const source = activityRow(CAFE_ROW.id).querySelector(
      '[data-category-source]',
    )
    expect(source?.textContent).toBe('You')
    expect(source?.className).toContain('bg-blush')
    expect(
      screen.getByLabelText<HTMLSelectElement>('Category for Cafe Invented')
        .value,
    ).toBe(NEW_CATEGORY)
  })

  it('shows who set the category on every row', async () => {
    setup('all')
    await hero()

    const rows = document.querySelectorAll('[data-activity-id]')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const source = row.querySelector('[data-category-source]')
      expect(source?.textContent).toBe('Akahu')
      // Only a user-set category gets the blush chip; these are not user rows.
      expect(source?.className).not.toContain('bg-blush')
    }
  })

  it("shows the server's message under the row when the edit is refused", async () => {
    const { fx } = setup('all')
    await hero()
    fx.handlers.patch = () => ({
      status: 400,
      body: { error: 'category must be one of GET /api/v1/categories' },
    })
    const picker = await screen.findByLabelText<HTMLSelectElement>(
      'Category for Cafe Invented',
    )

    fireEvent.change(picker, { target: { value: NEW_CATEGORY } })

    const alert = await within(activityRow(CAFE_ROW.id)).findByRole('alert')
    expect(alert.textContent).toBe(
      'category must be one of GET /api/v1/categories',
    )
    expect(fx.callsTo('GET', '/api/v1/overview')).toHaveLength(1)
    expect(
      screen.getByLabelText<HTMLSelectElement>('Category for Cafe Invented')
        .value,
    ).toBe('Cafes and restaurants')
  })

  it('cannot recategorise a pending row', async () => {
    const { fx } = setup('all')
    await hero()
    const picker = await screen.findByLabelText<HTMLSelectElement>(
      'Category for Shop Invented',
    )

    expect(picker.disabled).toBe(true)
    expect(activityRow('103').textContent).toContain('Pending')
    fireEvent.change(picker, { target: { value: NEW_CATEGORY } })
    // The PATCH is sent asynchronously, so flush before asserting none was sent:
    // this wait is what lets the test catch a missing pending guard.
    await act(async () => {})
    expect(fx.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })

  it('turns editing off and says so when categories cannot be read', async () => {
    installFetch({
      overview: overviewByScope(),
      categories: () => ({ status: 500, body: { error: 'boom' } }),
    })
    renderWithProviders(<Overview />)
    await hero()

    expect(
      await screen.findByText("Couldn't load categories. Editing is off."),
    ).not.toBeNull()
    expect(screen.queryByLabelText('Category for Cafe Invented')).toBeNull()
    expect(
      within(activityRow(CAFE_ROW.id)).getByTestId('category-text').textContent,
    ).toBe('Cafes and restaurants')
  })
})

describe('loading, empty and error states', () => {
  it('shows a loading message while the overview is on its way', () => {
    installFetch({})
    renderWithProviders(<Overview />)

    expect(screen.getByRole('status').textContent).toBe('Loading your overview…')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it("shows the server's message and recovers on Try again", async () => {
    const fx = installFetch({
      overview: () => ({ status: 500, body: { error: 'boom' } }),
      categories: () => ({ body: { items: GROUPS } }),
    })
    renderWithProviders(<Overview />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
    fx.handlers.overview = overviewByScope()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await hero()).toBe('$5,550.00')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the last numbers and says so when a refetch fails', async () => {
    const { fx, client } = setup('all')
    expect(await hero()).toBe('$5,550.00')

    fx.handlers.overview = () => ({ status: 500, body: { error: 'boom' } })
    await act(() => invalidateOverview(client))

    const banner = await screen.findByText(
      "Couldn't refresh. Showing the last numbers.",
    )
    expect(banner.closest('[role="alert"]')).not.toBeNull()
    expect(screen.getByTestId('hero-amount').textContent).toBe('$5,550.00')
  })

  it('says so when there are no accounts or activity', async () => {
    setup('all', { all: { accounts: [], recentActivity: [] } })
    await hero()

    expect(screen.getAllByText('No accounts in this scope yet.')).toHaveLength(2)
    expect(screen.getByText('No recent activity.')).not.toBeNull()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})

describe('the More row on the phone (Ruling 14)', () => {
  it('links Bills, Sort, Subscriptions, Sync and Privacy, hidden at desktop width', async () => {
    setup('all')
    await hero()
    const more = screen.getByRole('navigation', { name: 'More' })

    expect(more.className.split(' ')).toContain('shell:hidden')
    expect(
      within(more)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Bills', '/bills'],
      ['Sort', '/sort'],
      ['Subscriptions', '/subscriptions'],
      ['Sync', '/sync'],
      ['Privacy', '/privacy'],
    ])
  })
})

describe('fixtures', () => {
  it('builds a consistent overview for each scope', () => {
    for (const scope of ['all', 'personal', 'strawb'] as const) {
      const r = overviewFixture(scope).safeToSpend
      expect(
        r.liquidCents -
          r.taxHoldCents -
          r.unpaidBillsCents -
          r.remainingBudgetCents -
          r.cardDebtCents,
      ).toBe(r.safeCents)
    }
  })
})

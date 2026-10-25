import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { overviewQuery } from '../../../apis/overview.ts'
import { queryKeys } from '../../../apis/queryKeys.ts'
import type { GoalsResponse } from '../../../../shared/contracts.ts'
import Goals from '../index.tsx'
import {
  goal,
  goalsResponse,
  installFetch,
  type Handler,
  type Handlers,
} from './fixtures.ts'

// The Goals screen (prd-02, issue 56). Every request goes through the real
// client/apis/goals.ts to a routing fetch stub (./fixtures.ts). The sync
// pill's fetch never settles. Every value is invented.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const LIST = '/api/v1/goals'
const OVERVIEW = '/api/v1/overview'

function contributions(id: string): string {
  return `/api/v1/goals/${id}/contributions`
}

function serve(body: GoalsResponse): Handler {
  return () => ({ body })
}

const HOLIDAY = goal()
const LAPTOP = goal({
  id: '2',
  name: 'Sample Laptop',
  targetCents: 200000,
  savedCents: 250000,
  targetDate: '2026-12-01',
  paceCents: 0,
  monthsToGo: 0,
})
const RAINY_DAY = goal({
  id: '3',
  name: 'Sample Rainy Day',
  targetCents: 100000,
  savedCents: 0,
  targetDate: null,
  paceCents: null,
  monthsToGo: null,
})

function setup(list: GoalsResponse | Handler, handlers: Handlers = {}) {
  const fx = installFetch({
    list: typeof list === 'function' ? list : serve(list),
    ...handlers,
  })
  const view = renderWithProviders(<Goals />)
  return { fx, ...view }
}

async function loaded(): Promise<void> {
  await screen.findByRole('region', { name: 'Goals' })
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name })
}

function text(el: HTMLElement, testId: string): string | null {
  return within(el).queryByTestId(testId)?.textContent ?? null
}

function step(name: string, label: '+$50' | '+$200'): HTMLButtonElement {
  return within(card(name)).getByRole('button', { name: label }) as HTMLButtonElement
}

/** Waits for a write's refetch to land, when the buttons are enabled again. */
async function settled(): Promise<void> {
  await waitFor(() => {
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
  })
}

const CONTRIBUTION_KEYS = ['amountCents']
const CREATE_KEYS = ['name', 'targetCents', 'targetDate']

describe('the goal cards', () => {
  it('shows each name, by-date, saved, target, bar and pace from the route', async () => {
    setup(goalsResponse([HOLIDAY, LAPTOP, RAINY_DAY]))
    await loaded()

    expect(
      screen.getAllByTestId('goal-name').map((n) => n.textContent),
    ).toEqual(['Sample Holiday', 'Sample Laptop', 'Sample Rainy Day'])

    const holiday = card('Sample Holiday')
    expect(text(holiday, 'goal-by')).toBe('by Nov 2027')
    expect(text(holiday, 'goal-saved')).toBe('$1,200.00')
    expect(text(holiday, 'goal-target')).toBe('of $3,000.00')
    expect(text(holiday, 'goal-pace')).toBe('$90.00/mo · 20 months to go')
    expect(
      within(holiday).getByRole('progressbar').getAttribute('aria-valuenow'),
    ).toBe('40')

    const laptop = card('Sample Laptop')
    expect(text(laptop, 'goal-saved')).toBe('$2,500.00')
    expect(text(laptop, 'goal-target')).toBe('of $2,000.00')
    expect(text(laptop, 'goal-pace')).toBe('Funded.')
    expect(
      within(laptop).getByRole('progressbar').getAttribute('aria-valuenow'),
    ).toBe('100')

    const rainy = card('Sample Rainy Day')
    expect(text(rainy, 'goal-by')).toBeNull()
    expect(rainy.textContent).not.toContain('by ')
    expect(text(rainy, 'goal-pace')).toBe('No by-date')
    expect(
      within(rainy).getByRole('progressbar').getAttribute('aria-valuenow'),
    ).toBe('0')
  })

  it('says one month in the singular', async () => {
    setup(goalsResponse([goal({ paceCents: 180000, monthsToGo: 1 })]))
    await loaded()

    expect(text(card('Sample Holiday'), 'goal-pace')).toBe(
      '$1,800.00/mo · 1 month to go',
    )
  })

  it('says a contribution is a record and names no account it comes from', async () => {
    setup(goalsResponse())
    await loaded()

    const main = document.body.textContent ?? ''
    expect(main).toContain(
      "Contributions are records of a transfer you make yourself. Divvy doesn't move money, and recording one doesn't change safe-to-spend.",
    )
    expect(main).not.toContain('Personal · Savings')
    expect(main).not.toContain('Funded from')
    expect(main).not.toContain('with the advisor')
  })
})

describe('+$50 and +$200', () => {
  it.each([
    ['+$50', 5000, 125000, '$1,250.00'],
    ['+$200', 20000, 140000, '$1,400.00'],
  ] as const)(
    '%s records exactly %d cents, reads the list again and shows its saved figure',
    async (label, amountCents, savedAfter, shown) => {
      const after = goal({ savedCents: savedAfter })
      const { fx } = setup(goalsResponse(), {
        contribute: () => ({ status: 201, body: { goal: after } }),
      })
      await loaded()
      fx.handlers.list = serve(goalsResponse([after]))

      fireEvent.click(step('Sample Holiday', label))

      await waitFor(() =>
        expect(text(card('Sample Holiday'), 'goal-saved')).toBe(shown),
      )
      const bodies = fx.bodiesTo('POST', contributions('1'))
      expect(bodies).toEqual([{ amountCents }])
      expect(Object.keys(bodies[0]).sort()).toEqual(CONTRIBUTION_KEYS)
      expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    },
  )

  it('posts to the goal whose button was pressed', async () => {
    const { fx } = setup(goalsResponse([HOLIDAY, RAINY_DAY]), {
      contribute: () => ({ status: 201, body: { goal: RAINY_DAY } }),
    })
    await loaded()

    fireEvent.click(step('Sample Rainy Day', '+$200'))

    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    await settled()
    expect(fx.bodiesTo('POST', contributions('3'))).toEqual([{ amountCents: 20000 }])
    expect(fx.callsTo('POST', contributions('1'))).toEqual([])
  })

  it('records once for a fast double click while the first is in flight', async () => {
    const { fx } = setup(goalsResponse([HOLIDAY, RAINY_DAY]), {
      contribute: () => undefined,
    })
    await loaded()
    const button = step('Sample Holiday', '+$50')

    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(step('Sample Rainy Day', '+$200'))

    await waitFor(() => expect(button.disabled).toBe(true))
    expect(fx.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(step('Sample Holiday', '+$200').disabled).toBe(true)
    expect(step('Sample Rainy Day', '+$50').disabled).toBe(true)
  })

  it('records once for a fast double click that resolves', async () => {
    const after = goal({ savedCents: 125000 })
    const { fx } = setup(goalsResponse(), {
      contribute: () => ({ status: 201, body: { goal: after } }),
    })
    await loaded()
    fx.handlers.list = serve(goalsResponse([after]))
    const button = step('Sample Holiday', '+$50')

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() =>
      expect(text(card('Sample Holiday'), 'goal-saved')).toBe('$1,250.00'),
    )
    await settled()
    expect(fx.callsTo('POST', contributions('1'))).toHaveLength(1)
  })

  it("shows the server's refusal and reads the list again", async () => {
    const { fx } = setup(goalsResponse(), {
      contribute: () => ({ status: 404, body: { error: 'Goal not found' } }),
    })
    await loaded()

    fireEvent.click(step('Sample Holiday', '+$50'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Goal not found')
    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect(text(card('Sample Holiday'), 'goal-saved')).toBe('$1,200.00')
  })

  it('says so when the server cannot be reached', async () => {
    setup(goalsResponse(), {
      contribute: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await loaded()

    fireEvent.click(step('Sample Holiday', '+$200'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The server could not be reached')
  })
})

// prd-02 Ruling 5: a contribution is a record, not a transfer, so the
// Overview's hero must not move. The overview read sits in the same query
// client as the screen, as it does in the app (the sidebar badge reads it on
// every screen).
describe('the Overview after a goal write', () => {
  function OverviewProbe() {
    useQuery(overviewQuery('all'))
    return null
  }

  async function setupWithOverview(handlers: Handlers) {
    const fx = installFetch({
      list: serve(goalsResponse()),
      overview: () => ({ body: { invented: 'overview' } }),
      ...handlers,
    })
    const view = renderWithProviders(
      <>
        <OverviewProbe />
        <Goals />
      </>,
    )
    await loaded()
    const key = overviewQuery('all').queryKey
    await waitFor(() =>
      expect(view.client.getQueryState(key)?.status).toBe('success'),
    )
    const before = view.client.getQueryState(key)?.dataUpdatedAt
    const spy = vi.spyOn(view.client, 'invalidateQueries')
    return { fx, client: view.client, key, before, spy }
  }

  function expectOverviewUntouched(
    fx: ReturnType<typeof installFetch>,
    client: QueryClient,
    key: readonly unknown[],
    before: number | undefined,
    spy: { mock: { calls: unknown[][] } },
  ) {
    expect(fx.callsTo('GET', OVERVIEW)).toHaveLength(1)
    const state = client.getQueryState(key)
    expect(state?.isInvalidated).toBe(false)
    expect(state?.dataUpdatedAt).toBe(before)
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    for (const [filters] of spy.mock.calls) {
      expect((filters as { queryKey?: unknown } | undefined)?.queryKey).toEqual(
        queryKeys.goals.all,
      )
    }
  }

  it('is not invalidated or read again after a contribution', async () => {
    const after = goal({ savedCents: 125000 })
    const { fx, client, key, before, spy } = await setupWithOverview({
      contribute: () => ({ status: 201, body: { goal: after } }),
    })
    fx.handlers.list = serve(goalsResponse([after]))

    fireEvent.click(step('Sample Holiday', '+$50'))

    await waitFor(() =>
      expect(text(card('Sample Holiday'), 'goal-saved')).toBe('$1,250.00'),
    )
    await settled()
    expectOverviewUntouched(fx, client, key, before, spy)
  })

  it('is not invalidated or read again after a refused contribution', async () => {
    const { fx, client, key, before, spy } = await setupWithOverview({
      contribute: () => ({ status: 404, body: { error: 'Goal not found' } }),
    })

    fireEvent.click(step('Sample Holiday', '+$50'))

    await screen.findByRole('alert')
    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    await settled()
    expectOverviewUntouched(fx, client, key, before, spy)
  })

  it('is not invalidated or read again after a goal is created', async () => {
    const created = goal({ id: '9', name: 'Sample Car' })
    const { fx, client, key, before, spy } = await setupWithOverview({
      create: () => ({ status: 201, body: created }),
    })
    fx.handlers.list = serve(goalsResponse([HOLIDAY, created]))

    fireEvent.click(screen.getByRole('button', { name: /^New goal/ }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Sample Car' },
    })
    fireEvent.change(screen.getByLabelText('Target ($)'), {
      target: { value: '3000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('article', { name: 'Sample Car' })
    await settled()
    expectOverviewUntouched(fx, client, key, before, spy)
  })
})

describe('creating a goal', () => {
  function open(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: /^New goal/ }))
    return screen.getByRole('form', { name: 'New goal' })
  }

  function type(label: string, value: string): void {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }

  function save(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  }

  it('offers a new goal in the app, not with the advisor', async () => {
    setup(goalsResponse())
    await loaded()

    const button = screen.getByRole('button', { name: /^New goal/ })
    expect(button.textContent).toBe('New goalSet a target and a by-date')
  })

  it('sends the typed goal as cents and shows its card once the list is read again', async () => {
    const created = goal({
      id: '9',
      name: 'Sample Car',
      targetCents: 150050,
      savedCents: 0,
      targetDate: '2027-03-15',
      paceCents: 8828,
      monthsToGo: 17,
    })
    const { fx } = setup(goalsResponse(), {
      create: () => ({ status: 201, body: created }),
    })
    await loaded()
    fx.handlers.list = serve(goalsResponse([HOLIDAY, created]))

    open()
    type('Name', '  Sample Car  ')
    type('Target ($)', '1,500.50')
    type('By-date', '2027-03-15')
    save()

    await screen.findByRole('article', { name: 'Sample Car' })
    expect(screen.queryByRole('form', { name: 'New goal' })).toBeNull()
    const bodies = fx.bodiesTo('POST', LIST)
    expect(bodies).toEqual([
      { name: 'Sample Car', targetCents: 150050, targetDate: '2027-03-15' },
    ])
    expect(Object.keys(bodies[0]).sort()).toEqual(CREATE_KEYS)
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(text(card('Sample Car'), 'goal-target')).toBe('of $1,500.50')
  })

  it('sends a null by-date when none is typed', async () => {
    const { fx } = setup(goalsResponse(), {
      create: () => ({ status: 201, body: RAINY_DAY }),
    })
    await loaded()

    open()
    type('Name', 'Sample Rainy Day')
    type('Target ($)', '1000')
    save()

    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'New goal' })).toBeNull(),
    )
    const bodies = fx.bodiesTo('POST', LIST)
    expect(bodies).toEqual([
      { name: 'Sample Rainy Day', targetCents: 100000, targetDate: null },
    ])
    expect(Object.keys(bodies[0]).sort()).toEqual(CREATE_KEYS)
  })

  it("shows the server's refusal and keeps what was typed", async () => {
    const refusal =
      'targetDate must be a YYYY-MM-DD date from 2000-01-01 to 2099-12-31, or null'
    const { fx } = setup(goalsResponse(), {
      create: () => ({ status: 400, body: { error: refusal } }),
    })
    await loaded()

    const form = open()
    type('Name', 'Sample Car')
    type('Target ($)', '1500')
    type('By-date', '2027-03-15')
    save()

    const alert = await within(form).findByRole('alert')
    expect(alert.textContent).toBe(refusal)
    expect(screen.getByRole('form', { name: 'New goal' })).toBe(form)
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Sample Car',
    )
    expect((screen.getByLabelText('Target ($)') as HTMLInputElement).value).toBe(
      '1500',
    )
    expect((screen.getByLabelText('By-date') as HTMLInputElement).value).toBe(
      '2027-03-15',
    )
    expect(fx.callsTo('GET', LIST)).toHaveLength(1)

    // Editing a field clears the server's message.
    type('Name', 'Sample Car 2')
    expect(within(form).queryByRole('alert')).toBeNull()
  })

  it('checks the fields before sending anything', async () => {
    const { fx } = setup(goalsResponse())
    await loaded()

    const form = open()
    save()

    expect(
      within(form)
        .getAllByRole('alert')
        .map((a) => a.textContent),
    ).toEqual(['Required', 'Required'])
    expect(
      (screen.getByLabelText('Name') as HTMLInputElement).getAttribute(
        'aria-invalid',
      ),
    ).toBe('true')

    type('Name', 'Sample Car')
    type('Target ($)', '0')
    save()
    expect(within(form).getByRole('alert').textContent).toBe('Must be more than 0')

    type('Target ($)', '12.345')
    save()
    expect(within(form).getByRole('alert').textContent).toBe(
      'Enter dollars and cents, like 1049.99',
    )
    expect(fx.callsTo('POST', LIST)).toEqual([])
  })

  it('creates once for a fast double click on Save', async () => {
    const { fx } = setup(goalsResponse(), { create: () => undefined })
    await loaded()

    open()
    type('Name', 'Sample Car')
    type('Target ($)', '1500')
    const saveButton = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    await screen.findByRole('button', { name: 'Saving…' })
    expect(fx.callsTo('POST', LIST)).toHaveLength(1)
  })

  it('Cancel closes the form without sending', async () => {
    const { fx } = setup(goalsResponse())
    await loaded()

    open()
    type('Name', 'Sample Car')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form', { name: 'New goal' })).toBeNull()
    expect(screen.getByRole('button', { name: /^New goal/ })).not.toBeNull()
    expect(fx.calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('Save and every +$ button wait while a contribution is in flight', async () => {
    const { fx } = setup(goalsResponse(), { contribute: () => undefined })
    await loaded()

    open()
    fireEvent.click(step('Sample Holiday', '+$50'))

    const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    await waitFor(() => expect(saveButton.disabled).toBe(true))
    expect(
      (screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(step('Sample Holiday', '+$200').disabled).toBe(true)
    expect(fx.callsTo('POST', LIST)).toEqual([])
  })

  it('every +$ button waits while a goal is being created', async () => {
    const { fx } = setup(goalsResponse(), { create: () => undefined })
    await loaded()

    open()
    type('Name', 'Sample Car')
    type('Target ($)', '1500')
    save()

    await waitFor(() => expect(step('Sample Holiday', '+$50').disabled).toBe(true))
    expect(step('Sample Holiday', '+$200').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Saving…' })).not.toBeNull()
    fireEvent.click(step('Sample Holiday', '+$50'))
    expect(fx.callsTo('POST', contributions('1'))).toEqual([])
  })
})

describe('the screen states', () => {
  it('says it is loading until the list arrives', async () => {
    setup(() => undefined)

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Loading your goals…')
    expect(screen.queryByRole('region', { name: 'Goals' })).toBeNull()
  })

  it('says there are none yet and still offers a new goal', async () => {
    setup(goalsResponse([]))
    await loaded()

    expect(screen.getByText('No goals yet.')).not.toBeNull()
    expect(screen.queryAllByRole('article')).toEqual([])
    expect(screen.getByRole('button', { name: /^New goal/ })).not.toBeNull()
  })

  it("shows the server's error with Try again, which reads again", async () => {
    const { fx } = setup(() => ({
      status: 500,
      body: { error: 'Internal server error' },
    }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Internal server error')
    fx.handlers.list = serve(goalsResponse())
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
  })

  it('keeps the last goals with a banner when a refetch fails', async () => {
    const { fx, client } = setup(goalsResponse())
    await loaded()
    fx.handlers.list = () => ({ status: 500, body: { error: 'Internal server error' } })

    await act(() => client.invalidateQueries({ queryKey: queryKeys.goals.all }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't refresh. Showing the last goals.")
    expect(text(card('Sample Holiday'), 'goal-saved')).toBe('$1,200.00')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { renderWithProviders } from '../../Shell/__tests__/renderWithProviders.tsx'
import { SUBSCRIPTIONS_KEY } from '../../../apis/subscriptions.ts'
import type {
  Scope,
  SubscriptionsResponse,
} from '../../../../shared/contracts.ts'
import Subscriptions from '../index.tsx'
import {
  STORED,
  installFetch,
  merchant,
  response,
  row,
  type Handler,
} from './fixtures.ts'

// The Subscriptions screen (prd-02 Ruling 14, issue 230). Every request
// goes through the real client/apis/subscriptions.ts to a routing fetch
// stub (./fixtures.ts). The sync pill's fetch never settles. Every value is
// invented.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const LIST = '/api/v1/subscriptions'
const MARK = '/api/v1/subscriptions/mark'
const CANCEL = '/api/v1/subscriptions/cancel'
const UNCANCEL = '/api/v1/subscriptions/uncancel'

const STREAM = 'm:merchant_invented_stream'

function serve(body: SubscriptionsResponse): Handler {
  return () => ({ body })
}

function setup(body: SubscriptionsResponse | Handler, initialScope: Scope = 'all') {
  const fx = installFetch({
    list: typeof body === 'function' ? body : serve(body),
    mark: () => STORED,
    cancel: () => STORED,
    uncancel: () => STORED,
  })
  const view = renderWithProviders(<Subscriptions />, { initialScope })
  return { fx, ...view }
}

/** The list's row for one merchant in one scope. */
function item(scope: string, merchantKey: string): HTMLElement {
  const list = screen.getByRole('region', { name: 'Subscriptions' })
  const li = list.querySelector<HTMLElement>(
    `[data-merchant="${scope}:${merchantKey}"]`,
  )
  if (!li) throw new Error(`no row ${scope}:${merchantKey}`)
  return li
}

function listNames(): string[] {
  return within(screen.getByRole('region', { name: 'Subscriptions' }))
    .queryAllByTestId('subscription-name')
    .map((n) => n.textContent ?? '')
}

function meta(li: HTMLElement): string {
  return within(li).getByTestId('subscription-meta').textContent ?? ''
}

function scopeToggle(label: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Scope' })).getByRole(
    'button',
    { name: label },
  )
}

async function loaded(): Promise<void> {
  await screen.findByRole('region', { name: 'Subscriptions' })
}

/** Waits for a write's refetch to land, when the buttons are enabled again. */
async function settled(): Promise<void> {
  await waitFor(() => {
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
  })
}

const WRITE_KEYS = ['merchantKey', 'scope']
const MARK_KEYS = ['answer', 'merchantKey', 'scope']

describe('the subscription rows', () => {
  const rows = response({
    subscriptions: [
      row(),
      row({
        merchantKey: 'm:merchant_invented_gym',
        scope: 'strawb',
        name: 'Sample Gym',
        lastChargedOn: '2026-10-19',
        amountCents: 1000,
        cadence: 'weekly',
        perMonthCents: 4333,
        perYearCents: 51996,
      }),
      row({
        merchantKey: 'd:invented trial notes',
        name: 'Trial Notes',
        chargeCount: 1,
        lastChargedOn: '2026-10-03',
        amountCents: 899,
        cadence: null,
        detected: false,
        marked: true,
        perMonthCents: null,
        perYearCents: null,
      }),
    ],
  })

  it('shows each name, side, latest charge and its cycle', async () => {
    setup(rows)
    await loaded()

    const stream = item('personal', STREAM)
    expect(within(stream).getByTestId('subscription-name').textContent).toBe(
      'Example Stream',
    )
    expect(within(stream).getByText('Personal')).not.toBeNull()
    expect(within(stream).getByTestId('subscription-amount').textContent).toBe(
      '$15.99',
    )
    expect(within(stream).getByText('per month')).not.toBeNull()

    const gym = item('strawb', 'm:merchant_invented_gym')
    expect(within(gym).getByText('Strawb')).not.toBeNull()
    expect(within(gym).getByTestId('subscription-amount').textContent).toBe(
      '$10.00',
    )
    expect(within(gym).getByText('per week')).not.toBeNull()
  })

  it('says how often, when, how many and who found it, and what a weekly one counts as a month', async () => {
    setup(rows)
    await loaded()

    expect(meta(item('personal', STREAM))).toBe(
      'Monthly · Last charged 1 Oct · 3 charges · Found automatically',
    )
    expect(meta(item('strawb', 'm:merchant_invented_gym'))).toBe(
      'Weekly · Last charged 19 Oct · 3 charges · Found automatically · counts as $43.33 a month',
    )
  })

  it('shows a row with no cadence as its latest charge, with no monthly figure', async () => {
    setup(rows)
    await loaded()

    const trial = item('personal', 'd:invented trial notes')
    expect(meta(trial)).toBe(
      'No regular pattern yet · Last charged 3 Oct · 1 charge · You marked it',
    )
    expect(within(trial).getByTestId('subscription-amount').textContent).toBe(
      '$8.99',
    )
    expect(within(trial).getByText('latest charge')).not.toBeNull()
    expect(trial.textContent).not.toContain('counts as')
  })
})

describe('the totals', () => {
  it("shows the route's figures, not a sum of the rows", async () => {
    // Deliberately unequal to the one row's 1599 a month, and the year is
    // not 12 × the month, so a tile that multiplies cannot pass.
    setup(
      response({
        totals: {
          perMonthCents: 12345,
          perYearCents: 99999,
          countedCount: 1,
          uncountedCount: 0,
        },
      }),
    )
    await loaded()

    expect(screen.getByTestId('total-month').textContent).toBe('$123.45')
    expect(screen.getByTestId('total-year').textContent).toBe('$999.99')
  })

  it('says how many active rows are left out of the totals', async () => {
    setup(
      response({
        totals: {
          perMonthCents: 1599,
          perYearCents: 19188,
          countedCount: 1,
          uncountedCount: 2,
        },
      }),
    )
    await loaded()

    expect(
      screen.getByText(
        '2 subscriptions left out of these totals: no regular pattern yet',
      ),
    ).not.toBeNull()
  })

  it('says it in the singular for one', async () => {
    setup(
      response({
        totals: {
          perMonthCents: 1599,
          perYearCents: 19188,
          countedCount: 1,
          uncountedCount: 1,
        },
      }),
    )
    await loaded()

    expect(
      screen.getByText(
        '1 subscription left out of these totals: no regular pattern yet',
      ),
    ).not.toBeNull()
  })

  it('has no left-out line at zero, and no usage tile at all', async () => {
    setup(response())
    await loaded()

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('left out of these totals')
    expect(text).not.toContain('Barely used')
    expect(text.toLowerCase()).not.toContain('usage')
  })
})

describe('the list order and keys', () => {
  const SHARED = 'm:merchant_invented_shared'
  const both = response({
    subscriptions: [
      row({ merchantKey: 'm:merchant_invented_zed', name: 'Zed Invented' }),
      row({ merchantKey: SHARED, scope: 'strawb', name: 'Shared Tool' }),
      row({ merchantKey: SHARED, scope: 'personal', name: 'Shared Tool' }),
      row({ merchantKey: 'm:merchant_invented_alpha', name: 'Alpha Invented' }),
    ],
  })

  it('keeps the order the route sent', async () => {
    setup(both)
    await loaded()

    expect(listNames()).toEqual([
      'Zed Invented',
      'Shared Tool',
      'Shared Tool',
      'Alpha Invented',
    ])
  })

  it("shows one merchant in both scopes as two rows, and cancels the one clicked in its own scope", async () => {
    const { fx } = setup(both)
    await loaded()

    fireEvent.click(
      within(item('strawb', SHARED)).getByRole('button', {
        name: 'Cancel Shared Tool',
      }),
    )

    await waitFor(() => expect(fx.callsTo('POST', CANCEL)).toHaveLength(1))
    expect(fx.bodiesTo('POST', CANCEL)).toEqual([
      { scope: 'strawb', merchantKey: SHARED },
    ])
  })
})

describe('a cancelled row', () => {
  const cancelled = response({
    subscriptions: [row({ status: 'cancelled', cancelledOn: '2026-10-03' })],
  })

  it('is dimmed and struck through, says when, and still shows its charge', async () => {
    setup(cancelled)
    await loaded()

    const stream = item('personal', STREAM)
    expect(stream.classList.contains('opacity-55')).toBe(true)
    expect(
      within(stream)
        .getByTestId('subscription-name')
        .classList.contains('line-through'),
    ).toBe(true)
    expect(meta(stream)).toBe(
      'Monthly · Last charged 1 Oct · 3 charges · Found automatically · Cancelled 3 Oct',
    )
    expect(within(stream).getByTestId('subscription-amount').textContent).toBe(
      '$15.99',
    )
    const button = within(stream).getByRole('button', {
      name: 'Cancelled Example Stream, undo',
    })
    expect(button.textContent).toBe('Cancelled')
  })

  it('does not say what a cancelled weekly row counts as a month', async () => {
    // The route leaves a cancelled row out of the totals, so the meta line
    // must not claim a monthly figure for it.
    setup(
      response({
        subscriptions: [
          row({
            status: 'cancelled',
            cancelledOn: '2026-10-03',
            cadence: 'weekly',
            perMonthCents: 4333,
            perYearCents: 51996,
          }),
        ],
      }),
    )
    await loaded()

    const stream = item('personal', STREAM)
    expect(meta(stream)).toBe(
      'Weekly · Last charged 1 Oct · 3 charges · Found automatically · Cancelled 3 Oct',
    )
    expect(stream.textContent).not.toContain('counts as')
  })

  it('an active row is neither dimmed nor struck through', async () => {
    setup(response())
    await loaded()

    const stream = item('personal', STREAM)
    expect(stream.classList.contains('opacity-55')).toBe(false)
    expect(
      within(stream)
        .getByTestId('subscription-name')
        .classList.contains('line-through'),
    ).toBe(false)
  })
})

describe('a row charged again after cancelling', () => {
  it('says when the charge landed and offers Cancel again', async () => {
    setup(
      response({
        subscriptions: [
          row({ cancelledOn: '2026-09-20', chargedAgainOn: '2026-10-01' }),
        ],
      }),
    )
    await loaded()

    const stream = item('personal', STREAM)
    expect(
      within(stream).getByText('Charged again on 1 Oct after you cancelled'),
    ).not.toBeNull()
    expect(
      within(stream).getByRole('button', { name: 'Cancel Example Stream' })
        .textContent,
    ).toBe('Cancel')
  })
})

describe('cancelling', () => {
  it('sends only the scope and merchant, never a date', async () => {
    const { fx } = setup(response())
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Example Stream' }))

    await waitFor(() => expect(fx.callsTo('POST', CANCEL)).toHaveLength(1))
    const [body] = fx.bodiesTo('POST', CANCEL)
    expect(Object.keys(body).sort()).toEqual(WRITE_KEYS)
    expect(body).toEqual({ scope: 'personal', merchantKey: STREAM })
  })

  it('changes nothing and holds every button until the refetch lands', async () => {
    const { fx } = setup(response())
    await loaded()
    // The refetch after the write never settles.
    fx.handlers.list = () => undefined

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Example Stream' }))

    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    const stream = item('personal', STREAM)
    expect(within(stream).getByRole('button', { name: 'Cancel Example Stream' }))
      .not.toBeNull()
    expect(stream.classList.contains('opacity-55')).toBe(false)
    for (const button of within(stream).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('shows the cancelled row once the refetched list says so', async () => {
    const { fx } = setup(response())
    await loaded()
    fx.handlers.list = serve(
      response({
        subscriptions: [row({ status: 'cancelled', cancelledOn: '2026-10-25' })],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Example Stream' }))

    await screen.findByRole('button', { name: 'Cancelled Example Stream, undo' })
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    expect(meta(item('personal', STREAM))).toContain('Cancelled 25 Oct')
  })
})

describe('undoing a cancel', () => {
  it('posts to uncancel and shows the refetched active row', async () => {
    const { fx } = setup(
      response({
        subscriptions: [row({ status: 'cancelled', cancelledOn: '2026-10-03' })],
      }),
    )
    await loaded()
    fx.handlers.list = serve(response())

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancelled Example Stream, undo' }),
    )

    await screen.findByRole('button', { name: 'Cancel Example Stream' })
    const [body] = fx.bodiesTo('POST', UNCANCEL)
    expect(Object.keys(body).sort()).toEqual(WRITE_KEYS)
    expect(body).toEqual({ scope: 'personal', merchantKey: STREAM })
    expect(fx.callsTo('POST', CANCEL)).toHaveLength(0)
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
  })
})

describe('the questions and not-subscriptions cards', () => {
  const CLOUD = 'm:merchant_invented_cloud'
  const NOTES = 'd:invented demo notes'
  const asking = response({
    subscriptions: [],
    questions: [merchant()],
    notSubscriptions: [
      merchant({
        merchantKey: NOTES,
        scope: 'strawb',
        name: 'Demo Notes',
        amountCents: 1250,
      }),
    ],
  })

  function card(title: string): HTMLElement {
    return screen.getByRole('region', { name: title })
  }

  it('shows each merchant with its side, last charge and latest amount', async () => {
    setup(asking)
    await loaded()

    const questions = card('Is this a subscription?')
    expect(questions.textContent).toContain('Sample Cloud')
    expect(questions.textContent).toContain('Personal')
    expect(questions.textContent).toContain('Last charged 3 Oct · 2 charges')
    expect(questions.textContent).toContain('$4.99')
    expect(questions.textContent).toContain('latest charge')
    expect(card('Not subscriptions').textContent).toContain('$12.50')
  })

  it('Yes marks it a subscription, and the refetched list holds it', async () => {
    const { fx } = setup(asking)
    await loaded()
    fx.handlers.list = serve(
      response({
        subscriptions: [
          row({
            merchantKey: CLOUD,
            name: 'Sample Cloud',
            cadence: null,
            detected: false,
            marked: true,
            perMonthCents: null,
            perYearCents: null,
          }),
        ],
      }),
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Yes, Sample Cloud is a subscription' }),
    )

    await waitFor(() => expect(listNames()).toEqual(['Sample Cloud']))
    const [body] = fx.bodiesTo('PUT', MARK)
    expect(Object.keys(body).sort()).toEqual(MARK_KEYS)
    expect(body).toEqual({
      scope: 'personal',
      merchantKey: CLOUD,
      answer: 'subscription',
    })
    expect(
      screen.queryByRole('region', { name: 'Is this a subscription?' }),
    ).toBeNull()
  })

  it('No marks it not a subscription, and it moves to that card', async () => {
    const { fx } = setup(asking)
    await loaded()
    fx.handlers.list = serve(
      response({ subscriptions: [], notSubscriptions: [merchant()] }),
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'No, Sample Cloud is not a subscription' }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Is this a subscription?' }),
      ).toBeNull(),
    )
    const [body] = fx.bodiesTo('PUT', MARK)
    expect(Object.keys(body).sort()).toEqual(MARK_KEYS)
    expect(body).toEqual({
      scope: 'personal',
      merchantKey: CLOUD,
      answer: 'not_subscription',
    })
    expect(card('Not subscriptions').textContent).toContain('Sample Cloud')
  })

  it('Undo clears her answer with an explicit null, in the merchant’s scope', async () => {
    const { fx } = setup(asking)
    await loaded()
    fx.handlers.list = serve(response({ subscriptions: [] }))

    fireEvent.click(
      screen.getByRole('button', { name: 'Undo: Demo Notes is not a subscription' }),
    )

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Not subscriptions' })).toBeNull(),
    )
    const [call] = fx.callsTo('PUT', MARK)
    expect(call.body).toContain('"answer":null')
    const [body] = fx.bodiesTo('PUT', MARK)
    expect(Object.keys(body).sort()).toEqual(MARK_KEYS)
    expect(body).toEqual({ scope: 'strawb', merchantKey: NOTES, answer: null })
  })

  it('neither card shows when the route has none', async () => {
    setup(response())
    await loaded()

    expect(screen.queryByRole('region', { name: 'Is this a subscription?' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Not subscriptions' })).toBeNull()
  })
})

describe('taking a row out of the list', () => {
  it('a detected row is answered not a subscription, since clearing would leave it listed', async () => {
    const { fx } = setup(response())
    await loaded()

    const stream = item('personal', STREAM)
    expect(within(stream).queryByRole('button', { name: /^Unmark/ })).toBeNull()
    fireEvent.click(
      within(stream).getByRole('button', {
        name: 'Not a subscription: Example Stream',
      }),
    )

    await waitFor(() => expect(fx.callsTo('PUT', MARK)).toHaveLength(1))
    expect(fx.bodiesTo('PUT', MARK)).toEqual([
      { scope: 'personal', merchantKey: STREAM, answer: 'not_subscription' },
    ])
  })

  it('a row both detected and marked still offers Not a subscription, never Unmark', async () => {
    const { fx } = setup(
      response({
        subscriptions: [row({ detected: true, marked: true })],
      }),
    )
    await loaded()

    const stream = item('personal', STREAM)
    expect(within(stream).queryByRole('button', { name: /^Unmark/ })).toBeNull()
    const button = within(stream).getByRole('button', {
      name: 'Not a subscription: Example Stream',
    })
    expect(button.textContent).toBe('Not a subscription')
    fireEvent.click(button)

    await waitFor(() => expect(fx.callsTo('PUT', MARK)).toHaveLength(1))
    const [body] = fx.bodiesTo('PUT', MARK)
    expect(Object.keys(body).sort()).toEqual(MARK_KEYS)
    expect(body).toEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'not_subscription',
    })
  })

  it('a row listed only because she marked it is unmarked with null', async () => {
    const { fx } = setup(
      response({
        subscriptions: [row({ detected: false, marked: true })],
      }),
    )
    await loaded()

    const stream = item('personal', STREAM)
    expect(
      within(stream).queryByRole('button', { name: /^Not a subscription/ }),
    ).toBeNull()
    fireEvent.click(
      within(stream).getByRole('button', { name: 'Unmark Example Stream' }),
    )

    await waitFor(() => expect(fx.callsTo('PUT', MARK)).toHaveLength(1))
    const [body] = fx.bodiesTo('PUT', MARK)
    expect(Object.keys(body).sort()).toEqual(MARK_KEYS)
    expect(body.answer).toBeNull()
  })
})

describe('in the All view', () => {
  it("every write names the row's own scope, never all", async () => {
    const { fx } = setup(
      response({
        subscriptions: [
          row(),
          row({
            merchantKey: 'm:merchant_invented_host',
            scope: 'strawb',
            name: 'Example Host',
            status: 'cancelled',
            cancelledOn: '2026-10-02',
          }),
        ],
        questions: [merchant({ scope: 'strawb', name: 'Sample Cloud' })],
      }),
      'all',
    )
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Example Stream' }))
    await settled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancelled Example Host, undo' }),
    )
    await settled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Yes, Sample Cloud is a subscription' }),
    )
    await settled()

    expect(fx.bodiesTo('POST', CANCEL).map((b) => b.scope)).toEqual(['personal'])
    expect(fx.bodiesTo('POST', UNCANCEL).map((b) => b.scope)).toEqual(['strawb'])
    expect(fx.bodiesTo('PUT', MARK).map((b) => b.scope)).toEqual(['strawb'])
    expect(fx.callsTo('GET', LIST)[0].url.searchParams.get('scope')).toBe('all')
  })
})

describe('the scope toggle', () => {
  it("reads the chosen scope, and on a switch shows loading, never the last scope's rows", async () => {
    const { fx } = setup((call) =>
      call.url.searchParams.get('scope') === 'strawb'
        ? {
            body: response({
              subscriptions: [row({ scope: 'strawb', name: 'Strawb Only Invented' })],
            }),
          }
        : undefined,
    'strawb')
    await loaded()
    expect(fx.callsTo('GET', LIST)[0].url.searchParams.get('scope')).toBe('strawb')
    expect(listNames()).toEqual(['Strawb Only Invented'])

    fireEvent.click(scopeToggle('Personal'))

    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toBe('Loading your subscriptions…')
    expect(fx.callsTo('GET', LIST).at(-1)?.url.searchParams.get('scope')).toBe(
      'personal',
    )
    expect(document.body.textContent).not.toContain('Strawb Only Invented')
  })
})

describe('a refused write', () => {
  it("shows the server's message, leaves the list as it was and does not refetch", async () => {
    const { fx } = setup(response())
    await loaded()
    fx.handlers.cancel = () => ({ status: 404, body: { error: 'Merchant not found' } })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Example Stream' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Merchant not found')
    expect(
      screen.getByRole('button', { name: 'Cancel Example Stream' }),
    ).not.toBeNull()
    expect(fx.callsTo('GET', LIST)).toHaveLength(1)
    await settled()
  })
})

describe('a refused write across a scope switch', () => {
  it("drops the alert when the scope changes, and shows the new scope's list", async () => {
    // Personal is read first so it is cached: switching back to it shows its
    // list at once, without the loading card unmounting the screen body. Only
    // the body's key can then drop the failed write's message.
    const { fx } = setup((call) => ({
      body: response({
        subscriptions: [
          row({
            scope: call.url.searchParams.get('scope') === 'strawb' ? 'strawb' : 'personal',
            name:
              call.url.searchParams.get('scope') === 'strawb'
                ? 'Strawb Only Invented'
                : 'Personal Only Invented',
          }),
        ],
      }),
    }), 'personal')
    await loaded()
    expect(listNames()).toEqual(['Personal Only Invented'])
    fireEvent.click(scopeToggle('Strawb'))
    await waitFor(() => expect(listNames()).toEqual(['Strawb Only Invented']))
    fx.handlers.cancel = () => ({ status: 404, body: { error: 'Merchant not found' } })

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel Strawb Only Invented' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Merchant not found')
    await settled()

    fireEvent.click(scopeToggle('Personal'))

    await waitFor(() => expect(listNames()).toEqual(['Personal Only Invented']))
    expect(screen.queryByText('Merchant not found')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('while a write is pending', () => {
  const NOTES = 'm:merchant_invented_notes'
  const asking = response({
    subscriptions: [
      row(),
      row({ merchantKey: NOTES, name: 'Marked Notes', detected: false, marked: true }),
    ],
    questions: [merchant()],
    notSubscriptions: [
      merchant({
        merchantKey: 'd:invented demo notes',
        scope: 'strawb',
        name: 'Demo Notes',
      }),
    ],
  })

  it.each([
    ['Unmark', 'Unmark Marked Notes'],
    ['Yes', 'Yes, Sample Cloud is a subscription'],
    ['No', 'No, Sample Cloud is not a subscription'],
    ['Undo', 'Undo: Demo Notes is not a subscription'],
  ])('%s is disabled until the write and its refetch land', async (_label, name) => {
    const { fx } = setup(asking)
    await loaded()
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    // The refetch after the write never settles, so the write stays pending.
    fx.handlers.list = () => undefined

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Example Stream' }))

    await waitFor(() => expect(fx.callsTo('GET', LIST)).toHaveLength(2))
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('the screen states', () => {
  it('says it is loading until the list arrives', async () => {
    setup(() => undefined)

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Loading your subscriptions…')
    expect(screen.queryByRole('region', { name: 'Subscriptions' })).toBeNull()
  })

  it("shows the server's error with Try again, which reads again", async () => {
    const { fx } = setup(() => ({
      status: 500,
      body: { error: 'Could not read subscriptions' },
    }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not read subscriptions')
    fx.handlers.list = serve(response())
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    await loaded()
    expect(listNames()).toEqual(['Example Stream'])
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
  })

  it('keeps the last list with a banner when a refetch fails', async () => {
    const { fx, client } = setup(response())
    await loaded()
    fx.handlers.list = () => ({ status: 500, body: { error: 'Could not read subscriptions' } })

    await act(() => client.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't refresh. Showing the last list.")
    expect(listNames()).toEqual(['Example Stream'])
  })

  it("says so when there are none, and the tiles still show the route's totals", async () => {
    setup(
      response({
        subscriptions: [],
        totals: {
          perMonthCents: 0,
          perYearCents: 0,
          countedCount: 0,
          uncountedCount: 0,
        },
      }),
    )
    await loaded()

    expect(
      screen.getByText('No regular charges found for this scope yet.'),
    ).not.toBeNull()
    expect(screen.getByTestId('total-month').textContent).toBe('$0.00')
    expect(screen.getByTestId('total-year').textContent).toBe('$0.00')
  })
})

describe('the advisor banner', () => {
  it('hands off to Claude and names no subscription or figure', async () => {
    setup(response({ questions: [merchant()] }))
    await loaded()

    const banner = screen.getByTestId('advisor-banner')
    const link = within(banner).getByRole('link')
    expect(link.textContent).toBe('Help me cancel →')
    expect(link.getAttribute('href')).toBe('https://claude.ai/download')
    expect(banner.textContent).not.toContain('Example Stream')
    expect(banner.textContent).not.toContain('Sample Cloud')
    expect(banner.textContent).not.toMatch(/\$\d/)
  })

  it('opens Claude desktop in a new tab, sending no referrer', async () => {
    setup(response({ questions: [merchant()] }))
    await loaded()

    const link = within(screen.getByTestId('advisor-banner')).getByRole('link')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')?.split(/\s+/).sort()).toEqual([
      'noopener',
      'noreferrer',
    ])
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})

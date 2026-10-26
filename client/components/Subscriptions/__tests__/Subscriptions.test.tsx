import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// The screen reads today from the clock, in Auckland. 23:00 UTC on 27 Oct is
// 12:00 on 28 Oct there, so the screen's today is 28 Oct 2026. Only Date is
// faked, so react-query and waitFor keep real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-27T23:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

/** The header's Active / Cancelled switch (issue 390). */
function statusToggle(label: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Status' })).getByRole(
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
          possiblyStoppedCount: 0,
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
          possiblyStoppedCount: 0,
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
          possiblyStoppedCount: 0,
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
    fireEvent.click(statusToggle('Cancelled'))

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
    fireEvent.click(statusToggle('Cancelled'))

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

    // Now cancelled, it leaves the Active list and shows under Cancelled.
    await waitFor(() => expect(listNames()).toEqual([]))
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
    fireEvent.click(statusToggle('Cancelled'))
    expect(
      screen.getByRole('button', { name: 'Cancelled Example Stream, undo' }),
    ).not.toBeNull()
    expect(meta(item('personal', STREAM))).toContain('Cancelled 25 Oct')
    expect(fx.callsTo('GET', LIST)).toHaveLength(2)
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
    fireEvent.click(statusToggle('Cancelled'))

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancelled Example Stream, undo' }),
    )

    // Active again, it leaves the Cancelled list and shows under Active.
    await waitFor(() => expect(listNames()).toEqual([]))
    fireEvent.click(statusToggle('Active'))
    expect(
      screen.getByRole('button', { name: 'Cancel Example Stream' }),
    ).not.toBeNull()
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
    fireEvent.click(statusToggle('Cancelled'))
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
          possiblyStoppedCount: 0,
        },
      }),
    )
    await loaded()

    expect(
      screen.getByText('No active subscriptions for this scope yet.'),
    ).not.toBeNull()
    expect(screen.getByTestId('total-month').textContent).toBe('$0.00')
    expect(screen.getByTestId('total-year').textContent).toBe('$0.00')
  })
})

describe("a date from another year than today's shows its year", () => {
  it('shows the year on a last charge, a cancel and a charge after cancelling', async () => {
    setup(
      response({
        subscriptions: [
          row({
            status: 'cancelled',
            lastChargedOn: '2025-10-13',
            cancelledOn: '2025-11-02',
            chargedAgainOn: '2025-12-01',
          }),
        ],
      }),
    )
    await loaded()
    fireEvent.click(statusToggle('Cancelled'))

    const stream = item('personal', STREAM)
    expect(meta(stream)).toContain('Last charged 13 Oct\u00a02025')
    expect(meta(stream)).toContain('Cancelled 2 Nov\u00a02025')
    // getByText's default normalizer folds U+00A0 into a space, so the
    // exact separator is pinned on textContent.
    expect(
      within(stream).getByText(
        'Charged again on 1 Dec 2025 after you cancelled',
      ).textContent,
    ).toBe('Charged again on 1 Dec\u00a02025 after you cancelled')
  })

  it('shows the year on a merchant in each card, and not on this year', async () => {
    setup(
      response({
        subscriptions: [],
        questions: [merchant({ lastChargedOn: '2025-09-04' })],
        notSubscriptions: [
          merchant({
            merchantKey: 'd:invented demo notes',
            scope: 'strawb',
            name: 'Demo Notes',
            lastChargedOn: '2026-10-03',
          }),
          merchant({
            merchantKey: 'd:invented old notes',
            scope: 'strawb',
            name: 'Old Notes',
            lastChargedOn: '2025-02-14',
          }),
        ],
      }),
    )
    await loaded()

    const questions = screen.getByRole('region', {
      name: 'Is this a subscription?',
    })
    expect(questions.textContent).toContain(
      'Last charged 4 Sep\u00a02025 · 2 charges',
    )
    const notSubscriptions = screen.getByRole('region', {
      name: 'Not subscriptions',
    })
    expect(notSubscriptions.textContent).toContain(
      'Last charged 3 Oct · 2 charges',
    )
    expect(notSubscriptions.textContent).toContain(
      'Last charged 14 Feb\u00a02025 · 2 charges',
    )
  })

  it('takes the year from the NZ calendar, not UTC: 1 Jan in Auckland is next year', async () => {
    // 12:00 UTC on 31 Dec is 01:00 on 1 Jan in Auckland (NZDT), so the
    // screen's today is in 2027 and a charge on 31 Dec 2026 shows its year.
    // A screen that read UTC would say 31 Dec.
    vi.setSystemTime(new Date('2026-12-31T12:00:00Z'))
    setup(response({ subscriptions: [row({ lastChargedOn: '2026-12-31' })] }))
    await loaded()

    expect(meta(item('personal', STREAM))).toContain(
      'Last charged 31 Dec\u00a02026',
    )
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

describe('the Active / Cancelled toggle', () => {
  // Active and cancelled interleaved on purpose, across both scopes, so a
  // list that grouped by status or by scope would change the order.
  const mixed = response({
    subscriptions: [
      row({ merchantKey: 'm:merchant_invented_north', name: 'North Invented' }),
      row({
        merchantKey: 'm:merchant_invented_east',
        scope: 'strawb',
        name: 'East Invented',
        status: 'cancelled',
        cancelledOn: '2026-10-05',
      }),
      row({
        merchantKey: 'm:merchant_invented_south',
        scope: 'strawb',
        name: 'South Invented',
      }),
      row({
        merchantKey: 'm:merchant_invented_west',
        name: 'West Invented',
        status: 'cancelled',
        cancelledOn: '2026-09-20',
      }),
    ],
    // Deliberately not a sum of the rows (each is 1599 a month) and the year
    // is not 12 x the month.
    totals: {
      perMonthCents: 2468,
      perYearCents: 30001,
      countedCount: 2,
      uncountedCount: 1,
      possiblyStoppedCount: 0,
    },
  })

  const struck = (scope: string, merchantKey: string): boolean =>
    within(item(scope, merchantKey))
      .getByTestId('subscription-name')
      .classList.contains('line-through')

  function pressedStatus(): string[] {
    return within(screen.getByRole('group', { name: 'Status' }))
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent ?? '')
  }

  it('lists only the active rows under Active and only the cancelled ones under Cancelled, each in route order, struck through only when cancelled', async () => {
    setup(mixed)
    await loaded()

    expect(listNames()).toEqual(['North Invented', 'South Invented'])
    expect(struck('personal', 'm:merchant_invented_north')).toBe(false)
    expect(struck('strawb', 'm:merchant_invented_south')).toBe(false)

    fireEvent.click(statusToggle('Cancelled'))

    expect(listNames()).toEqual(['East Invented', 'West Invented'])
    expect(struck('strawb', 'm:merchant_invented_east')).toBe(true)
    expect(struck('personal', 'm:merchant_invented_west')).toBe(true)
  })

  it('offers Active and Cancelled beside the scope toggle, with Active pressed by default', async () => {
    setup(mixed)
    await loaded()

    const status = screen.getByRole('group', { name: 'Status' })
    expect(
      within(status)
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Active', 'true'],
      ['Cancelled', 'false'],
    ])
    // Beside the scope control: the next element in the header's right group.
    expect(status.nextElementSibling).toBe(
      screen.getByRole('group', { name: 'Scope' }),
    )
  })

  it('shows no active row under Cancelled', async () => {
    setup(mixed)
    await loaded()

    fireEvent.click(statusToggle('Cancelled'))

    expect(pressedStatus()).toEqual(['Cancelled'])
    const list = screen.getByRole('region', { name: 'Subscriptions' })
    expect(
      list.querySelector('[data-merchant="personal:m:merchant_invented_north"]'),
    ).toBeNull()
    expect(
      list.querySelector('[data-merchant="strawb:m:merchant_invented_south"]'),
    ).toBeNull()
  })

  it("keeps the route's totals whichever status is shown", async () => {
    setup(mixed)
    await loaded()

    const totals = (): string[] => [
      screen.getByTestId('total-month').textContent ?? '',
      screen.getByTestId('total-year').textContent ?? '',
      screen.getByText(/left out of these totals/).textContent ?? '',
    ]
    const expected = [
      '$24.68',
      '$300.01',
      '1 subscription left out of these totals: no regular pattern yet',
    ]
    expect(totals()).toEqual(expected)

    fireEvent.click(statusToggle('Cancelled'))
    expect(listNames()).toEqual(['East Invented', 'West Invented'])
    expect(totals()).toEqual(expected)

    fireEvent.click(statusToggle('Active'))
    expect(listNames()).toEqual(['North Invented', 'South Invented'])
    expect(totals()).toEqual(expected)
  })

  it('switching status reads nothing again', async () => {
    const { fx } = setup(mixed)
    await loaded()
    expect(fx.callsTo('GET', LIST)).toHaveLength(1)

    fireEvent.click(statusToggle('Cancelled'))
    await waitFor(() =>
      expect(listNames()).toEqual(['East Invented', 'West Invented']),
    )
    fireEvent.click(statusToggle('Active'))
    await waitFor(() =>
      expect(listNames()).toEqual(['North Invented', 'South Invented']),
    )

    expect(fx.callsTo('GET', LIST)).toHaveLength(1)
  })

  it('is there while the list loads, and in the error state', async () => {
    setup(() => undefined)
    await screen.findByRole('status')
    expect(pressedStatus()).toEqual(['Active'])
    cleanup()

    setup(() => ({ status: 500, body: { error: 'Could not read subscriptions' } }))
    await screen.findByRole('alert')
    expect(pressedStatus()).toEqual(['Active'])
    fireEvent.click(statusToggle('Cancelled'))
    expect(pressedStatus()).toEqual(['Cancelled'])
  })

  it('keeps Cancelled through a scope switch', async () => {
    setup(
      (call) =>
        call.url.searchParams.get('scope') === 'strawb'
          ? {
              body: response({
                subscriptions: [
                  row({ scope: 'strawb', name: 'Strawb Active Invented' }),
                  row({
                    merchantKey: 'm:merchant_invented_old_tool',
                    scope: 'strawb',
                    name: 'Strawb Cancelled Invented',
                    status: 'cancelled',
                    cancelledOn: '2026-10-05',
                  }),
                ],
              }),
            }
          : { body: mixed },
      'all',
    )
    await loaded()
    fireEvent.click(statusToggle('Cancelled'))
    expect(listNames()).toEqual(['East Invented', 'West Invented'])

    fireEvent.click(scopeToggle('Strawb'))

    await waitFor(() =>
      expect(listNames()).toEqual(['Strawb Cancelled Invented']),
    )
    expect(pressedStatus()).toEqual(['Cancelled'])
  })

  it('says there are no active subscriptions when every row is cancelled', async () => {
    setup(
      response({
        subscriptions: [row({ status: 'cancelled', cancelledOn: '2026-10-03' })],
      }),
    )
    await loaded()

    expect(listNames()).toEqual([])
    expect(
      screen.getByText('No active subscriptions for this scope yet.'),
    ).not.toBeNull()
    expect(
      screen.queryByText('No cancelled subscriptions for this scope.'),
    ).toBeNull()
  })

  it('says there are no cancelled subscriptions when every row is active', async () => {
    setup(response())
    await loaded()

    fireEvent.click(statusToggle('Cancelled'))

    expect(listNames()).toEqual([])
    expect(
      screen.getByText('No cancelled subscriptions for this scope.'),
    ).not.toBeNull()
    expect(
      screen.queryByText('No active subscriptions for this scope yet.'),
    ).toBeNull()
  })

  it("the totals are the route's figures, with cancelled rows in the response", async () => {
    setup(mixed)
    await loaded()

    expect(screen.getByTestId('total-month').textContent).toBe('$24.68')
    expect(screen.getByTestId('total-year').textContent).toBe('$300.01')
    expect(
      screen.getByText(
        '1 subscription left out of these totals: no regular pattern yet',
      ),
    ).not.toBeNull()
  })
})

describe('a possibly-stopped row (issue #392)', () => {
  const GYM = 'm:merchant_invented_gym'
  const body = response({
    subscriptions: [
      row(),
      row({
        merchantKey: GYM,
        name: 'Sample Gym',
        lastChargedOn: '2026-07-01',
        amountCents: 1000,
        cadence: 'weekly',
        perMonthCents: 4333,
        perYearCents: 51996,
        possiblyStopped: true,
      }),
    ],
    totals: {
      perMonthCents: 1599,
      perYearCents: 19188,
      countedCount: 1,
      uncountedCount: 0,
      possiblyStoppedCount: 1,
    },
  })

  it('carries a chip under Active, keeps Cancel, and does not say what it counts as a month', async () => {
    setup(body)
    await loaded()

    expect(listNames()).toEqual(['Example Stream', 'Sample Gym'])
    const gym = item('personal', GYM)
    const chip = within(gym).getByText('Possibly stopped')
    expect(chip.className.split(' ')).toEqual(
      expect.arrayContaining(['rounded-pill', 'bg-canvas', 'text-warn']),
    )
    const cancel = within(gym).getByRole('button', {
      name: 'Cancel Sample Gym',
    }) as HTMLButtonElement
    expect(cancel.disabled).toBe(false)
    expect(meta(gym)).toBe(
      'Weekly · Last charged 1 Jul · 3 charges · Found automatically',
    )

    expect(
      within(item('personal', STREAM)).queryByText('Possibly stopped'),
    ).toBeNull()
  })

  it('the tiles say how many are left out as possibly stopped', async () => {
    setup(body)
    await loaded()

    expect(
      screen.getByText(
        '1 subscription left out of these totals: possibly stopped',
      ),
    ).not.toBeNull()
    expect(document.body.textContent).not.toContain('no regular pattern yet')
  })

  it('says it in the plural, and not at all at zero', async () => {
    setup(
      response({
        totals: {
          perMonthCents: 0,
          perYearCents: 0,
          countedCount: 0,
          uncountedCount: 0,
          possiblyStoppedCount: 2,
        },
      }),
    )
    await loaded()

    expect(
      screen.getByText(
        '2 subscriptions left out of these totals: possibly stopped',
      ),
    ).not.toBeNull()
    cleanup()

    setup(response())
    await loaded()
    expect(document.body.textContent).not.toContain('possibly stopped')
  })
})

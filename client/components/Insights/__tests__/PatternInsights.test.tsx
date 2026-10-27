import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '../../Shell/__tests__/renderWithProviders.tsx'
import type { Insight } from '../../../../models/insights.ts'
import type { Scope } from '../../../../shared/contracts.ts'
import { habitsResponse } from '../../../screens/Habits/__tests__/fixtures.ts'
import Habits from '../../../screens/Habits/index.tsx'
import {
  topMerchants,
  weekOverWeek,
  type Aggregates,
  type LedgerRow,
} from '../../../../server/agents/insights/queries.ts'
import {
  topMerchantsChart,
  topMerchantsMarkdown,
} from '../../../../server/agents/insights/prompt.ts'
import PatternInsights from '../PatternInsights.tsx'

// queries.ts opens the server's knex connection at import; its pure folds
// are all this test uses, so no database is ever opened from jsdom.
vi.mock('../../../../server/db/connection.ts', () => ({ default: {} }))

// The Habits Patterns card filled with insights (prd-04 Ruling 2, Ruling 3;
// #63). One describe per Done-when line. Requests go through the real
// useInsights.ts to a routing fetch stub. Every value is invented.

// The list's query key for a scope, private to useInsights.ts.
const insightsKey = (scope: Scope) => ['insights', scope]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CHART = {
  title: 'Top merchants by spend',
  data: {
    values: [
      { merchant: 'Invented Grocer', spend_cents: 123456 },
      { merchant: 'Invented Cafe', spend_cents: 4550 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'merchant', type: 'nominal', title: 'Merchant' },
    y: { field: 'spend_cents', type: 'quantitative', title: 'Spend in cents' },
  },
}

function insight(id: number, over: Partial<Insight> = {}): Insight {
  return {
    id,
    kind: 'pattern',
    title: `Invented pattern ${id}`,
    body_md: `Invented body ${id}`,
    chart_spec_json: null,
    scope: 'personal',
    period: '2026-W43',
    created_at: '2026-10-27T09:00:00.000Z',
    dismissed_at: null,
    ...over,
  }
}

interface Reply {
  status?: number
  body: unknown
}

interface Call {
  method: string
  path: string
  scope: string | null
}

// GET insights answers with `list`; GET habits with an invented habits
// read; a dismiss POST answers with what `dismiss` returns, or rejects when
// it throws (a network failure). Anything else rejects the test.
function installFetch(
  list: Insight[],
  dismiss: (call: Call) => Reply = () => ({ body: {} }),
) {
  const calls: Call[] = []
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      scope: url.searchParams.get('scope'),
    }
    calls.push(call)
    let reply: Reply
    if (call.method === 'GET' && call.path === '/api/v1/agents/insights') {
      reply = { body: { items: list } }
    } else if (call.method === 'GET' && call.path === '/api/v1/habits') {
      reply = { body: habitsResponse() }
    } else if (
      call.method === 'POST' &&
      /^\/api\/v1\/agents\/insights\/\d+\/dismiss$/.test(call.path)
    ) {
      reply = dismiss(call)
    } else {
      throw new Error(`unexpected ${call.method} ${call.path}`)
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', stub)
  return {
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
  }
}

function patterns(): HTMLElement {
  return screen.getByRole('region', { name: 'Patterns' })
}

function cardIds(): string[] {
  return [...document.querySelectorAll('[data-insight-id]')].map(
    (el) => el.getAttribute('data-insight-id') ?? '',
  )
}

function card(id: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-insight-id="${id}"]`)
  if (!el) throw new Error(`no insight ${id}`)
  return el
}

// The documents inside the chart iframes, parsed as a browser would parse
// them (scripts in a DOMParser document never run).
function frameDocs(root: ParentNode): Document[] {
  return Array.from(root.querySelectorAll('iframe'), (iframe) =>
    new DOMParser().parseFromString(iframe.getAttribute('srcdoc') ?? '', 'text/html'),
  )
}

function rectTitles(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('rect > title'), (el) => el.textContent ?? '')
}

describe('two seeded insights render both titles and bodies and one chart', () => {
  it('draws each insight in its own card, and the one chart', async () => {
    const fx = installFetch([
      insight(1, { chart_spec_json: JSON.stringify(CHART) }),
      insight(2),
    ])
    renderWithProviders(<PatternInsights scope="personal" />)

    expect(await screen.findByText('Invented pattern 1')).not.toBeNull()
    expect(cardIds()).toEqual(['1', '2'])
    expect(within(card(1)).getByText('Invented body 1')).not.toBeNull()
    expect(within(card(2)).getByText('Invented pattern 2')).not.toBeNull()
    expect(within(card(2)).getByText('Invented body 2')).not.toBeNull()
    expect(screen.queryByTestId('patterns-empty')).toBeNull()

    // Exactly one chart, and it is the first insight's.
    expect(patterns().querySelectorAll('iframe')).toHaveLength(1)
    expect(card(1).querySelectorAll('iframe')).toHaveLength(1)
    expect(rectTitles(frameDocs(card(1))[0])).toEqual([
      'Invented Grocer: $1,234.56',
      'Invented Cafe: $45.50',
    ])
    // The list is read for the screen's scope.
    expect(fx.calls).toEqual([
      { method: 'GET', path: '/api/v1/agents/insights', scope: 'personal' },
    ])
  })
})

describe('the chart drawn from known rows equals a hand query over the same rows', () => {
  // ISO week 2026-W43 runs Monday 19 to Sunday 25 October.
  const WEEK = '2026-W43'
  const ROWS: LedgerRow[] = [
    { date: '2026-10-19', accountId: 'acc-1', amountCents: -1234, category: 'Groceries', merchant: 'Invented Grocer' },
    { date: '2026-10-22', accountId: 'acc-1', amountCents: -5678, category: 'Groceries', merchant: 'Invented Grocer' },
    { date: '2026-10-20', accountId: 'acc-1', amountCents: -450, category: 'Eating out', merchant: 'Invented Cafe' },
    // A refund is not spend.
    { date: '2026-10-21', accountId: 'acc-1', amountCents: 200, category: 'Eating out', merchant: 'Invented Cafe' },
    { date: '2026-10-25', accountId: 'acc-1', amountCents: -9901, category: 'Transport', merchant: 'Invented Fuel' },
    // Outside the week on either side.
    { date: '2026-10-18', accountId: 'acc-1', amountCents: -777, category: 'Groceries', merchant: 'Invented Grocer' },
    { date: '2026-10-26', accountId: 'acc-1', amountCents: -333, category: 'Eating out', merchant: 'Invented Cafe' },
  ]

  // The hand query: outflows dated inside the week, summed per merchant.
  function handQuery(rows: LedgerRow[]): Map<string, number> {
    return rows
      .filter((r) => r.amountCents < 0 && r.date >= '2026-10-19' && r.date <= '2026-10-25')
      .reduce((sums, r) => sums.set(r.merchant, (sums.get(r.merchant) ?? 0) - r.amountCents), new Map<string, number>())
  }

  // "Invented Grocer: $1,234.56" -> ['Invented Grocer', 123456]
  function drawn(title: string): [string, number] {
    const match = /^(.*): \$([\d,]+)\.(\d\d)$/.exec(title)
    if (!match) throw new Error(`not a spend title: ${title}`)
    return [match[1], Number(match[2].replace(/,/g, '')) * 100 + Number(match[3])]
  }

  it('the bars carry the hand-summed cents of every merchant', async () => {
    const a: Aggregates = {
      week: WEEK,
      months: [],
      asOf: '2026-10-25',
      ledgerRowCount: ROWS.length,
      topMerchants: topMerchants(ROWS, WEEK),
      wow: weekOverWeek(ROWS, WEEK),
      unusual: [],
      monthly: [],
    }
    installFetch([
      insight(5, {
        title: `Top merchants and unusual spends, ${WEEK}`,
        body_md: topMerchantsMarkdown(a),
        chart_spec_json: JSON.stringify(topMerchantsChart(a)),
      }),
    ])
    renderWithProviders(<PatternInsights scope="personal" />)
    await screen.findByText(`Top merchants and unusual spends, ${WEEK}`)

    const hand = handQuery(ROWS)
    // Written out once, so a hand query that drifted from the fixture fails.
    expect([...hand]).toEqual([
      ['Invented Grocer', 6912],
      ['Invented Cafe', 450],
      ['Invented Fuel', 9901],
    ])
    const docs = frameDocs(card(5))
    expect(docs).toHaveLength(1)
    const bars = rectTitles(docs[0]).map(drawn)
    expect(new Map(bars)).toEqual(hand)
    expect(bars).toHaveLength(hand.size)
  })
})

describe('dismiss calls the route once and removes the insight; a failure says so and keeps it', () => {
  it('removes the card after one POST to its dismiss route', async () => {
    const fx = installFetch([insight(1), insight(2)])
    renderWithProviders(<PatternInsights scope="personal" />)
    await screen.findByText('Invented pattern 2')

    fireEvent.click(within(card(2)).getByRole('button', { name: 'Dismiss' }))
    // A second tap while the first is in flight sends nothing more.
    fireEvent.click(within(card(2)).getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => expect(cardIds()).toEqual(['1']))
    expect(fx.posts()).toEqual([
      { method: 'POST', path: '/api/v1/agents/insights/2/dismiss', scope: null },
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the last dismissed insight leaves the card to its empty state', async () => {
    installFetch([insight(3)])
    renderWithProviders(<PatternInsights scope="personal" />)
    await screen.findByText('Invented pattern 3')

    fireEvent.click(within(card(3)).getByRole('button', { name: 'Dismiss' }))

    expect(await screen.findByTestId('patterns-empty')).not.toBeNull()
    expect(cardIds()).toEqual([])
  })

  it('a refused dismiss shows the server message and keeps the card', async () => {
    const fx = installFetch([insight(1), insight(2)], () => ({
      status: 409,
      body: { error: 'Insight already dismissed' },
    }))
    renderWithProviders(<PatternInsights scope="personal" />)
    await screen.findByText('Invented pattern 2')

    fireEvent.click(within(card(2)).getByRole('button', { name: 'Dismiss' }))

    const alert = await within(patterns()).findByRole('alert')
    expect(alert.textContent).toBe("Couldn't dismiss that insight. Insight already dismissed")
    expect(cardIds()).toEqual(['1', '2'])
    expect(fx.posts()).toHaveLength(1)
  })

  it('an unreachable server on dismiss shows a message and keeps the card', async () => {
    installFetch([insight(1)], () => {
      throw new TypeError('Failed to fetch')
    })
    renderWithProviders(<PatternInsights scope="personal" />)
    await screen.findByText('Invented pattern 1')

    fireEvent.click(within(card(1)).getByRole('button', { name: 'Dismiss' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe("Couldn't dismiss that insight. The server could not be reached")
    expect(cardIds()).toEqual(['1'])
  })
})

// ---- A small part of InsightCard.test.tsx's sweep ----

const LINK_SCHEMES = new Set(['https:', 'mailto:'])
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'data', 'poster'])
const LIVE_ELEMENTS = new Set(['script', 'img', 'image', 'object', 'embed', 'link', 'iframe', 'svg', 'use', 'form'])

function allowedUrl(value: string): boolean {
  try {
    return LINK_SCHEMES.has(new URL(value).protocol)
  } catch {
    return false
  }
}

// Everything under `root` that could run or load, as readable findings.
function liveContent(root: ParentNode): string[] {
  const found: string[] = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.localName.toLowerCase()
    if (LIVE_ELEMENTS.has(tag)) found.push(`<${tag}>`)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) found.push(`${tag}[${name}]`)
      if (URL_ATTRIBUTES.has(name) && !allowedUrl(attr.value)) found.push(`${tag}[${name}=${attr.value}]`)
    }
  }
  return found
}

describe('a hostile insight from the API renders inert, through InsightCard', () => {
  it('the sweep finds live content when it is there', () => {
    const bad = document.createElement('div')
    bad.innerHTML = '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>'
    expect(liveContent(bad)).toEqual(['<img>', 'img[src=x]', 'img[onerror]', 'a[href=javascript:alert(1)]'])
  })

  it('a script and an onerror in the body, and a URL in the spec, run and load nothing', async () => {
    installFetch([
      insight(9, {
        title: '<script>alert(1)</script> Invented title',
        body_md: 'Spend <img src=x onerror=alert(1)> rose <script>alert(2)</script> [open](javascript:alert(3))',
        chart_spec_json: JSON.stringify({
          ...CHART,
          data: { values: [{ merchant: 'https://invented.example/x', spend_cents: 100 }] },
        }),
      }),
    ])
    const { container } = renderWithProviders(<PatternInsights scope="personal" />)
    await waitFor(() => expect(cardIds()).toEqual(['9']))

    expect(liveContent(container)).toEqual([])
    expect(container.querySelector('iframe')).toBeNull()
    expect(within(card(9)).getByText('Chart unavailable')).not.toBeNull()
    // The title's markup is text, never an element.
    expect(within(card(9)).getByRole('heading').textContent).toBe(
      '<script>alert(1)</script> Invented title',
    )
    expect(container.textContent).not.toContain('https://invented.example')
  })
})

describe('the only change to the Habits screen is the insights mounted in its Patterns card', () => {
  it('the Habits screen shows the scope’s insights in the Patterns card', async () => {
    const fx = installFetch([insight(1), insight(2)])
    renderWithProviders(<Habits />, { initialScope: 'strawb' })

    await within(await screen.findByRole('region', { name: 'Patterns' })).findByText(
      'Invented pattern 1',
    )
    expect(cardIds()).toEqual(['1', '2'])
    expect(screen.queryByTestId('patterns-empty')).toBeNull()
    expect(fx.calls.filter((c) => c.path === '/api/v1/agents/insights')).toEqual([
      { method: 'GET', path: '/api/v1/agents/insights', scope: 'strawb' },
    ])
  })

  it('with zero insights the card shows its own empty state', async () => {
    installFetch([])
    const { client } = renderWithProviders(<Habits />, { initialScope: 'personal' })
    await screen.findByRole('region', { name: 'Patterns' })
    // The empty state also shows while the list loads, so wait for the read.
    await waitFor(() =>
      expect(client.getQueryState(insightsKey('personal'))?.status).toBe('success'),
    )

    expect(screen.getByTestId('patterns-empty').textContent).toBe(
      'No patterns yet. Insights from your own spending arrive here later.',
    )
    expect(cardIds()).toEqual([])
  })

  it('a failed read says so in the card, instead of the empty state', async () => {
    installFetch([])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/habits') return new Response(JSON.stringify(habitsResponse()))
        if (path === '/api/v1/agents/insights') {
          return new Response(JSON.stringify({ error: 'Could not list insights' }), { status: 500 })
        }
        throw new Error(`unexpected ${path}`)
      }),
    )
    renderWithProviders(<Habits />)

    const alert = await within(await screen.findByRole('region', { name: 'Patterns' })).findByRole(
      'alert',
    )
    expect(alert.textContent).toBe("Couldn't load patterns. Could not list insights")
    expect(screen.queryByTestId('patterns-empty')).toBeNull()
  })
})

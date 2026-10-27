import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import ChartView from '../ChartView.tsx'
import { CHART_CSP, CHART_SANDBOX } from '../sandbox.ts'

// The insight chart (prd-04 Ruling 3, Ruling 8; #55). One describe per
// Done-when line; the sweep for live content over a whole card, container
// and srcdoc together, is in InsightCard.test.tsx. Every value is invented.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderSpec(spec: unknown) {
  return render(<ChartView specJson={JSON.stringify(spec)} />)
}

function frame(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector('iframe')
  if (!iframe) throw new Error('no iframe rendered')
  return iframe
}

// The iframe's document, parsed as a browser would parse it (scripts in a
// DOMParser document never run).
function frameDoc(container: HTMLElement): Document {
  return new DOMParser().parseFromString(frame(container).getAttribute('srcdoc') ?? '', 'text/html')
}

function texts(doc: Document, selector: string): string[] {
  return Array.from(doc.querySelectorAll(selector), (el) => el.textContent ?? '')
}

// topMerchantsChart's shape (server/agents/insights/prompt.ts).
const TOP_MERCHANTS = {
  title: 'Top merchants by spend',
  data: {
    values: [
      { merchant: 'Invented Grocer', spend_cents: 123456 },
      { merchant: 'Invented Cafe', spend_cents: 4550 },
      { merchant: 'Invented Fuel', spend_cents: 9900 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'merchant', type: 'nominal', title: 'Merchant' },
    y: { field: 'spend_cents', type: 'quantitative', title: 'Spend in cents' },
  },
}

// weekOverWeekChart's shape: negative changes draw below the zero line.
const WEEK_CHANGE = {
  title: 'Change in spend by category',
  data: {
    values: [
      { category: 'Invented Dining', change_cents: -2500 },
      { category: 'Invented Transport', change_cents: 1210 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'category', type: 'nominal', title: 'Category' },
    y: { field: 'change_cents', type: 'quantitative', title: 'Change in cents' },
  },
}

// monthlyChart's shape: bars grouped by the colour field.
const MONTHLY = {
  title: 'Spend by category per month',
  data: {
    values: [
      { month: '2026-08', category: 'Invented Groceries', spend_cents: 31000 },
      { month: '2026-08', category: 'Invented Dining', spend_cents: 8725 },
      { month: '2026-09', category: 'Invented Groceries', spend_cents: 29999 },
      { month: '2026-09', category: 'Invented Dining', spend_cents: 0 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'month', type: 'ordinal', title: 'Month' },
    y: { field: 'spend_cents', type: 'quantitative', title: 'Spend in cents' },
    color: { field: 'category', type: 'nominal', title: 'Category' },
  },
}

const LINE = {
  title: 'Invented visits per week',
  data: {
    values: [
      { week: 'Week 1', visits: 3, place: 'Invented North' },
      { week: 'Week 2', visits: 7.5, place: 'Invented North' },
      { week: 'Week 1', visits: -2, place: 'Invented South' },
      { week: 'Week 2', visits: 11, place: 'Invented South' },
    ],
  },
  mark: 'line',
  encoding: {
    x: { field: 'week', type: 'ordinal' },
    y: { field: 'visits', type: 'quantitative' },
    color: { field: 'place', type: 'nominal' },
  },
}

const AREA = {
  title: 'Invented balance',
  data: {
    values: [
      { day: '2026-10-01', balance_cents: 50000 },
      { day: '2026-10-02', balance_cents: -1999 },
      { day: '2026-10-03', balance_cents: 70001 },
    ],
  },
  mark: 'area',
  encoding: {
    x: { field: 'day', type: 'temporal' },
    y: { field: 'balance_cents', type: 'quantitative', title: 'Balance in cents' },
  },
}

const POINT = {
  data: {
    values: [
      { visits: 5, average_cents: 1200 },
      { visits: 2, average_cents: 875 },
      { visits: 9, average_cents: 4001 },
    ],
  },
  mark: 'point',
  encoding: {
    x: { field: 'visits', type: 'quantitative' },
    y: { field: 'average_cents', type: 'quantitative' },
  },
}

const ARC = {
  title: 'Invented share of spend',
  data: {
    values: [
      { category: 'Invented Rent', share_cents: 180000 },
      { category: 'Invented Food', share_cents: 64250 },
      { category: 'Invented Fun', share_cents: 1 },
    ],
  },
  mark: 'arc',
  encoding: {
    theta: { field: 'share_cents', type: 'quantitative' },
    color: { field: 'category', type: 'nominal' },
  },
}

const ARC_PLAIN = {
  data: { values: [{ share: 40 }, { share: 60.25 }] },
  mark: 'arc',
  encoding: { theta: { field: 'share', type: 'quantitative' } },
}

const VALID = { TOP_MERCHANTS, WEEK_CHANGE, MONTHLY, LINE, AREA, POINT, ARC, ARC_PLAIN }

describe('a hostile spec renders "Chart unavailable" and no iframe', () => {
  const hostile: Record<string, unknown> = {
    'a URL in a label': {
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: 'https://invented.example/x', spend_cents: 100 }] },
    },
    'a URL as the data source': { ...TOP_MERCHANTS, data: { url: 'https://invented.example/data.json' } },
    'an unknown mark': { ...TOP_MERCHANTS, mark: 'image' },
    'a script in the title': { ...TOP_MERCHANTS, title: '<script>alert(1)</script>' },
    'a bidi override in a label': {
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: 'Invented ‮efac', spend_cents: 100 }] },
    },
  }

  it.each(Object.entries(hostile))('%s', (_, spec) => {
    const { container } = renderSpec(spec)
    expect(container.textContent).toBe('Chart unavailable')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('shows a label that spells markup as text, never as an element', () => {
    const { container } = renderSpec({
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: '&lt;b&gt; & co', spend_cents: 100 }] },
    })
    const doc = frameDoc(container)
    expect(texts(doc, 'rect > title')).toEqual(['&lt;b&gt; & co: $1.00'])
    expect(doc.querySelector('b')).toBeNull()
  })

  it('isolates every label, so a right-to-left name cannot reorder an amount', () => {
    const { container } = renderSpec({
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: 'מאפייה', spend_cents: 2500 }] },
    })
    const doc = frameDoc(container)
    const labels = Array.from(doc.querySelectorAll('text'))
    expect(labels.length).toBeGreaterThan(0)
    for (const text of labels) expect(text.getAttribute('unicode-bidi')).toBe('isolate')
    expect(texts(doc, 'text')).toContain('מאפייה')
  })

  it('strips the LRM and RLM marks the spec check lets through', () => {
    const { container } = renderSpec({
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: 'Invented‎ Cafe‏', spend_cents: 2500 }] },
    })
    const markup = frame(container).getAttribute('srcdoc') ?? ''
    expect(markup).not.toMatch(/[‎‏]/)
    expect(texts(frameDoc(container), 'rect > title')).toEqual(['Invented Cafe: $25.00'])
  })
})

describe('rendering a valid chart makes no request and evaluates nothing', () => {
  it.each(Object.entries(VALID))('%s', (_, spec) => {
    const calls: string[] = []
    const record = (name: string) =>
      vi.fn(() => {
        calls.push(name)
      })
    vi.stubGlobal('fetch', record('fetch'))
    vi.stubGlobal('XMLHttpRequest', record('XMLHttpRequest'))
    vi.stubGlobal('Image', record('Image'))
    // Proxies keep `instanceof Function` and the prototype intact for
    // everything else in the test run, and record any call that reaches them.
    const tracking = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        apply(fn, self, args) {
          calls.push(name)
          return Reflect.apply(fn as (...a: unknown[]) => unknown, self, args)
        },
        construct(fn, args) {
          calls.push(name)
          return Reflect.construct(fn as new (...a: unknown[]) => object, args)
        },
      })
    vi.stubGlobal('eval', tracking('eval', globalThis.eval))
    vi.stubGlobal('Function', tracking('Function', globalThis.Function))
    const createElement = vi.spyOn(document, 'createElement')

    const { container } = renderSpec(spec)

    expect(container.querySelector('iframe')).not.toBeNull()
    expect(calls).toEqual([])
    const created = createElement.mock.calls.map(([tag]) => String(tag).toLowerCase())
    expect(created.filter((tag) => ['img', 'script', 'link', 'object', 'embed'].includes(tag))).toEqual([])
  })
})

describe('the chart container is sandboxed and carries a restrictive CSP', () => {
  it('grants the iframe neither scripts nor same-origin', () => {
    const { container } = renderSpec(TOP_MERCHANTS)
    const iframe = frame(container)
    expect(iframe.hasAttribute('sandbox')).toBe(true)
    const sandbox = iframe.getAttribute('sandbox') ?? ''
    // Empty, not merely the constant: any token would grant something.
    expect(sandbox).toBe('')
    expect(CHART_SANDBOX).toBe('')
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.hasAttribute('src')).toBe(false)
  })

  it('sets the CSP on the iframe and inside its document', () => {
    const { container } = renderSpec(TOP_MERCHANTS)
    expect(frame(container).getAttribute('csp')).toBe(CHART_CSP)
    const metas = frameDoc(container).querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    expect(metas).toHaveLength(1)
    expect(metas[0].getAttribute('content')).toBe(CHART_CSP)
  })

  it('allows nothing to load, and only inline style', () => {
    expect(CHART_CSP.split(';').map((d) => d.trim())).toEqual([
      "default-src 'none'",
      "style-src 'unsafe-inline'",
    ])
  })
})

describe('a valid spec of each mark renders the numbers it holds', () => {
  it('bar, from topMerchantsChart: dollars from cents, and "in cents" dropped from the axis', () => {
    const doc = frameDoc(renderSpec(TOP_MERCHANTS).container)
    expect(texts(doc, 'rect > title')).toEqual([
      'Invented Grocer: $1,234.56',
      'Invented Cafe: $45.50',
      'Invented Fuel: $99.00',
    ])
    const labels = texts(doc, 'text')
    expect(labels).toContain('Spend')
    expect(labels).toContain('Merchant')
    expect(labels).toContain('Top merchants by spend')
    expect(labels.some((t) => t.includes('in cents'))).toBe(false)
  })

  it('bar with negative values, from weekOverWeekChart', () => {
    const doc = frameDoc(renderSpec(WEEK_CHANGE).container)
    expect(texts(doc, 'rect > title')).toEqual([
      'Invented Dining: -$25.00',
      'Invented Transport: $12.10',
    ])
  })

  it('bar grouped by colour, from monthlyChart', () => {
    const doc = frameDoc(renderSpec(MONTHLY).container)
    expect(texts(doc, 'rect > title')).toEqual([
      '2026-08, Invented Groceries: $310.00',
      '2026-08, Invented Dining: $87.25',
      '2026-09, Invented Groceries: $299.99',
      '2026-09, Invented Dining: $0.00',
    ])
    // Grouped: the two series in a month sit side by side, not stacked.
    const [a, b] = Array.from(doc.querySelectorAll('rect > title'), (t) => t.parentElement)
    expect(Number(b?.getAttribute('x'))).toBeGreaterThan(Number(a?.getAttribute('x')))
    expect(texts(doc, 'text')).toEqual(expect.arrayContaining(['Invented Groceries', 'Invented Dining']))
  })

  it('line, one path per colour value, numbers as written', () => {
    const doc = frameDoc(renderSpec(LINE).container)
    expect(texts(doc, 'circle > title')).toEqual([
      'Week 1, Invented North: 3',
      'Week 2, Invented North: 7.5',
      'Week 1, Invented South: -2',
      'Week 2, Invented South: 11',
    ])
    expect(texts(doc, 'path > title')).toEqual(['Invented North', 'Invented South'])
  })

  it('area', () => {
    const doc = frameDoc(renderSpec(AREA).container)
    expect(texts(doc, 'circle > title')).toEqual([
      '2026-10-01: $500.00',
      '2026-10-02: -$19.99',
      '2026-10-03: $700.01',
    ])
    expect(doc.querySelectorAll('path')).toHaveLength(1)
  })

  it('point, with a quantitative x', () => {
    const doc = frameDoc(renderSpec(POINT).container)
    expect(texts(doc, 'circle > title')).toEqual(['5: $12.00', '2: $8.75', '9: $40.01'])
    expect(doc.querySelectorAll('path')).toHaveLength(0)
  })

  it('arc, slices labelled by the colour field', () => {
    const doc = frameDoc(renderSpec(ARC).container)
    expect(texts(doc, 'path > title')).toEqual([
      'Invented Rent: $1,800.00',
      'Invented Food: $642.50',
      'Invented Fun: $0.01',
    ])
  })

  it('bar heights follow the values: the tallest bar is the largest, a negative bar hangs below zero', () => {
    const doc = frameDoc(renderSpec(TOP_MERCHANTS).container)
    const heights = Array.from(doc.querySelectorAll('rect > title'), (t) =>
      Number(t.parentElement?.getAttribute('height')),
    )
    // 123456 : 4550 : 9900, to within a pixel of rounding.
    expect(Math.max(...heights)).toBe(heights[0])
    expect(heights[1] / heights[0]).toBeCloseTo(4550 / 123456, 2)
    expect(heights[2] / heights[0]).toBeCloseTo(9900 / 123456, 2)

    const change = frameDoc(renderSpec(WEEK_CHANGE).container)
    const [down, up] = Array.from(change.querySelectorAll('rect > title'), (t) => t.parentElement)
    const upBottom = Number(up?.getAttribute('y')) + Number(up?.getAttribute('height'))
    expect(Number(down?.getAttribute('y'))).toBeCloseTo(upBottom, 1)
    expect(Number(down?.getAttribute('height')) / Number(up?.getAttribute('height'))).toBeCloseTo(2500 / 1210, 1)
  })

  it('arc legend cuts a long name, never the amount', () => {
    const doc = frameDoc(
      renderSpec({
        ...ARC,
        data: {
          values: [
            { category: 'Invented Grocer Wholesale Ltd', share_cents: 123456 },
            { category: 'Invented Food', share_cents: 100 },
          ],
        },
      }).container,
    )
    const legend = texts(doc, 'text')
    expect(legend.some((t) => t.endsWith(': $1,234.56') && t.includes('…'))).toBe(true)
    expect(legend).toContain('Invented Food: $1.00')
  })

  it('arc without a colour field', () => {
    const doc = frameDoc(renderSpec(ARC_PLAIN).container)
    expect(texts(doc, 'path > title')).toEqual(['Slice 1: 40', 'Slice 2: 60.25'])
  })

  it('skips a row whose value is null', () => {
    const doc = frameDoc(
      renderSpec({
        ...TOP_MERCHANTS,
        data: {
          values: [
            { merchant: 'Invented Grocer', spend_cents: 1500 },
            { merchant: 'Invented Gap', spend_cents: null },
          ],
        },
      }).container,
    )
    expect(texts(doc, 'rect > title')).toEqual(['Invented Grocer: $15.00'])
  })

  it('renders nothing for an insight without a chart', () => {
    const { container } = render(<ChartView specJson={null} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('a chart that cannot be drawn says "Chart unavailable"', () => {
  const broken: Record<string, string> = {
    'invalid JSON': '{"mark": "bar",',
    'an invalid spec': JSON.stringify({ ...TOP_MERCHANTS, encoding: {} }),
    'text in a quantitative channel': JSON.stringify({
      ...LINE,
      data: { values: [{ week: 'Week 1', visits: 'lots', place: 'Invented North' }] },
    }),
    'a boolean in a quantitative channel': JSON.stringify({
      ...LINE,
      data: { values: [{ week: 'Week 1', visits: true, place: 'Invented North' }] },
    }),
    'a fraction of a cent': JSON.stringify({
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: 'Invented Grocer', spend_cents: 12.5 }] },
    }),
    'a y channel that is not quantitative': JSON.stringify({
      ...TOP_MERCHANTS,
      encoding: { ...TOP_MERCHANTS.encoding, y: { field: 'merchant', type: 'nominal' } },
    }),
    'a negative slice': JSON.stringify({
      ...ARC_PLAIN,
      data: { values: [{ share: 40 }, { share: -1 }] },
    }),
    'only null values': JSON.stringify({
      ...TOP_MERCHANTS,
      data: { values: [{ merchant: 'Invented Gap', spend_cents: null }] },
    }),
  }

  it.each(Object.entries(broken))('%s', (_, specJson) => {
    const { container } = render(<ChartView specJson={specJson} />)
    expect(container.textContent).toBe('Chart unavailable')
    expect(container.querySelector('iframe')).toBeNull()
  })
})

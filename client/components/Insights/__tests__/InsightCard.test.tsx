import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Insight } from '../../../../models/insights.ts'
import InsightCard from '../InsightCard.tsx'

// One insight card (prd-04 Ruling 2, Ruling 3; #55). The first describe is
// Done-when 1 over a whole card: every hostile fixture is rendered, and the
// rendered page and the document inside any chart iframe are both swept for
// anything that could run or load. Every value is invented.

afterEach(cleanup)

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

function insight(over: Partial<Insight> = {}): Insight {
  return {
    id: 7,
    kind: 'pattern',
    title: 'Invented top merchants, 2026-W43',
    body_md: '## Top merchants\n\n- `Invented Grocer` $1,234.56 across 3 transactions',
    chart_spec_json: JSON.stringify(CHART),
    scope: 'personal',
    period: '2026-W43',
    created_at: '2026-10-27T09:00:00.000Z',
    dismissed_at: null,
    ...over,
  }
}

// ---- The sweep ----

const LINK_SCHEMES = new Set(['https:', 'mailto:'])
const URL_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'srcset',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'ping',
])
// Elements that run code, load something, or embed another document.
const LIVE_ELEMENTS = new Set([
  'script',
  'img',
  'image',
  'object',
  'embed',
  'link',
  'foreignobject',
  'iframe',
  'frame',
  'use',
  'audio',
  'video',
  'source',
  'base',
  'form',
  'svg',
])

function allowedUrl(value: string): boolean {
  try {
    return LINK_SCHEMES.has(new URL(value).protocol)
  } catch {
    return false
  }
}

// Everything under `root` that could run or load, as readable findings.
// `allow` names the elements this root is expected to hold (the chart's
// iframe on the page; the SVG and its meta and style inside the iframe).
function liveContent(root: ParentNode, allow: string[]): string[] {
  const found: string[] = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.localName.toLowerCase()
    if (LIVE_ELEMENTS.has(tag) && !allow.includes(tag)) found.push(`<${tag}>`)
    if (tag === 'style' && /url\(|@import/i.test(el.textContent ?? '')) found.push('<style> with a url')
    if (tag === 'meta' && el.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
      found.push('<meta refresh>')
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) found.push(`${tag}[${name}]`)
      if (URL_ATTRIBUTES.has(name) && !allowedUrl(attr.value)) found.push(`${tag}[${name}=${attr.value}]`)
      if (name === 'style' && /url\(/i.test(attr.value)) found.push(`${tag}[style] with a url`)
    }
  }
  return found
}

function frameDocs(container: HTMLElement): Document[] {
  return Array.from(container.querySelectorAll('iframe'), (iframe) =>
    new DOMParser().parseFromString(iframe.getAttribute('srcdoc') ?? '', 'text/html'),
  )
}

function sweep(container: HTMLElement): string[] {
  return [
    ...liveContent(container, ['iframe']),
    ...frameDocs(container).flatMap((doc) => liveContent(doc, ['svg', 'meta', 'style'])),
  ]
}

describe('hostile content renders nothing that runs or loads', () => {
  it('finds live content when it is there', () => {
    const bad = document.createElement('div')
    bad.innerHTML =
      '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a><svg><foreignObject/></svg>'
    expect(liveContent(bad, [])).toEqual([
      '<img>',
      'img[src=x]',
      'img[onerror]',
      'a[href=javascript:alert(1)]',
      '<svg>',
      '<foreignobject>',
    ])
  })

  const hostileBodies: Record<string, string> = {
    'an img with onerror': 'Spend <img src=x onerror=alert(1)> rose',
    'a script tag': '<script>alert(1)</script>',
    'a javascript link': '[open](javascript:alert(1))',
    'a data link': '[open](data:text/html;base64,PHNjcmlwdD4=)',
    'a vbscript link': '[open](vbscript:msgbox(1))',
    'a mixed-case javascript link': '[open]( JaVaScRiPt:alert(1))',
    'an image': '![x](https://invented.example/track.png)',
    'an svg with an onload': '<svg onload=alert(1)><use href="//invented.example/#x"/></svg>',
    'a bidi override': 'Invented ‮efac‬ $5.00',
  }

  it.each(Object.entries(hostileBodies))('a body with %s', (_, body_md) => {
    const { container } = render(<InsightCard insight={insight({ body_md })} />)
    expect(sweep(container)).toEqual([])
    expect(container.textContent).not.toMatch(/[‪-‮⁦-⁩]/)
  })

  const hostileCharts: Record<string, unknown> = {
    'a URL in a label': {
      ...CHART,
      data: { values: [{ merchant: 'javascript:alert(1)', spend_cents: 100 }] },
    },
    'an unknown mark': { ...CHART, mark: 'image' },
    'a script in the title': { ...CHART, title: '<script>alert(1)</script>' },
  }

  it.each(Object.entries(hostileCharts))('a chart with %s shows "Chart unavailable"', (_, spec) => {
    const { container } = render(
      <InsightCard insight={insight({ chart_spec_json: JSON.stringify(spec) })} />,
    )
    expect(screen.getByText('Chart unavailable')).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
    expect(sweep(container)).toEqual([])
  })

  it.each(['bar', 'line', 'area', 'point'])('a valid %s chart holds nothing live', (mark) => {
    const spec = { ...CHART, mark }
    const { container } = render(
      <InsightCard insight={insight({ chart_spec_json: JSON.stringify(spec) })} />,
    )
    expect(frameDocs(container)).toHaveLength(1)
    expect(sweep(container)).toEqual([])
  })

  it('a valid arc chart holds nothing live', () => {
    const spec = {
      data: { values: [{ category: 'Invented Rent', share_cents: 100 }] },
      mark: 'arc',
      encoding: {
        theta: { field: 'share_cents', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    }
    const { container } = render(
      <InsightCard insight={insight({ chart_spec_json: JSON.stringify(spec) })} />,
    )
    expect(frameDocs(container)).toHaveLength(1)
    expect(sweep(container)).toEqual([])
  })

  // Labels the spec check lets through that spell markup or break out of
  // an attribute. Drawn as text, each must reach its <text> node literally.
  // Short enough that five categories never clip them.
  const MARKUP_LABELS = ['&lt;b&gt;', '&#x3c;i', "'on='x", '&quot;>y', 'a"b>c&d']
  const labelled = (mark: string) => ({
    title: 'Invented labels',
    data: {
      values: MARKUP_LABELS.map((name, i) => ({
        merchant: name,
        group: MARKUP_LABELS[(i + 1) % MARKUP_LABELS.length],
        spend_cents: 100 * (i + 1),
      })),
    },
    mark,
    encoding:
      mark === 'arc'
        ? {
            theta: { field: 'spend_cents', type: 'quantitative' },
            color: { field: 'merchant', type: 'nominal' },
          }
        : {
            x: { field: 'merchant', type: 'nominal' },
            y: { field: 'spend_cents', type: 'quantitative' },
            color: { field: 'group', type: 'nominal' },
          },
  })

  it.each(['bar', 'line', 'arc'])(
    'a %s chart whose axis and legend labels spell markup shows them as literal text',
    (mark) => {
      const { container } = render(
        <InsightCard insight={insight({ chart_spec_json: JSON.stringify(labelled(mark)) })} />,
      )
      const docs = frameDocs(container)
      expect(docs).toHaveLength(1)
      expect(sweep(container)).toEqual([])
      const shown = Array.from(docs[0].querySelectorAll('text'), (t) => t.textContent ?? '')
      for (const name of MARKUP_LABELS) {
        // On the x axis and in the colour legend (bar, line), or in the
        // arc legend beside its amount.
        const hits = shown.filter((t) => t === name || t.startsWith(`${name}: $`))
        expect(hits.length, name).toBeGreaterThanOrEqual(mark === 'arc' ? 1 : 2)
      }
      expect(docs[0].querySelector('b, i')).toBeNull()
    },
  )

  it('shows a hostile title as text, with bidi controls removed', () => {
    const { container } = render(
      <InsightCard insight={insight({ title: '<img src=x onerror=alert(1)>‮ Invented' })} />,
    )
    expect(container.querySelector('h3')?.textContent).toBe('<img src=x onerror=alert(1)> Invented')
    expect(sweep(container)).toEqual([])
  })
})

describe('the card shows an insight and can dismiss it', () => {
  it('renders the title, the body and the chart', () => {
    const { container } = render(<InsightCard insight={insight()} />)
    expect(container.querySelector('h3')?.textContent).toBe('Invented top merchants, 2026-W43')
    expect(container.querySelector('h4')?.textContent).toBe('Top merchants')
    expect(container.querySelector('li')?.textContent).toBe(
      'Invented Grocer $1,234.56 across 3 transactions',
    )
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe('Top merchants by spend')
  })

  it('renders no chart for an insight without one', () => {
    const { container } = render(<InsightCard insight={insight({ chart_spec_json: null })} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.queryByText('Chart unavailable')).toBeNull()
  })

  it('calls onDismiss with the insight id', () => {
    const onDismiss = vi.fn()
    render(<InsightCard insight={insight({ id: 42 })} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith(42)
  })

  it('has no Dismiss button without onDismiss', () => {
    render(<InsightCard insight={insight()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

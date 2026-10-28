import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import InsightBody, { MAX_BODY_CHARS } from '../InsightBody.tsx'

// An insight's markdown body (prd-04 Ruling 3, Ruling 8; #55). The hostile
// describe is Done-when 1's markdown half; the sweep for live content over a
// whole card is in InsightCard.test.tsx. Every value is invented.

afterEach(cleanup)

function body(markdown: string): HTMLElement {
  return render(<InsightBody markdown={markdown} />).container
}

// How many characters `String.prototype.indexOf` scans while `renderOnce`
// runs: the span from each search's start to its hit, or to the end on a miss.
function charsSearched(renderOnce: () => void): number {
  const original = String.prototype.indexOf
  let scanned = 0
  const spy = vi
    .spyOn(String.prototype, 'indexOf')
    .mockImplementation(function (this: string, needle: string, from?: number) {
      const at = original.call(this, needle, from)
      const start = from ?? 0
      scanned += at === -1 ? Math.max(0, this.length - start) : at - start + needle.length
      return at
    })
  try {
    renderOnce()
  } finally {
    spy.mockRestore()
  }
  return scanned
}

function tags(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('*'), (el) => el.localName)
}

describe('hostile markdown renders as text', () => {
  it('shows an img tag with an onerror handler as its characters', () => {
    const root = body('Before <img src=x onerror=alert(1)> after')
    expect(root.textContent).toBe('Before <img src=x onerror=alert(1)> after')
    expect(root.querySelector('img')).toBeNull()
  })

  it('shows a script tag as its characters', () => {
    const root = body('<script>alert(1)</script>')
    expect(root.textContent).toBe('<script>alert(1)</script>')
    expect(root.querySelector('script')).toBeNull()
  })

  it.each([
    ['javascript', '[Invented link](javascript:alert(1))'],
    ['mixed-case javascript after a space', '[Invented link]( JaVaScRiPt:alert(1))'],
    ['data', '[Invented link](data:text/html,<b>x</b>)'],
    ['vbscript', '[Invented link](vbscript:msgbox(1))'],
    ['plain http', '[Invented link](http://invented.example/)'],
    ['relative', '[Invented link](/settings)'],
    ['protocol-relative', '[Invented link](//invented.example/)'],
    ['https with a user before the host', '[Invented link](https://bnz.co.nz@invented.example/)'],
    ['https with a user and password', '[Invented link](https://a:b@invented.example/)'],
  ])('shows a %s link as its label, with no anchor', (_, markdown) => {
    const root = body(markdown)
    expect(root.querySelector('a')).toBeNull()
    expect(root.textContent?.startsWith('Invented link')).toBe(true)
  })

  it('keeps an https link, with its parsed href and no referrer', () => {
    const root = body('See [the invented page](https://invented.example/a b) now')
    // A space ends nothing here: the destination as written is parsed by URL.
    const link = root.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://invented.example/a%20b')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(link?.textContent).toBe('the invented page')
  })

  it('keeps a mailto link', () => {
    const link = body('[Write](mailto:someone@invented.example)').querySelector('a')
    expect(link?.getAttribute('href')).toBe('mailto:someone@invented.example')
  })

  it('shows an image as its alt text, never an img', () => {
    const root = body('![Invented chart](https://invented.example/x.png)')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('a')).toBeNull()
    expect(root.textContent).toBe('Invented chart')
  })

  it('does not autolink a bare URL, domain or address', () => {
    const root = body('Visit https://invented.example or www.invented.example or a@invented.example')
    expect(root.querySelector('a')).toBeNull()
    expect(root.textContent).toBe(
      'Visit https://invented.example or www.invented.example or a@invented.example',
    )
  })

  it('shows a semicolon-less entity as its characters', () => {
    expect(body('`&lt` and &amp').textContent).toBe('&lt and &amp')
  })

  it('wraps code spans and link labels in bdi, so a right-to-left label cannot reorder an amount', () => {
    const root = body('- `מאפייה` $12.50 and [שלום](https://invented.example/)')
    const isolated = Array.from(root.querySelectorAll('bdi'), (el) => el.textContent)
    expect(isolated).toEqual(['מאפייה', 'שלום'])
    expect(root.querySelector('bdi > code')?.textContent).toBe('מאפייה')
  })

  it('strips bidi controls from all text', () => {
    const root = body('Invented‮ cafe⁦ `x‏y` ‎$5.00⁩ [a‪b](https://invented.example/)')
    expect(root.textContent).not.toMatch(/[‎‏‪-‮⁦-⁩]/)
    expect(root.textContent).toBe('Invented cafe xy $5.00 ab')
  })

  it('strips the Arabic letter mark too', () => {
    const root = body('Invented\u061C cafe `x\u061Cy`')
    expect(root.textContent).toBe('Invented cafe xy')
  })

  it('cuts an oversized body and says so', () => {
    const root = body('a'.repeat(MAX_BODY_CHARS + 50))
    expect(root.querySelector('p')?.textContent).toBe('a'.repeat(MAX_BODY_CHARS))
    expect(root.textContent).toContain('The rest of this insight is too long to show.')
  })

  it('searches a linear number of characters on unclosed delimiters at the length cap', () => {
    // Counts characters searched by indexOf, not time, so load cannot move it.
    const renders = [
      () => body('[*_`'.repeat(MAX_BODY_CHARS / 4)),
      () => body('[a]('.repeat(MAX_BODY_CHARS / 4)),
      () => body('**a'.repeat(MAX_BODY_CHARS / 3)),
    ]
    for (const render of renders) {
      expect(charsSearched(render)).toBeLessThan(10 * MAX_BODY_CHARS)
    }
  })
})

describe('the markdown real insights contain renders as elements', () => {
  // topMerchantsMarkdown's shape (server/agents/insights/prompt.ts).
  const TOP = [
    '## Top merchants',
    '',
    '- `Invented Grocer` $1,234.56 across 3 transactions',
    '- `Invented Cafe` $45.50 across 1 transaction',
    '',
    '## Unusual spends',
    '',
    "Nothing stood out against each merchant's recent spending.",
  ].join('\n')

  it('draws headings, a list with code spans, and a paragraph', () => {
    const root = body(TOP)
    expect(Array.from(root.querySelectorAll('h4'), (h) => h.textContent)).toEqual([
      'Top merchants',
      'Unusual spends',
    ])
    expect(Array.from(root.querySelectorAll('li'), (li) => li.textContent)).toEqual([
      'Invented Grocer $1,234.56 across 3 transactions',
      'Invented Cafe $45.50 across 1 transaction',
    ])
    expect(Array.from(root.querySelectorAll('code'), (c) => c.textContent)).toEqual([
      'Invented Grocer',
      'Invented Cafe',
    ])
    expect(root.querySelector('p')?.textContent).toBe(
      "Nothing stood out against each merchant's recent spending.",
    )
  })

  it('draws emphasis, strong, an ordered list, and joins wrapped lines', () => {
    const root = body('A *small* and _quiet_ **change**\ncontinues here.\n\n3. third\n4. fourth')
    expect(root.querySelector('em')?.textContent).toBe('small')
    expect(Array.from(root.querySelectorAll('em'), (e) => e.textContent)).toEqual(['small', 'quiet'])
    expect(root.querySelector('strong')?.textContent).toBe('change')
    expect(root.querySelector('p')?.textContent).toBe('A small and quiet change continues here.')
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3')
    expect(Array.from(root.querySelectorAll('ol > li'), (li) => li.textContent)).toEqual([
      'third',
      'fourth',
    ])
  })

  it('leaves snake_case words and spaced asterisks alone', () => {
    const root = body('invented_field_name and 2 * 3 * 4')
    expect(root.querySelector('em')).toBeNull()
    expect(root.textContent).toBe('invented_field_name and 2 * 3 * 4')
  })

  it('draws only the tags it knows', () => {
    const root = body(TOP + '\n\n**a** *b* `c` [d](https://invented.example/)\n\n1. e')
    const allowed = new Set(['div', 'h4', 'p', 'ul', 'ol', 'li', 'em', 'strong', 'code', 'bdi', 'a'])
    expect(tags(root).filter((t) => !allowed.has(t))).toEqual([])
  })
})

import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHART_CHANNEL_TYPES,
  CHART_LIMITS,
  CHART_MARKS,
  CHART_SCHEMA_URL,
  INSIGHT_KINDS,
  parseChartSpecJson,
  validateChartSpec,
  type ChartSpecRejection,
  type ChartSpecResult,
  type Insight,
} from '../insights.ts'

// Issue #26: the chart spec is data, checked on write and on render
// (prd-04 Ruling 3, Done when 5). Every fixture is invented. Every hostile
// fixture carries CANARY, and no rejection may contain it.

const modelsDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..')
const CANARY = 'InventedCanary7f3a'

type Loose = { [key: string]: unknown }
interface MutableSpec extends Loose {
  data: Loose & { values: Loose[] }
  encoding: Loose & { x: Loose; y: Loose }
}

const BASE = {
  $schema: CHART_SCHEMA_URL,
  title: 'Example weekly spend',
  data: {
    values: [
      { week: 'Sample W1', cents: 1200, flagged: false, note: null },
      { week: 'Sample W2', cents: 3400, flagged: true, note: 'Invented a+b label' },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'week', type: 'nominal' },
    y: { field: 'cents', type: 'quantitative', title: 'Invented total' },
  },
}

function base(): MutableSpec {
  return structuredClone(BASE)
}

function arc(): Loose {
  const spec: Loose = base()
  spec.mark = 'arc'
  spec.encoding = {
    theta: { field: 'cents', type: 'quantitative' },
    color: { field: 'week', type: 'nominal' },
  }
  return spec
}

function rejection(result: ChartSpecResult): { reason: ChartSpecRejection; path: string } {
  if (result.ok) throw new Error('expected a rejection, got ok')
  return { reason: result.reason, path: result.path }
}

function rowsOf(count: number): Loose[] {
  return Array.from({ length: count }, (_, i) => ({ week: `Sample W${i}`, cents: i }))
}

describe('accepted specs', () => {
  it('accepts the base spec and returns it field for field', () => {
    const result = validateChartSpec(base())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec).toStrictEqual(BASE)
    expect(Object.keys(result.spec).sort()).toEqual(['$schema', 'data', 'encoding', 'mark', 'title'])
    expect(Object.keys(result.spec.encoding).sort()).toEqual(['x', 'y'])
    expect(Object.keys(result.spec.encoding.y ?? {}).sort()).toEqual(['field', 'title', 'type'])
    expect(Object.keys(result.spec.data.values[0]).sort()).toEqual(['cents', 'flagged', 'note', 'week'])
  })

  it('pins the mark allow-list to the five Ruling 3 marks', () => {
    expect([...CHART_MARKS]).toEqual(['bar', 'line', 'area', 'point', 'arc'])
  })

  it.each(['bar', 'line', 'area', 'point'])('accepts mark %s with x and y', (mark) => {
    const spec = base()
    spec.mark = mark
    expect(validateChartSpec(spec).ok).toBe(true)
  })

  it('accepts mark arc with theta and color', () => {
    const result = validateChartSpec(arc())
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.spec.encoding).sort()).toEqual(['color', 'theta'])
  })

  it('accepts a spec with no $schema and no title', () => {
    const spec: Loose = base()
    delete spec.$schema
    delete spec.title
    const result = validateChartSpec(spec)
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.spec).sort()).toEqual(['data', 'encoding', 'mark'])
  })

  it('accepts null-prototype objects', () => {
    const bare = Object.assign(Object.create(null), base())
    expect(validateChartSpec(bare).ok).toBe(true)
  })

  it('pins the channel types and insight kinds', () => {
    expect([...CHART_CHANNEL_TYPES]).toEqual(['quantitative', 'nominal', 'ordinal', 'temporal'])
    expect([...INSIGHT_KINDS]).toEqual(['pattern', 'report', 'chart'])
    expect(CHART_SCHEMA_URL).toBe('https://vega.github.io/schema/vega-lite/v5.json')
  })

  it('types an insights row with an optional opaque mermaid field', () => {
    const row = {
      id: 1,
      kind: 'chart',
      title: 'Example pattern',
      body_md: 'Sample body',
      chart_spec_json: JSON.stringify(BASE),
      scope: 'personal',
      period: '2026-W43',
      created_at: '2026-10-25T03:00:00.000Z',
      dismissed_at: null,
      mermaid: 'graph TD; Example-->Sample',
    } satisfies Insight
    expect(parseChartSpecJson(row.chart_spec_json).ok).toBe(true)
  })
})

describe('the returned spec is a fresh copy', () => {
  it('is deep-equal to the input, not the input, and unaffected by later edits', () => {
    const input = base()
    const result = validateChartSpec(input)
    if (!result.ok) throw new Error('expected ok')
    expect(result.spec).toStrictEqual(BASE)
    expect(result.spec).not.toBe(input)
    expect(result.spec.data).not.toBe(input.data)
    expect(result.spec.data.values).not.toBe(input.data.values)
    expect(result.spec.data.values[0]).not.toBe(input.data.values[0])
    expect(result.spec.encoding.x).not.toBe(input.encoding.x)

    input.title = `javascript:${CANARY}`
    input.data.values[0].week = CANARY
    input.encoding.x.field = CANARY
    expect(result.spec).toStrictEqual(BASE)
  })
})

describe('mark rejections', () => {
  it.each<[string, unknown]>([
    ['text', 'text'],
    ['rect', 'rect'],
    ['geoshape', 'geoshape'],
    ['rule', 'rule'],
    ['capitalised', 'Bar'],
    ['trailing space', 'bar '],
    ['object form', { type: 'bar' }],
    ['empty', ''],
    ['numeric', 1],
  ])('rejects mark %s', (_name, mark) => {
    const spec = base()
    spec.mark = mark
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'bad_mark', path: '$.mark' })
  })
})

// Each patch makes the base spec hostile in exactly one way.
const HOSTILE: [string, (spec: MutableSpec) => void, ChartSpecRejection, string][] = [
  ['data.url', (s) => { s.data.url = `https://${CANARY}.example/rows.csv` }, 'forbidden_key', '$.data'],
  ['data.name', (s) => { s.data.name = CANARY }, 'forbidden_key', '$.data'],
  ['data.format', (s) => { s.data.format = { type: CANARY } }, 'forbidden_key', '$.data'],
  ['data as url only', (s) => { s.data = { url: CANARY, values: [] } }, 'forbidden_key', '$.data'],
  ['datasets', (s) => { s.datasets = { Sample: [{ week: CANARY }] } }, 'forbidden_key', '$'],
  ['transform filter', (s) => { s.transform = [{ filter: `datum.${CANARY} > 1` }] }, 'forbidden_key', '$'],
  ['transform calculate', (s) => { s.transform = [{ calculate: '1+1', as: CANARY }] }, 'forbidden_key', '$'],
  ['filter at root', (s) => { s.filter = `datum.${CANARY}>1` }, 'forbidden_key', '$'],
  ['calculate at root', (s) => { s.calculate = CANARY }, 'forbidden_key', '$'],
  ['params', (s) => { s.params = [{ name: CANARY, select: 'interval' }] }, 'forbidden_key', '$'],
  ['selection', (s) => { s.selection = { Sample: { type: CANARY } } }, 'forbidden_key', '$'],
  ['condition.test', (s) => { s.encoding.x.condition = { test: `datum.${CANARY}`, value: 'red' } }, 'forbidden_key', '$.encoding.x'],
  ['expr at root', (s) => { s.expr = CANARY }, 'forbidden_key', '$'],
  ['expr in a channel', (s) => { s.encoding.y.expr = CANARY }, 'forbidden_key', '$.encoding.y'],
  ['expr object as title', (s) => { s.title = { expr: CANARY } }, 'bad_value', '$.title'],
  ['signal in a channel', (s) => { s.encoding.x.signal = CANARY }, 'forbidden_key', '$.encoding.x'],
  ['signal object as mark', (s) => { s.mark = { signal: CANARY } }, 'bad_mark', '$.mark'],
  ['format', (s) => { s.encoding.y.format = CANARY }, 'forbidden_key', '$.encoding.y'],
  ['formatType', (s) => { s.encoding.y.formatType = CANARY }, 'forbidden_key', '$.encoding.y'],
  ['labelExpr', (s) => { s.encoding.x.labelExpr = CANARY }, 'forbidden_key', '$.encoding.x'],
  ['axis.labelExpr', (s) => { s.encoding.x.axis = { labelExpr: CANARY } }, 'unknown_key', '$.encoding.x'],
  ['href channel', (s) => { s.encoding.href = { field: 'week', type: 'nominal', title: CANARY } }, 'forbidden_key', '$.encoding'],
  ['url channel', (s) => { s.encoding.url = { field: 'week', type: 'nominal', title: CANARY } }, 'forbidden_key', '$.encoding'],
  ['tooltip channel', (s) => { s.encoding.tooltip = { field: CANARY } }, 'unknown_key', '$.encoding'],
  ['usermeta', (s) => { s.usermeta = { note: CANARY } }, 'forbidden_key', '$'],
  ['config', (s) => { s.config = { background: CANARY } }, 'forbidden_key', '$'],
  ['projection', (s) => { s.projection = { type: CANARY } }, 'forbidden_key', '$'],
  ['layer', (s) => { s.layer = [{ mark: CANARY }] }, 'forbidden_key', '$'],
  ['concat', (s) => { s.concat = [{ mark: CANARY }] }, 'forbidden_key', '$'],
  ['hconcat', (s) => { s.hconcat = [{ mark: CANARY }] }, 'forbidden_key', '$'],
  ['vconcat', (s) => { s.vconcat = [{ mark: CANARY }] }, 'forbidden_key', '$'],
  ['facet', (s) => { s.facet = { field: CANARY } }, 'forbidden_key', '$'],
  ['repeat', (s) => { s.repeat = [CANARY] }, 'forbidden_key', '$'],
  ['spec', (s) => { s.spec = { mark: CANARY } }, 'forbidden_key', '$'],
  ['unknown key at root', (s) => { s[CANARY] = 1 }, 'unknown_key', '$'],
  ['unknown key in data', (s) => { s.data[CANARY] = 1 }, 'unknown_key', '$.data'],
  ['unknown key in encoding', (s) => { s.encoding[CANARY] = { field: 'week', type: 'nominal' } }, 'unknown_key', '$.encoding'],
  ['unknown key in a channel', (s) => { s.encoding.x[CANARY] = 1 }, 'unknown_key', '$.encoding.x'],
  ['aggregate in a channel', (s) => { s.encoding.y.aggregate = CANARY }, 'unknown_key', '$.encoding.y'],
  ['theta on a bar', (s) => { s.encoding.theta = { field: 'cents', type: 'quantitative', title: CANARY } }, 'unknown_key', '$.encoding'],
  ['x on an arc', (s) => { s.mark = 'arc'; s.encoding.theta = { field: 'cents', type: 'quantitative', title: CANARY } }, 'unknown_key', '$.encoding'],
  ['missing y', (s) => { delete (s.encoding as Loose).y; s.encoding.color = { field: 'week', type: 'nominal', title: CANARY } }, 'missing_key', '$.encoding'],
  ['missing theta on an arc', (s) => { s.mark = 'arc'; (s as Loose).encoding = { color: { field: 'week', type: 'nominal', title: CANARY } } }, 'missing_key', '$.encoding'],
  ['missing data', (s) => { delete (s as Loose).data; s.encoding.y.title = CANARY }, 'missing_key', '$'],
  ['empty values', (s) => { s.data.values = []; s.encoding.y.title = CANARY }, 'bad_value', '$.data.values'],
  ['channel field not in any row', (s) => { s.encoding.x.field = CANARY }, 'bad_value', '$.encoding.x.field'],
  ['channel type outside the list', (s) => { s.encoding.x.type = CANARY }, 'bad_value', '$.encoding.x.type'],
  ['object in a row value', (s) => { s.data.values[0].week = { expr: CANARY } }, 'bad_value', '$.data.values[0]'],
  ['array in a row value', (s) => { s.data.values[0].week = [CANARY] }, 'bad_value', '$.data.values[0]'],
  ['field path in a row key', (s) => { s.data.values[0][`a.${CANARY}`] = 1 }, 'unknown_key', '$.data.values[0]'],
  ['bracket in a row key', (s) => { s.data.values[0][`a[${CANARY}]`] = 1 }, 'unknown_key', '$.data.values[0]'],
  ['data as an array', (s) => { (s as Loose).data = [CANARY] }, 'bad_value', '$.data'],
]

describe('hostile specs', () => {
  it.each(HOSTILE)('rejects %s', (_name, patch, reason, path) => {
    const spec = base()
    patch(spec)
    const result = validateChartSpec(spec)
    expect(rejection(result)).toEqual({ reason, path })
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(Object.keys(result).sort()).toEqual(['ok', 'path', 'reason'])
  })

  it.each<[string, unknown]>([
    ['another URL', `https://${CANARY}.example/schema.json`],
    ['the http variant', 'http://vega.github.io/schema/vega-lite/v5.json'],
    ['v4', 'https://vega.github.io/schema/vega-lite/v4.json'],
    ['a trailing space', `${CHART_SCHEMA_URL} `],
    ['a non-string', 5],
  ])('rejects $schema as %s', (_name, value) => {
    const spec = base()
    spec.$schema = value
    const result = validateChartSpec(spec)
    expect(rejection(result)).toEqual({ reason: 'bad_schema_url', path: '$.$schema' })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })
})

const SCHEMES = ['http:', 'https:', 'data:', 'javascript:', 'file:', 'vbscript:', 'blob:', 'ftp:', 'ws:', 'wss:']

const URL_TEXT: [string, string][] = [
  ...SCHEMES.map((scheme): [string, string] => [scheme, `Example ${scheme}${CANARY}`]),
  ['mixed case', `JaVaScRiPt:${CANARY}`],
  ['a tab inside the scheme', `java\tscript:${CANARY}`],
  ['a NUL inside the scheme', `java\u0000script:${CANARY}`],
  ['a zero-width space inside the scheme', `java\u200bscript:${CANARY}`],
  ['a soft hyphen inside the scheme', `ja\u00advascript:${CANARY}`],
  ['fullwidth letters', `\uff48\uff54\uff54\uff50\uff1a//${CANARY}`],
  ['a protocol-relative URL', `//${CANARY}.example`],
  ['a protocol-relative URL after spaces', `  //${CANARY}.example`],
  ['a backslash protocol-relative URL', `\\\\${CANARY}.example`],
  ['a mixed-slash protocol-relative URL', `/\\${CANARY}.example`],
]

const MARKUP_TEXT: [string, string][] = [
  ['a script tag', `<script>${CANARY}</script>`],
  ['a fullwidth angle bracket', `\uff1cimg src=x\uff1e${CANARY}`],
]

const TEXT_SITES: [string, (spec: MutableSpec, text: string) => void, string][] = [
  ['title', (s, text) => { s.title = text }, '$.title'],
  ['a data value', (s, text) => { s.data.values[1].week = text }, '$.data.values[1]'],
  ['a channel title', (s, text) => { s.encoding.y.title = text }, '$.encoding.y.title'],
]

// Embedding, override and isolate controls reorder how a label reads.
const BIDI_TEXT: [string, string][] = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(
  (code): [string, string] => [`U+${code.toString(16).toUpperCase()}`, `Example${String.fromCodePoint(code)}${CANARY}`],
)

type TextCase = [string, string, (spec: MutableSpec, text: string) => void, string, ChartSpecRejection, string]

describe('strings carrying URLs or markup', () => {
  const cases = TEXT_SITES.flatMap(([site, put, path]): TextCase[] => [
    ...URL_TEXT.map(([name, text]): TextCase => [site, name, put, text, 'url_in_string', path]),
    ...MARKUP_TEXT.map(([name, text]): TextCase => [site, name, put, text, 'markup_in_string', path]),
    ...BIDI_TEXT.map(([name, text]): TextCase => [site, name, put, text, 'bidi_in_string', path]),
  ])

  it.each(cases)('rejects %s with %s', (_site, _name, put, text, reason, path) => {
    const spec = base()
    put(spec, text)
    const result = validateChartSpec(spec)
    expect(rejection(result)).toEqual({ reason, path })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })

  it('leaves a plain label with a colon and operators alone', () => {
    const spec = base()
    spec.title = 'Example total: a+b (Sample)'
    expect(validateChartSpec(spec).ok).toBe(true)
  })
})

describe('row key hygiene', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])('rejects row key %s', (key) => {
    const spec = base()
    spec.data.values[0][key] = CANARY
    const result = validateChartSpec(spec)
    expect(rejection(result)).toEqual({ reason: 'forbidden_key', path: '$.data.values[0]' })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })

  it('rejects an own __proto__ row key made by JSON.parse', () => {
    const text = JSON.stringify(BASE).replace('"week":"Sample W1"', `"__proto__":{"x":"${CANARY}"},"week":"Sample W1"`)
    const parsed: unknown = JSON.parse(text)
    const result = validateChartSpec(parsed)
    expect(rejection(result)).toEqual({ reason: 'forbidden_key', path: '$.data.values[0]' })
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(({} as Loose).x).toBeUndefined()
  })

  it('rejects an own __proto__ key at the root made by JSON.parse', () => {
    const text = `{"__proto__":{"mark":"${CANARY}"},${JSON.stringify(BASE).slice(1)}`
    expect(rejection(parseChartSpecJson(text))).toEqual({ reason: 'unknown_key', path: '$' })
  })
})

class ExampleSpec {
  data = { values: [{ week: 'Sample W1', cents: 1 }] }
  mark = 'bar'
  encoding = BASE.encoding
}

describe('non-plain input', () => {
  it.each<[string, (spec: MutableSpec) => unknown, ChartSpecRejection, string]>([
    ['a class instance at the root', () => new ExampleSpec(), 'not_plain', '$'],
    ['a Map as data', (s) => { (s as Loose).data = new Map([['values', CANARY]]) }, 'not_plain', '$.data'],
    ['a Date as a row value', (s) => { s.data.values[0].week = new Date(0) }, 'not_plain', '$.data.values[0]'],
    ['a function as a row value', (s) => { s.data.values[0].week = () => CANARY }, 'not_plain', '$.data.values[0]'],
    ['undefined as a row value', (s) => { s.data.values[0].week = undefined }, 'not_plain', '$.data.values[0]'],
    ['a bigint as a row value', (s) => { s.data.values[0].cents = 10n }, 'not_plain', '$.data.values[0]'],
    ['a symbol as a row value', (s) => { s.data.values[0].cents = Symbol(CANARY) }, 'not_plain', '$.data.values[0]'],
    ['a symbol key on a row', (s) => { s.data.values[0][Symbol(CANARY) as unknown as string] = 1 }, 'not_plain', '$.data.values[0]'],
    ['a non-enumerable property', (s) => { Object.defineProperty(s.encoding.x, 'title', { value: CANARY, enumerable: false }) }, 'not_plain', '$.encoding.x.title'],
    ['a hole in values', (s) => { s.data.values.length = 3 }, 'not_plain', '$.data.values'],
    ['an extra property on values', (s) => { Object.assign(s.data.values, { extra: CANARY }) }, 'not_plain', '$.data.values'],
    ['values with a foreign prototype', (s) => { Object.setPrototypeOf(s.data.values, { note: CANARY }) }, 'not_plain', '$.data.values'],
    ['NaN', (s) => { s.data.values[0].cents = NaN }, 'bad_number', '$.data.values[0]'],
    ['Infinity', (s) => { s.data.values[0].cents = Infinity }, 'bad_number', '$.data.values[0]'],
    ['-Infinity', (s) => { s.data.values[0].cents = -Infinity }, 'bad_number', '$.data.values[0]'],
  ])('rejects %s', (_name, patch, reason, path) => {
    const spec = base()
    const replaced = patch(spec)
    const result = validateChartSpec(replaced ?? spec)
    expect(rejection(result)).toEqual({ reason, path })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })

  it('rejects a getter without calling it', () => {
    const spec = base()
    const getter = vi.fn(() => 'Example title')
    Object.defineProperty(spec, 'title', { get: getter, enumerable: true })
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'not_plain', path: '$.title' })
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects a Proxy whose trap throws, without passing the error on', () => {
    const hostile = new Proxy(base(), {
      ownKeys() {
        throw new Error(CANARY)
      },
    })
    const result = validateChartSpec(hostile)
    expect(rejection(result)).toEqual({ reason: 'not_plain', path: '$' })
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })

  it.each<[string, unknown, ChartSpecRejection]>([
    ['null', null, 'bad_value'],
    ['undefined', undefined, 'not_plain'],
    ['an empty string', '', 'bad_value'],
    ['a number', 5, 'bad_value'],
    ['an array', [], 'bad_value'],
  ])('rejects %s as the root', (_name, root, reason) => {
    expect(rejection(validateChartSpec(root))).toEqual({ reason, path: '$' })
  })
})

// `depth` nested objects, the root included, built without recursion.
function chain(depth: number): Loose {
  const root: Loose = {}
  let at = root
  for (let i = 1; i < depth; i += 1) {
    const next: Loose = {}
    at.a = next
    at = next
  }
  return root
}

// An object with exactly `total` values in it, the root included.
function withNodes(total: number): Loose {
  const inner: null[][] = []
  for (let left = total - 2; left > 0; ) {
    const take = Math.min(CHART_LIMITS.maxRows, left)
    inner.push(new Array<null>(take - 1).fill(null))
    left -= take
  }
  return { a: inner }
}

describe('size and nesting caps', () => {
  it('pins the caps', () => {
    expect(CHART_LIMITS).toStrictEqual({
      maxChars: 64_000,
      maxNodes: 3_000,
      maxDepth: 6,
      maxRows: 200,
      maxKeys: 8,
      maxStringChars: 200,
    })
  })

  it('accepts maxRows rows and rejects one more', () => {
    const spec = base()
    spec.data.values = rowsOf(CHART_LIMITS.maxRows)
    expect(validateChartSpec(spec).ok).toBe(true)
    spec.data.values = rowsOf(CHART_LIMITS.maxRows + 1)
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'too_many_rows', path: '$.data.values' })
  })

  it('accepts a maxStringChars string and rejects one more character', () => {
    const spec = base()
    spec.title = 'E'.repeat(CHART_LIMITS.maxStringChars)
    expect(validateChartSpec(spec).ok).toBe(true)
    spec.title = 'E'.repeat(CHART_LIMITS.maxStringChars + 1)
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'string_too_long', path: '$.title' })
  })

  it('accepts a row with maxKeys fields and rejects one more', () => {
    const spec = base()
    const row = (count: number): Loose => ({
      week: 'Sample W1',
      cents: 1,
      ...Object.fromEntries(Array.from({ length: count - 2 }, (_, i) => [`extra${i}`, i])),
    })
    spec.data.values = [row(CHART_LIMITS.maxKeys)]
    expect(validateChartSpec(spec).ok).toBe(true)
    spec.data.values = [row(CHART_LIMITS.maxKeys + 1)]
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'too_many_keys', path: '$.data.values[0]' })
  })

  it('passes maxDepth containers to the schema walk and rejects one more as too deep', () => {
    expect(rejection(validateChartSpec(chain(CHART_LIMITS.maxDepth)))).toEqual({ reason: 'unknown_key', path: '$' })
    expect(rejection(validateChartSpec(chain(CHART_LIMITS.maxDepth + 1))).reason).toBe('too_deep')
  })

  it('passes maxNodes values to the schema walk and rejects one more', () => {
    expect(rejection(validateChartSpec(withNodes(CHART_LIMITS.maxNodes)))).toEqual({ reason: 'unknown_key', path: '$' })
    expect(rejection(validateChartSpec(withNodes(CHART_LIMITS.maxNodes + 1))).reason).toBe('too_many_nodes')
  })

  it('rejects maxRows rows of maxKeys full-length strings as too large', () => {
    const spec = base()
    const field = 'S'.repeat(CHART_LIMITS.maxStringChars)
    const row = Object.fromEntries(Array.from({ length: CHART_LIMITS.maxKeys }, (_, i) => [`f${i}`, field]))
    spec.data.values = Array.from({ length: CHART_LIMITS.maxRows }, () => ({ ...row }))
    expect(JSON.stringify(spec).length).toBeGreaterThan(CHART_LIMITS.maxChars)
    expect(rejection(validateChartSpec(spec)).reason).toBe('too_large')
  })

  it('rejects a spec on write whose stored text the render-side cap would refuse', () => {
    const spec = base()
    // Each control character is one char in memory and six in JSON.
    const label = '\u0001'.repeat(CHART_LIMITS.maxStringChars)
    spec.data.values = Array.from({ length: 50 }, (_, i) => ({ week: `Sample W${i}`, cents: i, a: label, b: label, c: label }))
    expect(JSON.stringify(spec).length).toBeGreaterThan(CHART_LIMITS.maxChars)
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'too_large', path: '$' })
  })

  it('rejects a 10 MB string value quickly', () => {
    const spec = base()
    spec.data.values[0].week = 'S'.repeat(10_000_001)
    expect(JSON.stringify(spec).length).toBeGreaterThan(10_000_000)
    const started = performance.now()
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'string_too_long', path: '$.data.values[0]' })
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('rejects a 10 MB array of rows quickly', () => {
    const spec = base()
    const row = { week: 'Sample W1', cents: 1200 }
    spec.data.values = new Array<Loose>(1_000_000).fill(row)
    expect(spec.data.values.length * JSON.stringify(row).length).toBeGreaterThan(10_000_000)
    const started = performance.now()
    expect(rejection(validateChartSpec(spec))).toEqual({ reason: 'too_many_rows', path: '$.data.values' })
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('rejects a 10,000-level chain as too deep without overflowing the stack', () => {
    expect(rejection(validateChartSpec(chain(10_000))).reason).toBe('too_deep')
  })

  it('rejects a self-referencing object without hanging', () => {
    const spec: Loose = base()
    spec.data = spec
    expect(rejection(validateChartSpec(spec)).reason).toBe('too_deep')
  })
})

describe('parseChartSpecJson', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts valid stored text', () => {
    const result = parseChartSpecJson(JSON.stringify(BASE))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.spec).toStrictEqual(BASE)
  })

  it.each<[string, unknown]>([
    ['broken JSON', '{"mark":'],
    ['an empty string', ''],
    ['a non-string', BASE],
    ['undefined', undefined],
  ])('rejects %s as not_json', (_name, text) => {
    expect(rejection(parseChartSpecJson(text))).toEqual({ reason: 'not_json', path: '$' })
  })

  it('rejects text over maxChars before parsing it', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const text = JSON.stringify({ ...BASE, title: 'S'.repeat(CHART_LIMITS.maxChars) })
    expect(rejection(parseChartSpecJson(text))).toEqual({ reason: 'too_large', path: '$' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('rejects 10 MB of text before parsing it', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const text = `{"title":"${'S'.repeat(10_000_000)}"}`
    expect(rejection(parseChartSpecJson(text))).toEqual({ reason: 'too_large', path: '$' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('reads the last of duplicate keys, as JSON.parse does, and checks that one', () => {
    const text = JSON.stringify(BASE).replace('"mark":"bar"', '"mark":"bar","mark":"text"')
    expect(text).toContain('"mark":"text"')
    expect(rejection(parseChartSpecJson(text))).toEqual({ reason: 'bad_mark', path: '$.mark' })
  })
})

describe('models/insights.ts stays import-free', () => {
  it('has no import, require or node: specifier', () => {
    const source = readFileSync(Path.join(modelsDir, 'insights.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/^\s*export\s[^\n]*\sfrom\s/m)
    expect(source).not.toContain('require(')
    expect(source).not.toContain('node:')
  })
})

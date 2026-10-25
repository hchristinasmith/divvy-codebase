// The `insights` row and the chart spec it carries (prd-04 Ruling 2,
// Ruling 3, Ruling 8). The spec is data, never HTML: `validateChartSpec` is
// run on write (before the row is stored) and on render (before the renderer
// sees it), even though code writes it, because merchant text reaches its
// labels (Ruling 8). Changing the accepted subset below is a PRD amendment,
// not an edit.
//
// This file imports nothing, so client and server both use it as is.
//
// The accepted subset is an allow-list. Every key outside the tree below is
// refused; `forbidden_key` only names the refusal more precisely for keys a
// hostile spec is known to try (data URLs, transforms, expressions, …).
// Ruling 3's "no expression string" holds structurally: no accepted key
// carries an expression, objects and arrays are refused in value positions,
// and inlined data strings such as "a+b" stay plain labels.
//
//   root      $schema? title? data mark encoding
//   data      values: 1..maxRows rows
//   row       1..maxKeys fields; a field name matches FIELD_NAME and is not
//             an Object.prototype name; a value is a string, finite
//             number, boolean or null
//   mark      a plain string from CHART_MARKS
//   encoding  x and y for every mark except arc; theta (no x or y) for arc;
//             color optional
//   channel   field (a field present in some row), type, title?
//
// Data is pre-aggregated by the agent's typed queries (Ruling 3), so there
// is no aggregate, bin, timeUnit, sort, scale, axis or tooltip.
//
// Validation runs in two phases. Phase 1 walks the input with an explicit
// stack, enforcing CHART_LIMITS and plainness before any schema logic, and
// reads each property once through its descriptor (a getter is never
// invoked) into a private snapshot. Phase 2 checks the snapshot against the
// tree and builds the returned spec from named fields only, so nothing on
// the input object, and nothing a Proxy does later, reaches the renderer.
//
// A rejection never echoes the input: `reason` is a closed code and `path`
// is built only from schema keys and array indices. An unrecognised key
// reports its parent's path.

export const INSIGHT_KINDS = ['pattern', 'report', 'chart'] as const
export type InsightKind = (typeof INSIGHT_KINDS)[number]

export type InsightScope = 'personal' | 'strawb'

// A row of `insights` (prd-04 Ruling 2).
export interface Insight {
  id: number
  kind: InsightKind
  title: string
  body_md: string
  // The spec as stored text. Read it with `parseChartSpecJson`, on write and
  // on render; never hand the stored text to a renderer.
  chart_spec_json: string | null
  scope: InsightScope
  // An opaque label for the period covered, e.g. "2026-W43".
  period: string
  // ISO-8601 UTC instants ending in `Z` (IsoTimestamp in models/sync.ts).
  created_at: string
  dismissed_at: string | null
  // Optional Mermaid diagram (Ruling 3), opaque text: never parsed or
  // validated here, and not a Ruling 2 column.
  mermaid?: string | null
}

export const CHART_MARKS = ['bar', 'line', 'area', 'point', 'arc'] as const
export type ChartMark = (typeof CHART_MARKS)[number]

// The only `$schema` accepted, by string equality. It is never fetched.
export const CHART_SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v5.json'

export const CHART_CHANNEL_TYPES = ['quantitative', 'nominal', 'ordinal', 'temporal'] as const
export type ChartChannelType = (typeof CHART_CHANNEL_TYPES)[number]

export type ChartValue = string | number | boolean | null

export interface ChartChannel {
  field: string
  type: ChartChannelType
  title?: string
}

export interface ChartSpec {
  $schema?: typeof CHART_SCHEMA_URL
  title?: string
  data: { values: Record<string, ChartValue>[] }
  mark: ChartMark
  encoding: { x?: ChartChannel; y?: ChartChannel; color?: ChartChannel; theta?: ChartChannel }
}

// Phase 1 caps. `maxDepth` counts containers, the root object included.
// `maxRows` caps every array; `maxKeys` caps every object. `maxChars` caps
// the stored text: phase 1 holds an object to a running estimate of its JSON
// length, and the returned spec's exact JSON length is checked last.
export const CHART_LIMITS = {
  maxChars: 64_000,
  maxNodes: 3_000,
  maxDepth: 6,
  maxRows: 200,
  maxKeys: 8,
  maxStringChars: 200,
} as const

export type ChartSpecRejection =
  | 'not_json'
  | 'too_large'
  | 'too_deep'
  | 'too_many_nodes'
  | 'too_many_keys'
  | 'too_many_rows'
  | 'string_too_long'
  | 'not_plain'
  | 'bad_number'
  | 'unknown_key'
  | 'forbidden_key'
  | 'missing_key'
  | 'bad_schema_url'
  | 'bad_mark'
  | 'bad_value'
  | 'url_in_string'
  | 'markup_in_string'
  | 'bidi_in_string'

export type ChartSpecResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; reason: ChartSpecRejection; path: string }

type Rejected = Extract<ChartSpecResult, { ok: false }>

// Thrown inside this module only, caught by `validateChartSpec`.
class Rejection {
  readonly result: Rejected
  constructor(reason: ChartSpecRejection, path: string) {
    this.result = { ok: false, reason, path }
  }
}

function reject(reason: ChartSpecRejection, path: string): never {
  throw new Rejection(reason, path)
}

const ROOT_KEYS: ReadonlySet<string> = new Set(['$schema', 'title', 'data', 'mark', 'encoding'])
const DATA_KEYS: ReadonlySet<string> = new Set(['values'])
const ENCODING_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'color', 'theta'])
const CHANNEL_KEYS: ReadonlySet<string> = new Set(['field', 'type', 'title'])

// Keys that may appear in a path. Anything else stops the path at its parent.
const PATH_SEGMENTS: ReadonlySet<string> = new Set([
  ...ROOT_KEYS,
  ...DATA_KEYS,
  ...ENCODING_KEYS,
  ...CHANNEL_KEYS,
])

// Refines `unknown_key` to `forbidden_key`; the allow-lists above are what
// refuse them.
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'url',
  'href',
  'name',
  'format',
  'formatType',
  'datasets',
  'transform',
  'filter',
  'calculate',
  'params',
  'selection',
  'condition',
  'expr',
  'signal',
  'labelExpr',
  'usermeta',
  'config',
  'projection',
  'layer',
  'concat',
  'hconcat',
  'vconcat',
  'facet',
  'repeat',
  'spec',
])

// No `.`, `[`, `]` or `\`: Vega-Lite reads those as a path into the datum.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_ ]{0,39}$/

const URL_SCHEMES = [
  'http:',
  'https:',
  'data:',
  'javascript:',
  'file:',
  'vbscript:',
  'blob:',
  'ftp:',
  'ws:',
  'wss:',
] as const

// ---- Phase 1: bounded walk into a snapshot ----

type Plain = string | number | boolean | null | Plain[] | PlainObject
interface PlainObject {
  [key: string]: Plain
}

interface Frame {
  value: unknown
  depth: number
  path: string
  // False once the path has stopped at an unrecognised key.
  open: boolean
  into: Plain[] | PlainObject
  key: number | string
}

function childPath(frame: Frame, segment: number | string): { path: string; open: boolean } {
  if (!frame.open) return { path: frame.path, open: false }
  if (typeof segment === 'number') return { path: `${frame.path}[${segment}]`, open: true }
  if (PATH_SEGMENTS.has(segment)) return { path: `${frame.path}.${segment}`, open: true }
  return { path: frame.path, open: false }
}

// The value of an own, enumerable data property, without invoking a getter.
function ownDataValue(obj: object, key: string, path: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  if (!desc || !desc.enumerable || !('value' in desc)) reject('not_plain', path)
  return desc.value
}

function snapshot(input: unknown): Plain {
  const holder: PlainObject = Object.create(null)
  const stack: Frame[] = [{ value: input, depth: 0, path: '$', open: true, into: holder, key: 'root' }]
  let nodes = 0
  let size = 0
  let path = '$'

  const grow = (by: number, at: string) => {
    size += by
    if (size > CHART_LIMITS.maxChars) reject('too_large', at)
  }
  const assign = (frame: Frame, value: Plain) => {
    if (Array.isArray(frame.into)) frame.into[frame.key as number] = value
    else frame.into[frame.key as string] = value
  }

  try {
    for (let frame = stack.pop(); frame; frame = stack.pop()) {
      path = frame.path
      nodes += 1
      if (nodes > CHART_LIMITS.maxNodes) reject('too_many_nodes', path)
      const value = frame.value

      if (typeof value === 'string') {
        if (value.length > CHART_LIMITS.maxStringChars) reject('string_too_long', path)
        grow(value.length + 2, path)
        assign(frame, value)
        continue
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) reject('bad_number', path)
        grow(String(value).length, path)
        assign(frame, value)
        continue
      }
      if (typeof value === 'boolean' || value === null) {
        grow(5, path)
        assign(frame, value)
        continue
      }
      if (typeof value !== 'object') reject('not_plain', path)

      const depth = frame.depth + 1
      if (depth > CHART_LIMITS.maxDepth) reject('too_deep', path)
      grow(2, path)
      const proto: unknown = Object.getPrototypeOf(value)

      if (Array.isArray(value)) {
        if (proto !== Array.prototype) reject('not_plain', path)
        const length = value.length
        if (length > CHART_LIMITS.maxRows) reject('too_many_rows', path)
        // Indices plus `length`: anything else is a hole or an extra property.
        if (Reflect.ownKeys(value).length !== length + 1) reject('not_plain', path)
        const out: Plain[] = []
        assign(frame, out)
        for (let i = length - 1; i >= 0; i -= 1) {
          const child = childPath(frame, i)
          const item = ownDataValue(value, String(i), child.path)
          stack.push({ value: item, depth, ...child, into: out, key: i })
        }
        continue
      }

      if (proto !== Object.prototype && proto !== null) reject('not_plain', path)
      const keys = Reflect.ownKeys(value)
      if (keys.length > CHART_LIMITS.maxKeys) reject('too_many_keys', path)
      const out: PlainObject = Object.create(null)
      assign(frame, out)
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i]
        if (typeof key !== 'string') reject('not_plain', path)
        grow(key.length + 3, path)
        const child = childPath(frame, key)
        const item = ownDataValue(value, key, child.path)
        stack.push({ value: item, depth, ...child, into: out, key })
      }
    }
  } catch (err) {
    if (err instanceof Rejection) throw err
    // A Proxy trap or exotic object threw; its error is not passed on.
    reject('not_plain', path)
  }
  return holder.root
}

// ---- Phase 2: schema walk over the snapshot ----

function isObject(value: Plain | undefined): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function has(obj: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function onlyKeys(obj: PlainObject, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) reject(FORBIDDEN_KEYS.has(key) ? 'forbidden_key' : 'unknown_key', path)
  }
}

const INVISIBLE = new Set([0x00ad, 0x034f, 0x061c, 0x180e, 0xfeff])

function isInvisible(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    INVISIBLE.has(code)
  )
}

// Embedding, override and isolate controls: they reorder how a label reads,
// so a merchant name could be shown as something it is not.
function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

// Rejects on doubt: "Metadata: x" is refused along with "data:x".
function checkText(value: string, path: string): string {
  const folded = value.normalize('NFKC').toLowerCase()
  let compact = ''
  for (const char of folded) {
    const code = char.codePointAt(0) ?? 0
    if (isBidiControl(code)) reject('bidi_in_string', path)
    if (isInvisible(code) || /\s/.test(char)) continue
    compact += char
  }
  // A browser reads a leading `\\` or `/\` as `//`.
  if (/^[\\/]{2}/.test(compact) || URL_SCHEMES.some((scheme) => compact.includes(scheme))) {
    reject('url_in_string', path)
  }
  if (compact.includes('<')) reject('markup_in_string', path)
  return value
}

function isMark(value: string): value is ChartMark {
  return (CHART_MARKS as readonly string[]).includes(value)
}

function isChannelType(value: string): value is ChartChannelType {
  return (CHART_CHANNEL_TYPES as readonly string[]).includes(value)
}

function readRows(data: Plain | undefined, path: string): Record<string, ChartValue>[] {
  if (!isObject(data)) reject('bad_value', path)
  onlyKeys(data, DATA_KEYS, path)
  if (!has(data, 'values')) reject('missing_key', path)
  const values = data.values
  const valuesPath = `${path}.values`
  if (!Array.isArray(values) || values.length === 0) reject('bad_value', valuesPath)

  return values.map((row, i) => {
    const rowPath = `${valuesPath}[${i}]`
    if (!isObject(row)) reject('bad_value', rowPath)
    const fields = Object.keys(row)
    if (fields.length === 0) reject('bad_value', rowPath)
    const out: Record<string, ChartValue> = {}
    for (const field of fields) {
      if (field in Object.prototype) reject('forbidden_key', rowPath)
      if (!FIELD_NAME.test(field)) reject('unknown_key', rowPath)
      const cell = row[field]
      if (typeof cell === 'string') out[field] = checkText(cell, rowPath)
      else if (typeof cell === 'number' || typeof cell === 'boolean' || cell === null) out[field] = cell
      else reject('bad_value', rowPath)
    }
    return out
  })
}

function readChannel(value: Plain | undefined, fields: ReadonlySet<string>, path: string): ChartChannel {
  if (!isObject(value)) reject('bad_value', path)
  onlyKeys(value, CHANNEL_KEYS, path)
  if (!has(value, 'field') || !has(value, 'type')) reject('missing_key', path)
  const field = value.field
  const type = value.type
  if (typeof field !== 'string' || !fields.has(field)) reject('bad_value', `${path}.field`)
  if (typeof type !== 'string' || !isChannelType(type)) reject('bad_value', `${path}.type`)
  const channel: ChartChannel = { field, type }
  if (has(value, 'title')) {
    const title = value.title
    if (typeof title !== 'string') reject('bad_value', `${path}.title`)
    channel.title = checkText(title, `${path}.title`)
  }
  return channel
}

function readEncoding(
  value: Plain | undefined,
  mark: ChartMark,
  fields: ReadonlySet<string>,
  path: string,
): ChartSpec['encoding'] {
  if (!isObject(value)) reject('bad_value', path)
  onlyKeys(value, ENCODING_KEYS, path)
  const required = mark === 'arc' ? ['theta'] : ['x', 'y']
  const refused = mark === 'arc' ? ['x', 'y'] : ['theta']
  if (refused.some((key) => has(value, key))) reject('unknown_key', path)
  if (!required.every((key) => has(value, key))) reject('missing_key', path)

  const encoding: ChartSpec['encoding'] = {}
  if (has(value, 'x')) encoding.x = readChannel(value.x, fields, `${path}.x`)
  if (has(value, 'y')) encoding.y = readChannel(value.y, fields, `${path}.y`)
  if (has(value, 'color')) encoding.color = readChannel(value.color, fields, `${path}.color`)
  if (has(value, 'theta')) encoding.theta = readChannel(value.theta, fields, `${path}.theta`)
  return encoding
}

function readSpec(root: Plain): ChartSpec {
  if (!isObject(root)) reject('bad_value', '$')
  onlyKeys(root, ROOT_KEYS, '$')
  if (!has(root, 'data') || !has(root, 'mark') || !has(root, 'encoding')) reject('missing_key', '$')

  const values = readRows(root.data, '$.data')
  const mark = root.mark
  if (typeof mark !== 'string' || !isMark(mark)) reject('bad_mark', '$.mark')
  const fields = new Set(values.flatMap((row) => Object.keys(row)))
  const encoding = readEncoding(root.encoding, mark, fields, '$.encoding')

  const spec: ChartSpec = { data: { values }, mark, encoding }
  if (has(root, '$schema')) {
    if (root.$schema !== CHART_SCHEMA_URL) reject('bad_schema_url', '$.$schema')
    spec.$schema = CHART_SCHEMA_URL
  }
  if (has(root, 'title')) {
    const title = root.title
    if (typeof title !== 'string') reject('bad_value', '$.title')
    spec.title = checkText(title, '$.title')
  }
  return spec
}

/** Checks an in-memory chart spec; returns a fresh copy built from named fields. */
export function validateChartSpec(input: unknown): ChartSpecResult {
  try {
    const spec = readSpec(snapshot(input))
    // The phase 1 estimate does not count escapes or commas; this holds the
    // stored text to the cap `parseChartSpecJson` applies on render.
    if (JSON.stringify(spec).length > CHART_LIMITS.maxChars) reject('too_large', '$')
    return { ok: true, spec }
  } catch (err) {
    if (err instanceof Rejection) return err.result
    throw err
  }
}

/**
 * Checks stored chart text (`insights.chart_spec_json`). The length cap is
 * applied before `JSON.parse`, so oversized text is never parsed.
 */
export function parseChartSpecJson(text: unknown): ChartSpecResult {
  if (typeof text !== 'string') return { ok: false, reason: 'not_json', path: '$' }
  if (text.length > CHART_LIMITS.maxChars) return { ok: false, reason: 'too_large', path: '$' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not_json', path: '$' }
  }
  return validateChartSpec(parsed)
}

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { CHART_LIMITS, validateChartSpec } from '../../../../models/insights.ts'
import {
  dismissInsight,
  getInsight,
  insertInsight,
  listInsights,
  type NewInsight,
} from '../insights.ts'

// The insights agent's inbox accessors (#31; prd-04 Rulings 2, 3 and 8,
// Done-when 5). Each test starts from an empty, freshly migrated in-memory
// database and inserts the rows it needs; every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const AT = '2026-10-25T03:00:00.000Z'
const NOW = new Date(AT)
const LATER = new Date('2026-10-25T04:30:00.000Z')
const LATEST = new Date('2026-10-25T06:00:00.000Z')

const INSIGHT_KEYS = [
  'body_md',
  'chart_spec_json',
  'created_at',
  'dismissed_at',
  'id',
  'kind',
  'period',
  'scope',
  'title',
]

// A valid spec with `title` before `data`: the validator's copy puts it last.
const spec = (fields: Record<string, unknown> = {}) => ({
  title: 'Top merchants',
  data: {
    values: [
      { merchant: 'Fixture Bakery', total: 1250 },
      { merchant: 'Fixture Grocer', total: 830 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'merchant', type: 'nominal' },
    y: { field: 'total', type: 'quantitative' },
  },
  ...fields,
})

const insight = (fields: Partial<NewInsight> = {}): NewInsight => ({
  kind: 'pattern',
  title: 'Top merchants this week',
  body_md: 'Most of the week went to **Fixture Bakery**.',
  scope: 'personal',
  period: '2026-W43',
  ...fields,
})

async function inserted(i: NewInsight, now: Date = NOW): Promise<number> {
  const result = await insertInsight(i, now)
  if (!result.ok) throw new Error(`expected an insert, got ${result.reason}`)
  return result.id
}

async function storedRows(): Promise<Record<string, unknown>[]> {
  return connection('insights').orderBy('id')
}

function canonical(input: unknown): string {
  const checked = validateChartSpec(input)
  if (!checked.ok) throw new Error(`fixture spec refused: ${checked.reason}`)
  return JSON.stringify(checked.spec)
}

describe('insertInsight', () => {
  it("stores the validator's copy of a chart spec, not the input", async () => {
    const input = spec()
    const id = await inserted(insight({ kind: 'chart', chart_spec: input }))

    const [stored] = await storedRows()
    expect(Object.keys(stored).sort()).toEqual(INSIGHT_KEYS)
    expect(stored.chart_spec_json).toBe(canonical(input))
    // The proof that the copy, not the input, was stored.
    expect(stored.chart_spec_json).not.toBe(JSON.stringify(input))
    expect(stored).toStrictEqual({
      id,
      kind: 'chart',
      title: 'Top merchants this week',
      body_md: 'Most of the week went to **Fixture Bakery**.',
      chart_spec_json: canonical(input),
      scope: 'personal',
      period: '2026-W43',
      created_at: AT,
      dismissed_at: null,
    })

    const read = await getInsight(id)
    expect(Object.keys(read ?? {}).sort()).toEqual(INSIGHT_KEYS)
    expect('mermaid' in (read ?? {})).toBe(false)
    expect(read).toStrictEqual(stored)
  })

  // The insights agent stamps every draft with the ISO week it covers
  // (buildDrafts in server/agents/insights/prompt.ts), so that label must
  // store; a month label must too, for a draft that covers a month.
  it.each([
    ['an ISO week', '2026-W43'],
    ['a month', '2026-10'],
  ])('stores %s period label unchanged', async (_, period) => {
    const id = await inserted(insight({ period }))

    expect((await getInsight(id))?.period).toBe(period)
    expect((await storedRows())[0].period).toBe(period)
  })

  const HOSTILE: [name: string, input: unknown, reason: string, marker: string][] = [
    ['a data URL', spec({ data: { url: 'https://example.invalid/rows.json' } }), 'forbidden_key', 'example.invalid'],
    ['an unknown mark', spec({ mark: 'rect' }), 'bad_mark', 'rect'],
    [
      'a javascript: label',
      spec({ data: { values: [{ merchant: 'javascript:alert(1)', total: 1 }] } }),
      'url_in_string',
      'alert(1)',
    ],
    [
      'a script label',
      spec({ data: { values: [{ merchant: '<script>x()</script>', total: 1 }] } }),
      'markup_in_string',
      '<script>',
    ],
    [
      'a bidi override in a label',
      spec({ data: { values: [{ merchant: 'Fixture ‮yrekaB', total: 1 }] } }),
      'bidi_in_string',
      'yrekaB',
    ],
    [
      'too many rows',
      spec({
        data: {
          values: Array.from({ length: CHART_LIMITS.maxRows + 1 }, (_, i) => ({
            merchant: `Fixture ${i}`,
            total: i,
          })),
        },
      }),
      'too_many_rows',
      'Fixture 200',
    ],
  ]

  it.each(HOSTILE)('refuses %s with the validator’s reason and path, and writes nothing', async (_, input, reason, marker) => {
    const expected = validateChartSpec(input)
    expect(expected.ok).toBe(false)
    if (expected.ok) return
    expect(expected.reason).toBe(reason)

    const result = await insertInsight(insight({ kind: 'chart', chart_spec: input }), NOW)

    expect(result).toStrictEqual({ ok: false, reason: expected.reason, path: expected.path })
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(await storedRows()).toEqual([])
  })

  it.each([null, undefined])('stores no chart for a %s spec', async (chart) => {
    const id = await inserted(insight({ chart_spec: chart }))
    expect((await getInsight(id))?.chart_spec_json).toBeNull()
    expect((await storedRows())[0].chart_spec_json).toBeNull()
  })

  it('ignores a mermaid key: there is no column for it (Ruling 2)', async () => {
    const withMermaid = { ...insight(), mermaid: 'graph TD; A-->B' }
    const id = await inserted(withMermaid)

    const [stored] = await storedRows()
    expect(Object.keys(stored).sort()).toEqual(INSIGHT_KEYS)
    expect(JSON.stringify(stored)).not.toContain('graph TD')
    expect('mermaid' in ((await getInsight(id)) ?? {})).toBe(false)
  })

  const BAD: [name: string, fields: Partial<NewInsight>, message: RegExp][] = [
    ['kind', { kind: 'x' as unknown as NewInsight['kind'] }, /^kind is not a known insight kind$/],
    ['scope', { scope: 'all' as unknown as NewInsight['scope'] }, /^scope must be personal or strawb$/],
    [
      'scope toString',
      { scope: 'toString' as unknown as NewInsight['scope'] },
      /^scope must be personal or strawb$/,
    ],
    ['blank title', { title: '  ' }, /^title must not be blank$/],
    ['blank body_md', { body_md: '' }, /^body_md must not be blank$/],
    ['blank period', { period: '\t' }, /^period must not be blank$/],
    ['title U+3164 only', { title: '\u3164' }, /^title must not be blank$/],
    ['body_md U+200B only', { body_md: '\u200b' }, /^body_md must not be blank$/],
    ['period U+3164 and spaces', { period: '\u3164 \u3164' }, /^period must not be blank$/],
    ['title tag characters (non-BMP)', { title: '\u{E0041}\u{E0042}' }, /^title must not be blank$/],
    ['body_md a variation selector', { body_md: '\ufe0f' }, /^body_md must not be blank$/],
    ['period U+200B, space, U+3164 and tab', { period: '\u200b \u3164\t' }, /^period must not be blank$/],
    // The blank check runs before the cap: a blank value over the cap is blank.
    ['title 201 spaces', { title: ' '.repeat(201) }, /^title must not be blank$/],
    ['title 201 U+200B', { title: '\u200b'.repeat(201) }, /^title must not be blank$/],
    ['body_md 20,001 spaces', { body_md: ' '.repeat(20_001) }, /^body_md must not be blank$/],
    ['period 33 spaces', { period: ' '.repeat(33) }, /^period must not be blank$/],
    ['period 33 U+0001', { period: '\u0001'.repeat(33) }, /^period must not be blank$/],
    ['title 42', { title: 42 as unknown as string }, /^title must not be blank$/],
  ]

  it.each(BAD)('throws on a bad %s, and writes nothing', async (_, fields, message) => {
    await expect(insertInsight(insight({ chart_spec: spec(), ...fields }), NOW)).rejects.toThrow(message)
    expect(await storedRows()).toEqual([])
  })

  // The caps (#303; the period cap, #340) are counted in code points. Each
  // field's cap is pinned here as a literal: the constants are not exported.
  const CAPS: [field: 'title' | 'body_md' | 'period', max: number][] = [
    ['title', 200],
    ['body_md', 20_000],
    ['period', 32],
  ]
  const withText = (field: 'title' | 'body_md' | 'period', text: string): NewInsight =>
    insight({ [field]: text })

  it.each(CAPS)('accepts a %s of exactly %i code points, and stores it whole', async (field, max) => {
    const text = 'a'.repeat(max)
    expect(Array.from(text)).toHaveLength(max)

    const result = await insertInsight(withText(field, text), NOW)
    expect(result).toStrictEqual({ ok: true, id: expect.any(Number) })

    const [stored] = await storedRows()
    expect(Object.keys(stored).sort()).toEqual(INSIGHT_KEYS)
    expect(stored[field]).toBe(text)
  })

  // Non-BMP characters are two UTF-16 units each, so this string is over the
  // cap by `.length` and exactly at it by code points. A cap counted in
  // `.length` refuses it; the code-point cap must accept it.
  it.each(CAPS)('counts a %s in code points, not UTF-16 units: non-BMP text at the cap is accepted', async (field, max) => {
    const text = '\u{20000}'.repeat(max)
    expect(Array.from(text)).toHaveLength(max)
    expect(text.length).toBeGreaterThan(max)

    const result = await insertInsight(withText(field, text), NOW)
    expect(result).toStrictEqual({ ok: true, id: expect.any(Number) })

    const [stored] = await storedRows()
    expect(stored[field]).toBe(text)
  })

  it.each(CAPS)('refuses a %s one code point over the cap, and writes nothing', async (field, max) => {
    const result = await insertInsight(withText(field, 'a'.repeat(max + 1)), NOW).catch((e: unknown) => e)
    expect(result).toBeInstanceOf(Error)
    expect(await storedRows()).toEqual([])
  })

  it.each(CAPS)('refuses non-BMP %s text one code point over the cap, and writes nothing', async (field, max) => {
    await expect(insertInsight(withText(field, '\u{20000}'.repeat(max + 1)), NOW)).rejects.toThrow(
      new RegExp(`^${field} must be at most ${max} characters$`),
    )
    expect(await storedRows()).toEqual([])
  })

  // The message names the field and the cap. An exact match also proves it
  // carries none of the refused value, which here holds a sentinel.
  it.each(CAPS)('names the %s and its cap in the refusal, never the value', async (field, max) => {
    const sentinel = 'Fixture Merchant 4419'
    const text = sentinel.padEnd(max + 1, 'x')
    const error = await insertInsight(withText(field, text), NOW).then(
      () => new Error('expected a refusal'),
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(`${field} must be at most ${max} characters`)
    expect((error as Error).message).not.toContain(sentinel)
  })

  // The blank check counts visible characters only: a value made of default-
  // ignorable characters and whitespace is refused like an empty one.
  const BLANK_LIKE: [field: 'title' | 'body_md' | 'period', name: string, text: string][] = (
    ['title', 'body_md', 'period'] as const
  ).flatMap((field): [typeof field, string, string][] => [
    [field, 'U+3164', '\u3164'],
    [field, 'U+200B', '\u200b'],
    [field, 'tag characters (non-BMP)', '\u{E0041}\u{E0042}'],
    [field, 'a variation selector', '\ufe0f'],
    [field, 'U+200B, space, U+3164 and tab', '\u200b \u3164\t'],
  ])

  it.each(BLANK_LIKE)('refuses a %s made only of %s, and writes nothing', async (field, _, text) => {
    await expect(insertInsight(insight({ [field]: text }), NOW)).rejects.toThrow(
      new RegExp(`^${field} must not be blank$`),
    )
    expect(await storedRows()).toEqual([])
  })

  // Visible text keeps its invisible characters as given: only a value with
  // nothing visible is refused, and nothing is stripped.
  const KEPT: [field: 'title' | 'body_md' | 'period', text: string][] = [
    ['title', 'Moved\u3164 twice'],
    ['body_md', 'Most\u200b of the week went to **Fixture Bakery**.'],
    ['period', '2026-W43\u3164'],
    ['title', '\u200bx\u200b'],
    ['title', 'Fixture\u0001 Bakery'],
    ['period', '2026-W43\u0090'],
    ['body_md', 'Line one\n\nFixture\u0001 Bakery\tpaid'],
  ]

  it.each(KEPT)('stores a %s with visible text among invisible characters, unchanged', async (field, text) => {
    const result = await insertInsight(insight({ [field]: text }), NOW)
    expect(result).toStrictEqual({ ok: true, id: expect.any(Number) })

    const [stored] = await storedRows()
    expect(stored[field]).toBe(text)
  })
})

// A period past its cap is refused (#340). The blank check runs first, then
// the cap, and nothing is written.
describe('insertInsight refuses a period past its cap (#340)', () => {
  it('refuses a period of 10,000 characters with the field and the cap, and writes nothing', async () => {
    const period = '2026-W43'.padEnd(10_000, 'x')
    expect(period).toHaveLength(10_000)

    await expect(insertInsight(insight({ period }), NOW)).rejects.toThrow(
      /^period must be at most 32 characters$/,
    )
    expect(await storedRows()).toEqual([])
  })
})

// A control character is invisible to the blank check (#342): a title,
// body_md or period made only of control characters, whitespace and tabs is
// refused, and nothing is written. Nothing is stripped, so a value with
// visible text among its controls is stored as given (see KEPT above).
describe('insertInsight refuses a title, body_md or period made only of control characters (#342)', () => {
  const CONTROL: [field: 'title' | 'body_md' | 'period', name: string, text: string][] = (
    ['title', 'body_md', 'period'] as const
  ).flatMap((field): [typeof field, string, string][] => [
    [field, 'U+0001', '\u0001'],
    [field, 'U+0085', '\u0085'],
    [field, 'U+0090', '\u0090'],
    [field, 'DEL', '\u007f'],
    [field, 'U+0001, space, U+0085 and tab', '\u0001 \u0085\t'],
  ])

  it.each(CONTROL)('refuses a %s made only of %s, and writes nothing', async (field, _, text) => {
    await expect(insertInsight(insight({ [field]: text }), NOW)).rejects.toThrow(
      new RegExp(`^${field} must not be blank$`),
    )
    expect(await storedRows()).toEqual([])
  })
})

describe('reading re-validates the stored chart (Ruling 8)', () => {
  async function storeRaw(text: string): Promise<number> {
    const id = await inserted(insight({ kind: 'chart', chart_spec: spec() }))
    await connection('insights').where({ id }).update({ chart_spec_json: text })
    return id
  }

  it('reads a refused spec as no chart, and keeps the rest of the row', async () => {
    const hostile = JSON.stringify(spec({ data: { url: 'https://example.invalid/rows.json' } }))
    const id = await storeRaw(hostile)
    expect((await storedRows())[0].chart_spec_json).toBe(hostile)

    const read = await getInsight(id)
    expect(Object.keys(read ?? {}).sort()).toEqual(INSIGHT_KEYS)
    expect(read).toMatchObject({ id, kind: 'chart', title: 'Top merchants this week', chart_spec_json: null })
    expect((await listInsights()).map((i) => [i.id, i.chart_spec_json])).toEqual([[id, null]])
  })

  it('reads stored text over the length cap as no chart', async () => {
    const long = JSON.stringify({ pad: 'x'.repeat(CHART_LIMITS.maxChars) })
    expect(long.length).toBeGreaterThan(CHART_LIMITS.maxChars)
    const id = await storeRaw(long)
    expect((await getInsight(id))?.chart_spec_json).toBeNull()
  })

  it("reads a valid spec back as the validator's copy", async () => {
    const id = await storeRaw(JSON.stringify(spec()))
    expect((await getInsight(id))?.chart_spec_json).toBe(canonical(spec()))
  })
})

describe('dismissInsight and listInsights', () => {
  it('dismisses once and keeps the first time', async () => {
    const id = await inserted(insight())

    expect(await dismissInsight(id, LATER)).toBe(true)
    expect(await dismissInsight(id, LATEST)).toBe(false)
    expect(await dismissInsight(id + 1000, LATER)).toBe(false)

    expect((await getInsight(id))?.dismissed_at).toBe(LATER.toISOString())
  })

  it('lists newest first (ties by id), without dismissed ones unless asked, filtered by kind and scope', async () => {
    const older = await inserted(insight(), NOW)
    const tieLow = await inserted(insight({ kind: 'report', scope: 'strawb' }), LATER)
    const tieHigh = await inserted(insight({ kind: 'chart', chart_spec: spec() }), LATER)
    const dismissed = await inserted(insight(), LATEST)
    await dismissInsight(dismissed, LATEST)

    const ids = async (filter: Parameters<typeof listInsights>[0]) =>
      (await listInsights(filter)).map((i) => i.id)

    expect(await ids(undefined)).toEqual([tieHigh, tieLow, older])
    expect(await ids({ includeDismissed: true })).toEqual([dismissed, tieHigh, tieLow, older])
    expect(await ids({ kind: 'pattern' })).toEqual([older])
    expect(await ids({ kind: 'pattern', includeDismissed: true })).toEqual([dismissed, older])
    expect(await ids({ scope: 'strawb' })).toEqual([tieLow])
    expect(await ids({ scope: 'personal', kind: 'chart' })).toEqual([tieHigh])
    for (const row of await listInsights({ includeDismissed: true })) {
      expect(Object.keys(row).sort()).toEqual(INSIGHT_KEYS)
    }
  })

  it("dismisses inside the caller's transaction: rolled back it leaves the insight open", async () => {
    const id = await inserted(insight())
    await expect(
      connection.transaction(async (trx) => {
        expect(await dismissInsight(id, LATER, trx)).toBe(true)
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    expect((await getInsight(id))?.dismissed_at).toBeNull()
  })
})

// knex's error message holds the SQL with its bound values, and a title, a
// body or a chart label can be merchant text. A test-only trigger refuses the
// write, the way a constraint would, after the accessor's own checks pass.
describe('a refused write throws without the row', () => {
  const SENTINEL = 'Fixture Merchant 4419'

  async function refuse(event: 'insert' | 'update'): Promise<void> {
    await connection.raw(
      `create trigger fixture_refusal before ${event} on insights begin select raise(abort, 'fixture refusal'); end`,
    )
  }

  it('insertInsight', async () => {
    await refuse('insert')
    const attempt = insertInsight(
      insight({
        kind: 'chart',
        title: SENTINEL,
        body_md: `Most of the week went to ${SENTINEL}.`,
        chart_spec: spec({ data: { values: [{ merchant: SENTINEL, total: 1250 }] } }),
      }),
      NOW,
    )
    await expect(attempt).rejects.toThrow(/^insertInsight failed: SQLITE_CONSTRAINT: fixture refusal$/)
    await expect(attempt).rejects.not.toThrow(SENTINEL)
    expect(await storedRows()).toEqual([])
  })

  it('dismissInsight', async () => {
    const id = await inserted(insight({ title: SENTINEL }))
    await refuse('update')
    await expect(dismissInsight(id, LATER)).rejects.toThrow(
      /^dismissInsight failed: SQLITE_CONSTRAINT: fixture refusal$/,
    )
    expect((await getInsight(id))?.dismissed_at).toBeNull()
  })
})

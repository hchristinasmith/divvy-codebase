import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { exactAmountToCents, parseExactJson } from '../exact-json.ts'

// Issue #135: the exact-text JSON reader and the strict amount reader the
// bank clients use (prd-01 Ruling 3, prd-05 Ruling 6). Every number literal
// must come back as its source text, and every text `JSON.parse` refuses must
// still be refused.

const sharedDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..')

/** Seeded PRNG, so a failing fuzz document can be reproduced. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The oracle: Node's own parser, handing back each number's source text
// through the reviver's `context.source` (Node 21+). TypeScript's lib does not
// declare the third reviver argument yet.
type SourceReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context: { source?: string },
) => unknown

const keepSource: SourceReviver = (_key, value, context) =>
  typeof value === 'number' ? context.source : value

function oracle(text: string): unknown {
  return JSON.parse(
    text,
    keepSource as unknown as Parameters<typeof JSON.parse>[1],
  )
}

// Whether this Node passes `context.source` to a reviver at all. Probed
// without `keepSource`, so a broken oracle fails the self-check below
// instead of skipping the fuzz.
function nodeHasReviverSource(): boolean {
  const probe: SourceReviver = (_key, _value, context) =>
    typeof context?.source === 'string'
  try {
    return (
      JSON.parse('1', probe as unknown as Parameters<typeof JSON.parse>[1]) ===
      true
    )
  } catch {
    return false
  }
}

const supportsSource = nodeHasReviverSource()

type Outcome = { value: unknown } | { error: string }

function outcome(parse: (text: string) => unknown, text: string): Outcome {
  try {
    return { value: parse(text) }
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'non-error throw' }
  }
}

describe('parseExactJson', () => {
  it.each([
    ['1234567.89', '1234567.89'],
    ['-5.5', '-5.5'],
    ['0.10', '0.10'],
    ['0', '0'],
    ['-0', '-0'],
    ['1e2', '1e2'],
    ['1E-2', '1E-2'],
    ['-1.5e+3', '-1.5e+3'],
    ['90071992547409.93', '90071992547409.93'],
    ['123456789012345678.99', '123456789012345678.99'],
  ])('keeps the literal %s as its exact text', (literal, text) => {
    expect(parseExactJson(`{"amount": ${literal}}`)).toEqual({ amount: text })
  })

  it('keeps a number at the root and inside nested arrays and objects', () => {
    expect(parseExactJson('5')).toBe('5')
    expect(
      parseExactJson('{"a": [0, [19.99, {"b": -0.01}]], "c": {"d": [1e2]}}'),
    ).toEqual({ a: ['0', ['19.99', { b: '-0.01' }]], c: { d: ['1e2'] } })
  })

  it.each([
    [
      'digits in a string',
      '{"r": "PO 42, 3.5 hours"}',
      { r: 'PO 42, 3.5 hours' },
    ],
    [
      'an escaped quote before a number in a string',
      '{"d": "x\\"y 12.50", "n": 7.25}',
      { d: 'x"y 12.50', n: '7.25' },
    ],
    [
      'an escaped backslash right before the closing quote',
      '{"p": "C:\\\\", "n": 3}',
      { p: 'C:\\', n: '3' },
    ],
    ['a key-like value', '{"v": "1:2"}', { v: '1:2' }],
    ['a digit-leading key', '{"10": 1}', { '10': '1' }],
    [
      'true, false and null',
      '{"a": true, "b": false, "c": null}',
      { a: true, b: false, c: null },
    ],
  ])('leaves %s untouched', (_label, text, expected) => {
    expect(parseExactJson(text)).toEqual(expected)
  })

  it.each(['01', '1.', '1-2', '-', '1e', '.5', '+1', '1e+', '--1'])(
    'throws SyntaxError on the malformed number %s, as JSON.parse does',
    (literal) => {
      const text = `{"AmountDue": ${literal}}`
      expect(() => JSON.parse(text)).toThrow(SyntaxError)
      expect(() => parseExactJson(text)).toThrow(SyntaxError)
    },
  )

  it.each([
    ['XML', '<Response><Invoices/></Response>'],
    ['empty', ''],
    ['truncated', '{"success":true,"items":['],
  ])('throws SyntaxError on a body that is not JSON (%s)', (_label, text) => {
    expect(() => parseExactJson(text)).toThrow(SyntaxError)
  })

  it.each(['{1:2}', '{"a":1,2:3}', '{1 : 2}', '{-1:2}', '{1.5:2}', '{10:2}'])(
    'keeps the numeric key in %s invalid instead of quoting it',
    (text) => {
      expect(() => JSON.parse(text)).toThrow(SyntaxError)
      expect(() => parseExactJson(text)).toThrow(SyntaxError)
    },
  )

  it('rejects an unterminated string of escaped quotes in one pass', () => {
    // A string pattern whose escape is `\\.` and that must end at a quote
    // rescans this body from every quote in it: measured at about seven
    // seconds, against well under a millisecond for the shipped pattern. The
    // limit is far from both so a slow CI machine cannot flip it.
    const body = `{"success":true,"items":["${'\\"'.repeat(100_000)}`

    const started = performance.now()
    expect(() => parseExactJson(body)).toThrow(SyntaxError)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('parseExactJson against the oracle', () => {
  it.skipIf(!supportsSource)(
    'the oracle returns source text, not a parsed number (needs JSON.parse reviver context.source, Node 21+)',
    () => {
      expect(oracle('[1.10, -0, 1e2, 19.99]')).toEqual([
        '1.10',
        '-0',
        '1e2',
        '19.99',
      ])
    },
  )

  it.skipIf(!supportsSource)(
    'agrees with the oracle on seeded valid and corrupted documents (needs JSON.parse reviver context.source, Node 21+)',
    () => {
      const rnd = mulberry32(0xc0ffee)
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(rnd() * items.length)]
      const numbers = [
        '0',
        '-0',
        '1',
        '19.99',
        '-5.5',
        '0.10',
        '1e2',
        '1E-2',
        '-1.5e+3',
        '90071992547409.93',
        '10',
        '100',
      ]
      const strings = [
        'x',
        'a\\"b 12',
        '\\\\',
        '',
        '3.5 hours',
        '\\u0041',
        'é',
        'x\\"y 12.50',
        '1:2',
        '\\"\\"',
      ]
      const keys = ['a', 'b', 'k 1', '1', '10', '2']
      const separators = [',', ' , ', ',\n']
      const alphabet = [
        '"',
        '\\',
        ':',
        ',',
        '-',
        '+',
        '.',
        'e',
        'E',
        '0',
        '1',
        '9',
        ' ',
        '{',
        '}',
        '[',
        ']',
        't',
        'n',
        '\n',
        'x',
      ]

      const generate = (depth: number): string => {
        const r = rnd()
        if (depth > 3 || r < 0.3) {
          const q = rnd()
          if (q < 0.5) return pick(numbers)
          if (q < 0.8) return `"${pick(strings)}"`
          return pick(['true', 'false', 'null'])
        }
        const n = Math.floor(rnd() * 4)
        if (r < 0.65) {
          const items = Array.from({ length: n }, () => generate(depth + 1))
          return `[${items.join(pick(separators))}]`
        }
        const members = Array.from(
          { length: n },
          (_, i) => `"${pick(keys)}${i}": ${generate(depth + 1)}`,
        )
        return `{${members.join(',')}}`
      }

      const corrupt = (text: string): string => {
        const m = rnd()
        if (m < 0.25) {
          // Unquote a key into a bare numeric one.
          return text.replace(
            /"([^"\\]*)"(\s*):/,
            (_, key: string, space: string) =>
              `${/^\d/.test(key) ? key : '1'}${space}:`,
          )
        }
        const at = Math.floor(rnd() * (text.length + 1))
        if (m < 0.5) return text.slice(0, at) + pick(alphabet) + text.slice(at)
        if (m < 0.75) return text.slice(0, at) + text.slice(at + 1)
        return text.slice(0, at) + pick(alphabet) + text.slice(at + 1)
      }

      let valid = 0
      let invalid = 0
      const differences: {
        text: string
        expected: Outcome
        actual: Outcome
      }[] = []
      for (let i = 0; i < 5_000; i += 1) {
        let text = generate(0)
        if (rnd() < 0.6) text = corrupt(text)
        const expected = outcome(oracle, text)
        const actual = outcome(parseExactJson, text)
        if ('value' in expected) valid += 1
        else invalid += 1
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          differences.push({ text, expected, actual })
        }
      }

      expect(differences.slice(0, 5)).toEqual([])
      expect(valid).toBeGreaterThan(1_000)
      expect(invalid).toBeGreaterThan(1_000)
    },
  )
})

describe('exactAmountToCents', () => {
  it.each([
    ['0', 0],
    ['5', 500],
    ['10', 1000],
    ['100', 10000],
    ['19.99', 1999],
    ['0.10', 10],
    ['0.1', 10],
    ['-0.01', -1],
    ['-5.5', -550],
    ['123456789012.34', 12345678901234],
    ['90071992547409.91', 9007199254740991],
  ])('converts %s to %i cents', (text, cents) => {
    expect(exactAmountToCents(text)).toBe(cents)
  })

  it.each(['-0', '-0.00'])('turns %s into plain 0, not -0', (text) => {
    expect(Object.is(exactAmountToCents(text), 0)).toBe(true)
  })

  // `$5`, `1,000`, ` 5`, `5 ` and `5\n` are accepted by shared parseDollars
  // (what a person types, trimmed); only the amount pattern refuses them.
  it.each([
    '01',
    '00',
    '0019.99',
    '-01',
    '',
    '1.',
    '.5',
    '+5',
    ' 5',
    '5 ',
    '5\n',
    '--5',
    '- 5',
    '1.005',
    '1e2',
    '-1.5E-1',
    '$5',
    '1,000',
    'abc',
  ])('returns null for %j, which is not an exact amount', (text) => {
    expect(exactAmountToCents(text)).toBeNull()
  })

  it('throws on an amount too large for integer cents instead of rounding it', () => {
    expect(() => exactAmountToCents('90071992547409.92')).toThrow()
    expect(() => exactAmountToCents('123456789012345678.99')).toThrow()
  })

  it('accepts only text that JSON.parse also reads as a number', () => {
    const rnd = mulberry32(135)
    const chars = ['0', '0', '1', '9', '.', '-', 'e', '5']
    let accepted = 0
    const strays: string[] = []
    for (let i = 0; i < 5_000; i += 1) {
      const length = 1 + Math.floor(rnd() * 6)
      const text = Array.from(
        { length },
        () => chars[Math.floor(rnd() * chars.length)],
      ).join('')
      let cents: number | null
      try {
        cents = exactAmountToCents(text)
      } catch {
        cents = null
      }
      if (cents === null) continue
      accepted += 1
      try {
        if (typeof JSON.parse(text) !== 'number') strays.push(text)
      } catch {
        strays.push(text)
      }
    }
    expect(strays.slice(0, 5)).toEqual([])
    expect(accepted).toBeGreaterThan(100)
  })
})

describe('the shared reader source', () => {
  const source = readFileSync(Path.join(sharedDir, 'exact-json.ts'), 'utf8')

  it('imports nothing but shared/money.ts', () => {
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    expect(specifiers).toEqual(['./money.ts'])
  })

  it.each([
    ['parseFloat', /parseFloat/],
    ['Number() conversion', /\bNumber\s*\(/],
    ['Math.round', /Math\.round/],
    ['multiplication or division by 100', /\*\s*100|\/\s*100/],
  ])('contains no %s', (_label, pattern) => {
    expect(pattern.exec(source)?.[0] ?? null).toBeNull()
  })
})

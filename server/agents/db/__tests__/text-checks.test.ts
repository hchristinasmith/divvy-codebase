import { describe, expect, it } from 'vitest'

import { atMostLength, notBlank } from '../text-checks.ts'

// The shared text checks on their own. The writers' tests cover them through
// insertInsight and insertProposal; these pin each check's edges directly.
// Every invisible or control character is written as an escape.
describe('notBlank', () => {
  const REFUSED: [name: string, value: unknown][] = [
    ['an empty string', ''],
    ['whitespace alone', '  \t\n'],
    ['a Hangul filler (default-ignorable)', '\u3164'],
    ['a zero-width space (default-ignorable)', '\u200B'],
    ['a variation selector (default-ignorable)', '\uFE0F'],
    ['a C0 control', '\u0001'],
    ['a C1 control (NEL)', '\u0085'],
    ['a C1 control (DCS)', '\u0090'],
    ['DEL', '\u007F'],
    ['several invisible characters in a row', '\u200B\u200B\u0001'],
    ['non-BMP tag characters', '\u{E0041}\u{E0042}'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['an array', []],
  ]

  it.each(REFUSED)('refuses %s, naming the field', (_, value) => {
    expect(() => notBlank(value, 'title')).toThrow(/^title must not be blank$/)
    expect(() => notBlank(value, 'reason')).toThrow(/^reason must not be blank$/)
  })

  const ACCEPTED: [name: string, value: string][] = [
    ['a single visible character', 'x'],
    ['a visible character inside spaces', ' x '],
    ['a visible character inside zero-width spaces', '\u200Bx\u200B'],
    ['a control character between visible ones', 'a\u0001b'],
    ['visible text with newlines and a tab', 'Line\n\nx\tz'],
  ]

  it.each(ACCEPTED)('accepts %s', (_, value) => {
    expect(notBlank(value, 'title')).toBeUndefined()
  })
})

describe('atMostLength', () => {
  it('accepts a value of exactly the cap', () => {
    expect(atMostLength('abcde', 'title', 5)).toBeUndefined()
  })

  it.each([
    [5, 'abcdef'],
    [7, 'abcdefgh'],
  ])('refuses one past a cap of %i, naming the field and the cap', (max, value) => {
    expect(() => atMostLength(value, 'title', max)).toThrow(
      new RegExp(`^title must be at most ${max} characters$`),
    )
    expect(() => atMostLength(value, 'reason', max)).toThrow(
      new RegExp(`^reason must be at most ${max} characters$`),
    )
  })

  it('counts a non-BMP character as one code point, not two UTF-16 units', () => {
    const max = 4
    expect(atMostLength('\u{1F600}'.repeat(max), 'title', max)).toBeUndefined()
    expect(() => atMostLength('\u{1F600}'.repeat(max + 1), 'title', max)).toThrow(
      /^title must be at most 4 characters$/,
    )
  })

  it('counts a trailing space, never trimming before the count', () => {
    expect(() => atMostLength('abc ', 'title', 3)).toThrow(/^title must be at most 3 characters$/)
  })

  it('names the field, never the value', () => {
    const SECRET = 'Fixture Merchant 6603'
    const thrown: unknown = (() => {
      try {
        atMostLength(SECRET, 'reason', 5)
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('reason must be at most 5 characters')
    expect((thrown as Error).message).not.toContain(SECRET)
    expect((thrown as Error).message).not.toContain('Fixture')
  })

  it('accepts an empty value under a cap of zero', () => {
    expect(atMostLength('', 'title', 0)).toBeUndefined()
  })
})

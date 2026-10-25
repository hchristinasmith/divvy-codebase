// The text checks the agents' inbox writers share (prd-04 Ruling 2; the
// bodies come from #313, #330, #340 and #342). It takes no table and imports
// nothing: each check only refuses a value, so the writers in insights.ts and
// proposals.ts can check their text fields the same way.
//
// A refusal names the field, never the value, because the value can carry
// merchant text. A check refuses and never strips: a value that passes is
// stored exactly as given.

/**
 * Throws `<field> must not be blank` unless `value` is a string with
 * something visible in it. Whitespace, default-ignorable characters and
 * control characters count as invisible; they are removed only for the
 * test, never from the stored value.
 */
export function notBlank(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.replace(/[\s\p{DI}\p{Cc}]/gu, '') === '') {
    throw new Error(`${field} must not be blank`)
  }
}

/**
 * Throws `<field> must be at most <max> characters` when `value` is longer
 * than `max`, counted in code points, not UTF-16 units: a non-BMP character
 * is one code point and two units. Nothing is trimmed before counting.
 */
export function atMostLength(value: string, field: string, max: number): void {
  if (Array.from(value).length > max) {
    throw new Error(`${field} must be at most ${max} characters`)
  }
}

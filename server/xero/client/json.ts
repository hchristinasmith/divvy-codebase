import { badResponse } from './errors.ts'
import { xeroAmountToCents } from './money.ts'

// Reading Xero's JSON without letting an amount become a float.
//
// `JSON.parse` turns `1234567.89` into a binary double before any code can
// see it. `parseXeroJson` therefore rewrites every number literal outside a
// string into a string literal holding the same characters, then parses. The
// result has no numbers in it at all: amounts arrive as their decimal text and
// go through `xeroAmountToCents`; counts (pagination) go through `readCount`.
//
// The readers below narrow `unknown` one field at a time and raise
// `bad_response` naming the field, never echoing the value.

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

// Characters a JSON number literal may contain. A malformed run such as `1-2`
// is quoted as-is and then refused by whichever reader meets it.
function isNumberChar(ch: string): boolean {
  return (
    isDigit(ch) ||
    ch === '-' ||
    ch === '+' ||
    ch === '.' ||
    ch === 'e' ||
    ch === 'E'
  )
}

/** JSON.parse with every number literal kept as its source text. */
export function parseXeroJson(text: string): unknown {
  let out = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        // Copy the escaped character too, so `\"` does not end the string.
        i += 1
        if (i < text.length) out += text[i]
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '-' || isDigit(ch)) {
      let end = i + 1
      while (end < text.length && isNumberChar(text[end])) end += 1
      out += `"${text.slice(i, end)}"`
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return JSON.parse(out)
}

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readRecord(value: unknown, what: string): JsonRecord {
  if (!isRecord(value)) throw badResponse(`${what} is not an object`)
  return value
}

export function readArray(record: JsonRecord, key: string): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw badResponse(`${key} is not a list`)
  return value
}

export function readString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw badResponse(`${key} is missing or not text`)
  }
  return value
}

export function readOptionalString(
  record: JsonRecord,
  key: string,
): string | null {
  const value = record[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw badResponse(`${key} is not text`)
  return value
}

/** An amount field as integer cents; anything else is `bad_response`. */
export function readCents(record: JsonRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'string')
    throw badResponse(`${key} is missing or not an amount`)
  try {
    return xeroAmountToCents(value)
  } catch {
    throw badResponse(`${key} is not an amount in cents`)
  }
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(T[0-9:.]*)?$/

function trimDate(value: string, key: string): string {
  const match = DATE_PREFIX.exec(value)
  if (!match) throw badResponse(`${key} is not a date`)
  return match[1]
}

/** Xero's "2026-09-01T00:00:00" → "2026-09-01". */
export function readDate(record: JsonRecord, key: string): string {
  return trimDate(readString(record, key), key)
}

export function readOptionalDate(
  record: JsonRecord,
  key: string,
): string | null {
  const value = readOptionalString(record, key)
  return value === null ? null : trimDate(value, key)
}

const COUNT = /^\d+$/

/** A non-negative whole number, such as a page count. */
export function readCount(value: unknown, what: string): number {
  if (typeof value !== 'string' || !COUNT.test(value)) {
    throw badResponse(`${what} is not a whole number`)
  }
  const n = parseInt(value, 10)
  if (!Number.isSafeInteger(n)) throw badResponse(`${what} is out of range`)
  return n
}

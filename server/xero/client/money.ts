import { exactAmountToCents } from '../../../shared/exact-json.ts'

// Xero amount → integer cents, once, at the boundary (prd-05 Ruling 6,
// prd-01 Ruling 3).
//
// The input is always the decimal text Xero sent: `parseExactJson`
// (shared/exact-json.ts, called from http.ts) quotes every number literal
// before `JSON.parse`, so `1234567.89` is never a binary float on the way
// here. The conversion is the shared `exactAmountToCents`: a strict pattern
// (JSON's number grammar, at most two decimal places, no exponent) and then
// string arithmetic in `parseDollars`; nothing on this path calls a float
// parser on a decimal.
//
// `parseDollars` also accepts what a person types ("$5", "1,000"). Xero never
// sends those, so the strict pattern refuses them, along with exponents, a
// leading zero and a third decimal place: a shape this client has not seen is
// refused, never rounded.

/**
 * "19.99" → 1999, "-5.5" → -550, "-0" → 0. Throws RangeError for a shape Xero
 * does not send; a TypeError (from `parseDollars`, shared/money.ts) for an
 * amount too large for integer cents.
 */
export function xeroAmountToCents(raw: string): number {
  const cents = exactAmountToCents(raw)
  if (cents === null) {
    throw new RangeError(`"${raw}" is not a Xero amount`)
  }
  return cents
}

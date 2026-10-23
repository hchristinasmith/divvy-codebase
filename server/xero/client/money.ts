import { parseDollars } from '../../../shared/money.ts'

// Xero amount → integer cents, once, at the boundary (prd-05 Ruling 6,
// prd-01 Ruling 3).
//
// The input is always the decimal text Xero sent: `parseXeroJson` (json.ts)
// quotes every number literal before `JSON.parse`, so `1234567.89` is never a
// binary float on the way here. The conversion itself is string arithmetic in
// `parseDollars`; nothing on this path calls a float parser on a decimal.
//
// `parseDollars` also accepts what a person types ("$5", "1,000"). Xero never
// sends those, so the strict pattern below runs first and refuses them, along
// with exponents and a third decimal place: a shape this client has not seen
// is refused, never rounded.

const XERO_AMOUNT = /^-?\d+(\.\d{1,2})?$/

/** "19.99" → 1999, "-5.5" → -550, "-0" → 0. Throws RangeError otherwise. */
export function xeroAmountToCents(raw: string): number {
  if (!XERO_AMOUNT.test(raw)) {
    throw new RangeError(`"${raw}" is not a Xero amount`)
  }
  return parseDollars(raw)
}

// Money is integer cents everywhere Divvy stores or computes it (M1 #8, D12).
//
// Akahu sends dollars as decimal text; responses the sync reads become cents
// once, at the boundary in `server/sync/akahu-client.ts`, through
// `exactAmountToCents` (shared/exact-json.ts) and `parseDollars` here.
// `dollarsToCents` is the seed's float path only. Cents are formatted for
// display only at the edge (`formatCents`). Nothing in between multiplies or
// divides by 100.
//
// This module is imported by the client, the server and the knex seed. The
// seed runs under plain Node, which strips the types, so keep this file free
// of TypeScript-only runtime syntax (enums, namespaces, parameter
// properties) and free of imports.

function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${what} must be an integer number of cents, got ${value}`)
  }
}

/** Formats cents as NZD for display: 123456 → "$1,234.56", -550 → "-$5.50". */
export function formatCents(cents: number): string {
  assertCents(cents, 'formatCents')
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rest = String(abs % 100).padStart(2, '0')
  return `${sign}$${dollars}.${rest}`
}

/**
 * Converts a float dollar amount to integer cents, rounding half away from
 * zero on the decimal value, so 1.005 → 101 even though 1.005 * 100 is
 * 100.49999999999999 in binary floating point. Akahu data the sync reads
 * never reaches this function: `server/sync/akahu-client.ts` reads it as exact
 * text and converts it through `exactAmountToCents`, which calls
 * `parseDollars`. Only the seed (`server/db/seeds/transactions.js`) uses this
 * float path.
 */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) {
    throw new TypeError(`dollarsToCents needs a finite number, got ${dollars}`)
  }
  const scaled = Number((Math.abs(dollars) * 100).toPrecision(15))
  const cents = Math.round(scaled) * (dollars < 0 ? -1 : 1)
  assertCents(cents, 'dollarsToCents result')
  return cents === 0 ? 0 : cents
}

const DOLLARS_INPUT = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/**
 * Parses a typed dollar amount ("12", "12.5", "$1,234.56", "-4.20") into
 * integer cents. Refuses anything with more than two decimal places rather
 * than rounding what a person typed.
 */
export function parseDollars(input: string): number {
  const match = DOLLARS_INPUT.exec(input.trim())
  if (!match) {
    throw new RangeError(`"${input}" is not a dollar amount`)
  }
  const [, minus, whole, fraction = ''] = match
  const cents =
    Number(whole.replace(/,/g, '')) * 100 + Number(fraction.padEnd(2, '0'))
  assertCents(cents, 'parseDollars result')
  return minus && cents !== 0 ? -cents : cents
}

/** Sums integer cents; refuses a non-integer input instead of drifting. */
export function sumCents(values: readonly number[]): number {
  let total = 0
  for (const v of values) {
    assertCents(v, 'sumCents input')
    total += v
  }
  assertCents(total, 'sumCents result')
  return total
}

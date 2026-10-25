import { parseDollars } from './money.ts'

// Reading a bank's JSON without letting an amount become a float (prd-01
// Ruling 3, prd-05 Ruling 6).
//
// `JSON.parse` turns `1234567.89` into a binary double before any code can
// see it. `parseExactJson` therefore rewrites every number literal outside a
// string into a string literal holding the same characters, then parses. The
// result has no numbers in it at all: an amount arrives as the decimal text
// the bank sent and becomes integer cents through `exactAmountToCents`, which
// is string arithmetic. Nothing on this path calls a float parser on a
// decimal, multiplies or divides by 100, or rounds.
//
// The rewrite is one regular expression, one token at a time: a whole string
// literal (escapes included, so `\"` does not end it), or a JSON number
// literal.
// - A number is matched by JSON's own grammar, so `01` splits into `0` and
//   `1` and the quoted result fails to parse, as `JSON.parse` would.
// - A number followed by `:` is left bare, so an invalid numeric key stays
//   invalid instead of becoming a quoted one.
// - An escape may stop at its backslash (`\\[\s\S]?`) and a string may end at
//   the end of the text (`(?:"|$)`), so a string with no closing quote is
//   consumed once (still invalid) rather than rescanned from every quote in
//   it.
//
// The amount pattern is JSON's number grammar too (no leading zero, no
// exponent) with at most two decimal places, so a quoted amount cannot slip
// past it with a shape a bare number literal could not have (`"0019.99"`).
// `parseDollars` also accepts what a person types (`$5`, `1,000`); a bank
// never sends those, so the pattern runs first and refuses them. A shape not
// seen before is refused, never rounded.
//
// The bank clients (server/sync/akahu-client.ts, server/xero/client/) read
// every response body through here. Like shared/money.ts, the file stays free
// of TypeScript-only runtime syntax, and it imports nothing but that module.

const JSON_TOKEN =
  /"(?:[^"\\]|\\[\s\S]?)*(?:"|$)|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?!\s*:)/g

/**
 * `JSON.parse` with every number literal kept as its source text. Throws
 * `SyntaxError` on any text `JSON.parse` would refuse.
 */
export function parseExactJson(text: string): unknown {
  return JSON.parse(
    text.replace(JSON_TOKEN, (token) =>
      token.startsWith('"') ? token : `"${token}"`,
    ),
  )
}

const EXACT_AMOUNT = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/

/**
 * Exact decimal-dollar text as integer cents: "19.99" → 1999, "-5.5" → -550,
 * "-0" → 0 (never -0). Null when the text is not that shape. An amount too
 * large for integer cents throws (from `parseDollars`), rather than being
 * rounded or reported as a shape.
 */
export function exactAmountToCents(text: string): number | null {
  if (!EXACT_AMOUNT.test(text)) return null
  return parseDollars(text)
}

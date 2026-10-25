import { formatCents, parseDollars } from '../../../shared/money.ts'

// The settings panel's input edge (issue 46). Money is integer cents and the
// tax rate is integer basis points everywhere past this file; what a person
// types is turned into them here, by exact string arithmetic, never by
// multiplying a float. Each parser answers a value or the message to show
// beside the field.

export type Parsed = { value: number } | { error: string }

/** Cents as the dollar field shows them: 104999 → "1049.99", 0 → "0.00". */
export function centsToDollarsField(cents: number): string {
  return formatCents(cents).replace(/[$,]/g, '')
}

/**
 * A typed dollar amount ("1049.99", "1,500.50", "$12") as cents, 0 or more.
 * Empty is refused, never read as 0; more than two decimal places is refused
 * rather than rounded.
 */
export function parseDollarsField(input: string): Parsed {
  const text = input.trim()
  if (text === '') return { error: 'Required' }
  let cents: number
  try {
    cents = parseDollars(text)
  } catch {
    return { error: 'Enter dollars and cents, like 1049.99' }
  }
  if (cents < 0) return { error: 'Must be 0 or more' }
  return { value: cents }
}

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/

/**
 * A typed percentage ("25", "25%", "10.5", "0.01") as basis points, 0 to
 * 10000. The digits are joined, not multiplied: "10.5" is "10" + "50".
 */
export function parsePercentField(input: string): Parsed {
  const text = input.trim().replace(/%$/, '').trim()
  if (text === '') return { error: 'Required' }
  const match = PERCENT.exec(text)
  if (!match) return { error: 'Enter a percentage, like 25 or 10.5' }
  const [, whole, fraction = ''] = match
  const basisPoints = Number(whole + fraction.padEnd(2, '0'))
  if (basisPoints > 10000) return { error: 'Must be 100% or less' }
  return { value: basisPoints }
}

/** Basis points as the percentage field shows them: 2500 → "25", 1050 → "10.5", 1005 → "10.05". */
export function basisPointsToPercentField(basisPoints: number): string {
  const digits = String(basisPoints).padStart(3, '0')
  const whole = digits.slice(0, -2)
  const fraction = digits.slice(-2).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

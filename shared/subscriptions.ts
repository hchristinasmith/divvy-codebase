// Subscriptions: the one detection and the one set of totals (prd-02
// Ruling 14). `server/db/subscriptions.ts` loads rows and calls
// `subscriptions`; the route sends what it returns. Nothing else re-derives
// a cadence, a per-month figure or a total. prd-03 may later read the same
// function.
//
// Detection is computed on read; nothing about it is stored.
//
// - A charge is a settled outflow in the view's scope (any scope for `all`)
//   whose merchant key can be built. A pending row, an inflow and a row of
//   the other scope are never charges.
// - A merchant is its key in one scope: `m:<Akahu merchant_id>`, else
//   `d:<normalised description>` (`merchantKeyOf`). The same merchant paid
//   from both scopes is two merchants, each with its own answer and cancel.
// - A merchant is detected when it has at least `MIN_CHARGES` charges and
//   every gap between consecutive charges, over all of them, sits in the
//   same band of `CADENCE_BANDS` (weekly, monthly or yearly, each a gap in
//   days with a tolerance, inclusive, as the Ruling sets them). A same-day
//   pair is a gap of no days, which fits no band, so a merchant charged
//   twice in a day is not detected unless Hannah marks it.
// - Its amount is the latest charge, so a price change shows at the new
//   price. Its name is the latest charge's merchant name, else its
//   description, else `UNNAMED_MERCHANT`.
//
// Hannah has the last word (Ruling 14). Her answer is stored per scope and
// merchant key, so it survives a sync that replaces rows:
//
// - `subscription`: listed as a subscription whatever detection says. Its
//   cadence is whatever its gaps show; when they show none (one charge, or
//   irregular gaps) the cadence and per-period figures are null, the row is
//   listed and left out of the totals, and `totals.uncountedCount` says how
//   many were left out. Nothing is guessed.
// - `not_subscription`: listed only under `notSubscriptions`, so she can
//   undo it. Never counted, never asked about.
// - no answer: a detected merchant is a subscription. One with fewer than
//   `MIN_CHARGES` charges whose name shares a word with `SUBSCRIPTION_HINTS`
//   is a question ("Is this a subscription?"), never counted. Anything else
//   is not listed.
//
// Cancel marks, it never acts. A cancel date is held with her answer. The
// first charge dated after it is `chargedAgainOn`, and the row is active
// again; until then it is `cancelled`. A charge on the cancel date itself is
// before the cancel. A cancelled row is listed and is not in the totals:
// the totals are what she still pays.
//
// Totals are integer cents (M1 #8). Per month, each subscription is rounded
// half-up once: monthly is the amount, weekly is amount × 52 ÷ 12, yearly is
// amount ÷ 12. Per year is 12 × the per-month figure, never amount × 52, so
// there is no second rounding. The totals sum those figures over active rows
// with a cadence. Subscriptions are not part of safe-to-spend: their charges
// already land as transactions, and future ones are Bills.
//
// The merchant key is a stored contract (`subscription_marks.merchant_key`,
// 20261025170000_subscription_marks.js). Changing `normaliseDescription` or
// `merchantKeyOf` orphans every stored answer and cancel date whose key
// changes; the literal keys are pinned in the tests for that reason.
//
// Known limits of the Ruling as written: gaps are checked over all history,
// so one skipped month stops detection (Hannah can mark it), and a
// subscription with no recent charge stays active until she cancels it.
//
// Dates are `YYYY-MM-DD` calendar dates with no timezone; the caller turns
// each transaction's instant into Hannah's NZ date. Nothing here reads the
// clock.

import type {
  Cents,
  IsoDate,
  RowScope,
  Scope,
  SubscriptionAnswer,
  SubscriptionCadence,
  SubscriptionMerchant,
  SubscriptionRow,
  SubscriptionsResponse,
  TransactionStatus,
} from './contracts.ts'
import { sumCents } from './money.ts'
import { daysBetween, daysInMonth } from './safe-to-spend.ts'

// ---------------------------------------------------------------------------
// Constants (prd-02 Ruling 14)
// ---------------------------------------------------------------------------

/** Fewest settled charges that can make a detected subscription. */
export const MIN_CHARGES = 3

export const WEEKLY_GAP_DAYS = 7
export const WEEKLY_TOLERANCE_DAYS = 2
export const MONTHLY_GAP_DAYS = 30
export const MONTHLY_TOLERANCE_DAYS = 4
export const YEARLY_GAP_DAYS = 365
export const YEARLY_TOLERANCE_DAYS = 10

/** Inclusive bands of days between charges. They do not overlap. */
export const CADENCE_BANDS: readonly {
  cadence: SubscriptionCadence
  days: number
  toleranceDays: number
}[] = [
  {
    cadence: 'weekly',
    days: WEEKLY_GAP_DAYS,
    toleranceDays: WEEKLY_TOLERANCE_DAYS,
  },
  {
    cadence: 'monthly',
    days: MONTHLY_GAP_DAYS,
    toleranceDays: MONTHLY_TOLERANCE_DAYS,
  },
  {
    cadence: 'yearly',
    days: YEARLY_GAP_DAYS,
    toleranceDays: YEARLY_TOLERANCE_DAYS,
  },
]

export const WEEKS_PER_YEAR = 52
export const MONTHS_PER_YEAR = 12

/** Longest stored merchant key, prefix included (the column is 255). */
export const MAX_MERCHANT_KEY_LENGTH = 255

export const UNNAMED_MERCHANT = 'Unnamed merchant'

/**
 * Words in a merchant's name that make it worth asking about. Lowercase
 * single words, matched whole against the words of the normalised name, so
 * plurals are listed separately.
 */
export const SUBSCRIPTION_HINTS: readonly string[] = [
  'subscription',
  'subscriptions',
  'membership',
  'memberships',
  'streaming',
  'software',
  'premium',
  'cloud',
  'hosting',
  'vpn',
  'newsletter',
  'magazine',
  'antivirus',
]

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A stored transaction, with its account's scope and its NZ date. */
export interface SubscriptionTransaction {
  scope: RowScope
  status: TransactionStatus
  date: IsoDate
  /** Signed, as stored: negative is money out. */
  amountCents: Cents
  merchantId: string | null
  merchantName: string | null
  description: string | null
}

/** What Hannah has said about one merchant in one scope. */
export interface SubscriptionMark {
  scope: RowScope
  merchantKey: string
  answer: SubscriptionAnswer | null
  cancelledOn: IsoDate | null
}

export interface SubscriptionsInput {
  scope: Scope
  transactions: readonly SubscriptionTransaction[]
  marks: readonly SubscriptionMark[]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real `YYYY-MM-DD` calendar date: `2028-02-29` is, `2026-02-30` is not. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  )
}

function assertDate(value: IsoDate, what: string): void {
  if (!isIsoDate(value)) {
    throw new RangeError(
      `${what} must be a YYYY-MM-DD calendar date, got "${value}"`,
    )
  }
}

function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${what} must be an integer number of cents, got ${value}`,
    )
  }
}

function isRowScope(value: unknown): value is RowScope {
  return value === 'personal' || value === 'strawb'
}

/**
 * The shape `merchantKeyOf` builds and `subscription_marks.merchant_key`'s
 * CHECK holds: 3 to `MAX_MERCHANT_KEY_LENGTH` characters starting `m:` or
 * `d:`.
 */
export function isMerchantKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= MAX_MERCHANT_KEY_LENGTH &&
    (value.startsWith('m:') || value.startsWith('d:'))
  )
}

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

/**
 * Lowercase, every run of non-letters (digits, punctuation, card and store
 * numbers) one space, trimmed. Part of the stored key: see the header.
 */
export function normaliseDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
}

/**
 * `m:<merchant id>` when Akahu sent an id that fits, else
 * `d:<normalised description>` cut to fit, else null: a row with neither is
 * never a charge. `merchantName` alone never names a key.
 */
export function merchantKeyOf(tx: {
  merchantId: string | null
  description: string | null
}): string | null {
  const id = tx.merchantId?.trim() ?? ''
  if (id !== '' && 2 + id.length <= MAX_MERCHANT_KEY_LENGTH) return `m:${id}`
  const normalised = normaliseDescription(tx.description ?? '')
  if (normalised === '') return null
  return `d:${normalised.slice(0, MAX_MERCHANT_KEY_LENGTH - 2)}`
}

function displayName(tx: SubscriptionTransaction): string {
  return tx.merchantName?.trim() || tx.description?.trim() || UNNAMED_MERCHANT
}

/** The name shares a whole word with `SUBSCRIPTION_HINTS`. */
export function nameLooksLikeSubscription(name: string): boolean {
  return normaliseDescription(name)
    .split(' ')
    .some((word) => SUBSCRIPTION_HINTS.includes(word))
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * The cadence whose band holds every gap between consecutive `dates`
 * (ascending), or null: fewer than two dates, gaps in different bands, or a
 * gap in none.
 */
export function classifyGaps(
  dates: readonly IsoDate[],
): SubscriptionCadence | null {
  if (dates.length < 2) return null
  const gaps: number[] = []
  for (let i = 1; i < dates.length; i++)
    gaps.push(daysBetween(dates[i - 1], dates[i]))
  for (const band of CADENCE_BANDS) {
    const lo = band.days - band.toleranceDays
    const hi = band.days + band.toleranceDays
    if (gaps.every((gap) => gap >= lo && gap <= hi)) return band.cadence
  }
  return null
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * `n ÷ d` rounded half-up, for a non-negative integer `n` and a positive
 * integer `d`, in exact integer arithmetic: floor((2n + d) ÷ 2d).
 */
export function roundHalfUpDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(
      `roundHalfUpDiv needs a non-negative integer, got ${n}`,
    )
  }
  if (!Number.isSafeInteger(d) || d <= 0) {
    throw new RangeError(
      `roundHalfUpDiv needs a positive integer divisor, got ${d}`,
    )
  }
  const num = 2 * n + d
  const den = 2 * d
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new RangeError(`roundHalfUpDiv input is too large: ${n} ÷ ${d}`)
  }
  return (num - (num % den)) / den
}

/** One subscription's per-month figure, rounded once. */
export function perMonthCents(
  cadence: SubscriptionCadence,
  amountCents: Cents,
): Cents {
  assertCents(amountCents, 'amountCents')
  if (amountCents < 0) {
    throw new RangeError(`amountCents must not be negative, got ${amountCents}`)
  }
  switch (cadence) {
    case 'monthly':
      return amountCents
    case 'weekly':
      return roundHalfUpDiv(amountCents * WEEKS_PER_YEAR, MONTHS_PER_YEAR)
    case 'yearly':
      return roundHalfUpDiv(amountCents, MONTHS_PER_YEAR)
    default: {
      const never: never = cadence
      throw new RangeError(`unknown cadence ${String(never)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

interface Charge {
  tx: SubscriptionTransaction
  /** Positive cents. */
  amountCents: Cents
}

interface Group {
  scope: RowScope
  merchantKey: string
  charges: Charge[]
}

function groupKey(scope: RowScope, merchantKey: string): string {
  return `${scope}\u0000${merchantKey}`
}

function validateTransaction(tx: SubscriptionTransaction, i: number): void {
  if (!isRowScope(tx.scope)) {
    throw new RangeError(`transactions[${i}].scope must be personal or strawb`)
  }
  assertCents(tx.amountCents, `transactions[${i}].amountCents`)
  assertDate(tx.date, `transactions[${i}].date`)
}

function validateMark(mark: SubscriptionMark, i: number): void {
  if (!isRowScope(mark.scope)) {
    throw new RangeError(`marks[${i}].scope must be personal or strawb`)
  }
  if (!isMerchantKey(mark.merchantKey)) {
    throw new RangeError(`marks[${i}].merchantKey is not a merchant key`)
  }
  if (
    mark.answer !== null &&
    mark.answer !== 'subscription' &&
    mark.answer !== 'not_subscription'
  ) {
    throw new RangeError(`marks[${i}].answer is not an answer`)
  }
  if (mark.cancelledOn !== null)
    assertDate(mark.cancelledOn, `marks[${i}].cancelledOn`)
}

function byName<T extends SubscriptionMerchant>(a: T, b: T): number {
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  if (an !== bn) return an < bn ? -1 : 1
  if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1
  if (a.merchantKey !== b.merchantKey)
    return a.merchantKey < b.merchantKey ? -1 : 1
  return 0
}

/**
 * Every subscription, question and not-a-subscription merchant in the
 * view's scope, with the totals. See the header for each rule.
 */
export function subscriptions(
  input: SubscriptionsInput,
): SubscriptionsResponse {
  const { scope } = input
  if (scope !== 'all' && scope !== 'personal' && scope !== 'strawb') {
    throw new RangeError(
      `scope must be all, personal or strawb, got "${String(scope)}"`,
    )
  }
  input.transactions.forEach(validateTransaction)
  input.marks.forEach(validateMark)

  const groups = new Map<string, Group>()
  for (const tx of input.transactions) {
    if (tx.status !== 'settled' || tx.amountCents >= 0) continue
    if (scope !== 'all' && tx.scope !== scope) continue
    const merchantKey = merchantKeyOf(tx)
    if (merchantKey === null) continue
    const key = groupKey(tx.scope, merchantKey)
    let group = groups.get(key)
    if (group === undefined) {
      group = { scope: tx.scope, merchantKey, charges: [] }
      groups.set(key, group)
    }
    group.charges.push({ tx, amountCents: -tx.amountCents })
  }

  const marks = new Map<string, SubscriptionMark>()
  for (const mark of input.marks)
    marks.set(groupKey(mark.scope, mark.merchantKey), mark)

  const rows: SubscriptionRow[] = []
  const questions: SubscriptionMerchant[] = []
  const notSubscriptions: SubscriptionMerchant[] = []

  for (const [key, group] of groups) {
    // Array sort is stable, so charges on one date keep their input order
    // and the last of them is the latest.
    const charges = [...group.charges].sort((a, b) =>
      a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : 0,
    )
    const dates = charges.map((c) => c.tx.date)
    const latest = charges[charges.length - 1]
    const merchant: SubscriptionMerchant = {
      merchantKey: group.merchantKey,
      scope: group.scope,
      name: displayName(latest.tx),
      chargeCount: charges.length,
      lastChargedOn: latest.tx.date,
      amountCents: latest.amountCents,
    }

    const cadence = classifyGaps(dates)
    const detected = charges.length >= MIN_CHARGES && cadence !== null
    const mark = marks.get(key)
    const answer = mark?.answer ?? null

    if (answer === 'not_subscription') {
      notSubscriptions.push(merchant)
    } else if (answer === 'subscription' || detected) {
      const cancelledOn = mark?.cancelledOn ?? null
      const chargedAgainOn =
        cancelledOn === null
          ? null
          : (dates.find((d) => d > cancelledOn) ?? null)
      const perMonth =
        cadence === null ? null : perMonthCents(cadence, merchant.amountCents)
      const perYear = perMonth === null ? null : MONTHS_PER_YEAR * perMonth
      if (perYear !== null) assertCents(perYear, 'perYearCents')
      rows.push({
        ...merchant,
        cadence,
        detected,
        marked: answer === 'subscription',
        status:
          cancelledOn !== null && chargedAgainOn === null
            ? 'cancelled'
            : 'active',
        cancelledOn,
        chargedAgainOn,
        perMonthCents: perMonth,
        perYearCents: perYear,
      })
    } else if (
      charges.length < MIN_CHARGES &&
      nameLooksLikeSubscription(merchant.name)
    ) {
      questions.push(merchant)
    }
  }

  const active = rows.filter((row) => row.status === 'active')
  const counted: Cents[] = []
  let uncountedCount = 0
  for (const row of active) {
    if (row.perMonthCents === null) uncountedCount++
    else counted.push(row.perMonthCents)
  }
  const totalPerMonth = sumCents(counted)
  const totalPerYear = MONTHS_PER_YEAR * totalPerMonth
  assertCents(totalPerYear, 'totals.perYearCents')

  return {
    subscriptions: rows.sort(byName),
    questions: questions.sort(byName),
    notSubscriptions: notSubscriptions.sort(byName),
    totals: {
      perMonthCents: totalPerMonth,
      perYearCents: totalPerYear,
      countedCount: counted.length,
      uncountedCount,
    },
  }
}

// Subscriptions: the one detection and the one set of totals (prd-02
// Rulings 14 and 16). `server/db/subscriptions.ts` loads rows and calls
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
// - The all-history rule is tried first. A merchant is detected by it when
//   it has at least `MIN_CHARGES` charges and every gap between consecutive
//   charges, over all of them, sits in the same band of `CADENCE_BANDS`
//   (weekly, monthly or yearly, each a gap in days with a tolerance,
//   inclusive, as the Ruling sets them). A same-day pair is a gap of no
//   days, which fits no band. A merchant this rule detects is one row under
//   its bare key, exactly as before prd-02 Ruling 16; a merchant it misses
//   is read again as lanes (below).
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
// A charge after the cancel rarely keeps the old rhythm, so with a cancel
// date the charges up to and including it can stand for all of them. When
// all of them show no cadence, the cadence is the one those show; when
// those alone make a detection, the merchant is detected. The later charge
// then shows as charged again, and the amount is still the latest charge.
// Without a cancel date this never applies.
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
// Lanes (prd-02 Ruling 16, #391). One merchant can bill several
// subscriptions, on one day or days apart, and one subscription can move
// its billing day or sit beside one-off charges; the all-history rule
// misses all of these. So a merchant it does not detect, and that Hannah
// has not marked not a subscription, is read again as lanes, each its own
// subscription.
//
// Dealing. The merchant's charges are put in lane order (date, then cents,
// then name, then input order, so the order rows arrive in on one date
// never changes a lane) and dealt one date at a time, oldest first, never
// from the clock:
// - A charge can join only a lane that existed before its date, and a lane
//   takes at most one charge a date. A charge no lane takes starts a lane.
// - A lane takes a charge when the gap from its last charge sits in a band
//   of `LANE_CADENCES` (the lane's own, once it has one); its gaps, this one
//   included, stay within `LANE_MAX_GAP_SPREAD_DAYS` of each other; and the
//   charge lands within `LANE_MAX_DEVIATION_DAYS` of the expected billing
//   day. That day is the lane's anchor day (the latest day of the month
//   among its charges, so a month-end biller's 28th and 31st agree) in the
//   next month, or the same month a year on, cut to that month's last day.
// - When several lanes and charges compete on one date, places go in this
//   order: nearest the expected day (anything within
//   `LANE_DEVIATION_SLACK_DAYS` counts as on it); a lane with two charges or
//   more before a newer one; nearest in cents to the lane's last charge; the
//   same name as it; then lane order and lane order of charges. Amount only
//   breaks ties: there is no amount tolerance and no percentage.
// - A lane passes over a charge when a later one, still in its band, lands
//   nearer the expected day and is no further in cents than the nearest of
//   that date's charges: it waits, so it does not take a sibling's charge
//   that happens to come first.
// - Weekly is never a lane cadence: weekly stays on the all-history rule, so
//   frequent visits never become a weekly subscription by skipping (#393).
//
// A lane with at least `MIN_CHARGES` charges is formed. Formed lanes are
// numbered in the order they formed: by the date of their `MIN_CHARGES`-th
// charge, then their first charge, then lane order. A new charge adds to
// the end of that order; only the wait for a nearer charge can re-deal a
// lane that has just formed.
//
// Keys. The first lane to form holds the bare key, `m:<id>` or `d:<desc>`,
// and keeps it, even once it stops: no rule passes it to a sibling, with
// one exception, in the read where it first forms. When two subscriptions
// of one merchant bill within `LANE_MAX_DEVIATION_DAYS` of each other, a
// lane can form by taking a charge 1 to `LANE_MAX_DEVIATION_DAYS` days
// before its expected day as its `MIN_CHARGES`-th; when the sibling's
// charge, nearer that day, arrives, the wait for a nearer charge re-deals
// it, and the sibling forms first and takes the bare key, with any mark set
// on it in that read.
// After that read the bare key never moves. Measured in review on
// 2026-10-26 with invented merchants: 12 of 8000 whose billing days were
// within 3 days of each other moved it, 0 of 4000 with random billing
// days. Hannah accepted this window (Baseline decision 4e6a7dcd, option
// A); a test pins the example. Every later lane's key is built from what
// it is, `<bare key>#<first charge date>:<first charge cents>`, e.g.
// `m:merchant_a#2026-01-05:1500`; when two later lanes would build the
// same key, the later formed gets `.2`, the next `.3`. A position is never
// used, because positions shift and would carry a mark to another lane.
// Lane keys are a stored contract, held in
// `subscription_marks` beside the bare keys with no migration: the
// column's CHECK and `isMerchantKey` accept them, and `#` never occurs in a
// `d:` key. A merchant whose `m:` id holds `#`, whose bare key leaves
// fewer than `LANE_KEY_HEADROOM` characters, or one of whose lane keys is
// another merchant's bare key, is never split: once a second lane forms it
// lists no lane, and only a `subscription` answer on its bare key lists it,
// by the all-history rule.
//
// Listing. A formed lane is listed when it is clear and live, or pinned:
// - clear: the charges inside its span (first to last charge) that are in
//   no formed lane number at most one for every two of its own (the noise
//   guard, which stops a supermarket or a weekly restaurant forming a
//   "monthly" lane from every fourth visit); once any two formed lanes of
//   the merchant have overlapped in time, a monthly lane needs
//   `LANE_MIN_CHARGES_SHARED` charges; and if more than
//   `LANE_MAX_CONCURRENT` formed lanes ever overlapped on one date, no lane
//   of that merchant is clear: it is too dense to split, and it fails
//   closed to the all-history rule.
// - live: its last charge is within its band's high edge of the merchant's
//   latest charge, so a lane that stopped drops off unless it is pinned.
// - pinned: Hannah has an answer or a cancel date on its key. A pinned lane
//   is listed even stale or not clear, so a cancelled row stays listed as
//   cancelled (Ruling 14) and a mark never vanishes.
// A lane row's `detected` is whether it would be listed with no mark (clear
// and live), as for a merchant: a stale or unclear row listed only by her
// `subscription` answer is not detected, so the screen offers to unmark it.
// A charge in no listed lane (a one-off, an older run) is in no row: not in
// its count, its last charge date or its amount. A lane's amount and name
// are its latest charge's, as for a merchant. `chargeKeys` lists every key a
// write may name: every charge's bare key and every listed lane's key, so an
// unpinned lane that is not listed cannot be written.
//
// Marks on lanes. A mark on a lane key belongs to that lane. Her
// `subscription` answer and cancel date on the bare key belong to the lane
// that holds it. `not_subscription` on the bare key hides every lane of that
// merchant: the merchant is listed once, under `notSubscriptions` with its
// bare key and all its charges, as before Ruling 16, and clearing that
// answer brings the lanes back. The cancel-date reading above belongs to the
// all-history rule, which runs first; a lane is never re-read up to its
// cancel date.
//
// What the lanes can get wrong:
// - Irregular visitors. A merchant visited about monthly `MIN_CHARGES` or
//   more times in a row can show as a subscription even with one-offs
//   between. A fortnightly merchant can show as a monthly row at half its
//   real cost, but only briefly: each 28-day step lands days before the
//   expected day, so its lanes drift past `LANE_MAX_DEVIATION_DAYS` within
//   a few charges, stop, and drop off. Measured on 2026-10-26 (Hannah
//   asked for these numbers): one invented merchant, its first visit on 1
//   January 2026 and each next one a whole number of days later, at random
//   within the range, amounts at random from 1500 to 5499 cents, for 200
//   days; 5000 trials per spacing (mulberry32, seed 20261026). Each figure
//   is the trials that listed any subscription, by the all-history rule
//   alone (main before #391) and by this module:
//
//     visit spacing           all-history rule   with lanes
//     every 1 to 5 days            0 / 5000          0 / 5000
//     every 5 to 10 days          37 / 5000        121 / 5000
//     every 10 to 20 days          0 / 5000        641 / 5000
//     every 20 to 40 days         27 / 5000        637 / 5000
//     every 25 to 35 days       1495 / 5000       2660 / 5000
//
//   Batches of 500 from the same run vary: for every 10 to 20 days, from
//   49 to 79 with lanes.
//
// - A moved billing day or a skipped month starts a new lane under a new
//   key. If the lane holding the bare key moves, its run after the move is
//   listed under a lane key, so a sole subscription can show under a lane
//   key; if the old run was marked, it stays listed beside the new one
//   until she unmarks it.
// - The bare key can sit on a stopped, unpinned lane that is not listed, so
//   no listed row carries it and the screen cannot dismiss the whole
//   merchant from a row (#400).
// - Two lanes billed within a few days of each other at near-equal prices
//   can swap charges, and so their rows and marks; a moved billing day
//   beside a sibling can do the same.
// - A cancel date on the bare key can make the all-history rule detect the
//   merchant (the charges up to that date alone fit one band). Lanes are
//   then not read: the merchant is one row under its bare key with all its
//   charges, its other lanes' rows go, and a mark on a lane key is neither
//   listed nor writable.
// - The wait for a nearer charge looks ahead within a band, so a new charge
//   can still change how the latest charges were dealt, and the overlap
//   rules change as lanes form: an unmarked young or stopped row can drop
//   off, come back, or take a new key while a sibling forms. A pinned row
//   never drops off, except on a merchant that is never split (Keys,
//   above) or one a cancel date makes detected (above). A charge back-dated
//   into history (a late sync) can change how every later charge was dealt.
// - A merchant with more than `LANE_MAX_CONCURRENT` subscriptions at once is
//   never split.
//
// Known limits of both rules: a weekly merchant with one skipped week is
// not detected; and a subscription with no recent charge stays active until
// she cancels it, because liveness is measured from the merchant's own
// latest charge, never from today.
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

// ---------------------------------------------------------------------------
// Constants (prd-02 Ruling 16)
// ---------------------------------------------------------------------------

/**
 * The cadences a lane can have. Weekly is left out on purpose: it stays on
 * the all-history rule (#393).
 */
export const LANE_CADENCES: readonly SubscriptionCadence[] = [
  'monthly',
  'yearly',
]

/**
 * Most days between a lane's shortest and longest gap, the new gap
 * included: a lane's gaps stay this close, so a sibling's charge a few days
 * off its rhythm cannot join it.
 */
export const LANE_MAX_GAP_SPREAD_DAYS = 5

/**
 * Most days a charge may land from the lane's expected billing day (its
 * anchor day, next month or next year) and still join it.
 */
export const LANE_MAX_DEVIATION_DAYS = 3

/**
 * Days off the expected billing day that rank as on it when several
 * charges or lanes compete; past this, the nearer one wins first.
 */
export const LANE_DEVIATION_SLACK_DAYS = 2

/**
 * Fewest charges a monthly lane needs to be clear once any two formed lanes
 * of its merchant have overlapped in time.
 */
export const LANE_MIN_CHARGES_SHARED = 4

/**
 * Most formed lanes of one merchant whose spans may hold one date. More,
 * ever, and no lane of that merchant is clear: it is too dense to split.
 */
export const LANE_MAX_CONCURRENT = 3

/** Joins a lane key's bare key to the lane's first charge. */
export const LANE_KEY_SEPARATOR = '#'

/**
 * Characters a lane key may add to its bare key: the separator, a
 * `YYYY-MM-DD` date, `:`, the cents of any safe integer, and a `.<n>` tie
 * suffix. A merchant whose bare key leaves less room is never split.
 */
export const LANE_KEY_HEADROOM = 40

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
  const cut = normalised.slice(0, MAX_MERCHANT_KEY_LENGTH - 2)
  // Never cut between the halves of a surrogate pair (a letter beyond U+FFFF):
  // SQLite stores a lone half as U+FFFD, so the stored key would match nothing.
  return `d:${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}`
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

function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A settled outflow in the view's scope (any scope for `all`). */
function isCharge(tx: SubscriptionTransaction, scope: Scope): boolean {
  return (
    tx.status === 'settled' &&
    tx.amountCents < 0 &&
    (scope === 'all' || tx.scope === scope)
  )
}

/** The listing of `charges` (oldest first) under `merchantKey`. */
function merchantOf(
  scope: RowScope,
  merchantKey: string,
  charges: readonly Charge[],
): SubscriptionMerchant {
  const latest = charges[charges.length - 1]
  return {
    merchantKey,
    scope,
    name: displayName(latest.tx),
    chargeCount: charges.length,
    lastChargedOn: latest.tx.date,
    amountCents: latest.amountCents,
  }
}

/** A subscription row for `merchant`, whose charges fell on `dates`. */
function subscriptionRow(
  merchant: SubscriptionMerchant,
  dates: readonly IsoDate[],
  cadence: SubscriptionCadence | null,
  detected: boolean,
  marked: boolean,
  cancelledOn: IsoDate | null,
): SubscriptionRow {
  const chargedAgainOn =
    cancelledOn === null ? null : (dates.find((d) => d > cancelledOn) ?? null)
  const perMonth =
    cadence === null ? null : perMonthCents(cadence, merchant.amountCents)
  const perYear = perMonth === null ? null : MONTHS_PER_YEAR * perMonth
  if (perYear !== null) assertCents(perYear, 'perYearCents')
  return {
    ...merchant,
    cadence,
    detected,
    marked,
    status:
      cancelledOn !== null && chargedAgainOn === null ? 'cancelled' : 'active',
    cancelledOn,
    chargedAgainOn,
    perMonthCents: perMonth,
    perYearCents: perYear,
  }
}

// ---------------------------------------------------------------------------
// Lanes (prd-02 Ruling 16)
// ---------------------------------------------------------------------------

/** A lane while charges are dealt to it, oldest first. */
interface GrowingLane {
  /** Null until its second charge sets it. */
  cadence: SubscriptionCadence | null
  /** Positions in the lane-ordered charges, ascending. */
  members: number[]
  /** Its shortest and longest gap; read only once it has two charges. */
  minGap: number
  maxGap: number
  /** The latest day of the month among its charges. */
  anchorDay: number
}

/** A lane of at least `MIN_CHARGES` charges: a formed lane. */
interface FormedLane {
  cadence: SubscriptionCadence
  /** Positions in the lane-ordered charges, ascending. */
  members: number[]
  /** It passes the noise guard and the overlap rules (see the header). */
  clear: boolean
}

/** A formed lane with the key it is listed and marked under. */
interface KeyedLane extends FormedLane {
  merchantKey: string
  /** Clear and live: listed with no mark. */
  detected: boolean
}

/** One charge a lane could take on the date being dealt. */
interface Offer {
  lane: number
  charge: number
  /** Days past `LANE_DEVIATION_SLACK_DAYS` off the expected billing day. */
  lateness: number
  /** The lane already has two charges or more. */
  established: boolean
  centsApart: number
  sameName: boolean
}

function bandOf(cadence: SubscriptionCadence): { lo: number; hi: number } {
  const band = CADENCE_BANDS.find((b) => b.cadence === cadence)
  if (band === undefined) throw new RangeError(`no band for ${cadence}`)
  return {
    lo: band.days - band.toleranceDays,
    hi: band.days + band.toleranceDays,
  }
}

/** The lane cadence whose band holds `gap`, or null. */
function laneCadenceOf(gap: number): SubscriptionCadence | null {
  for (const cadence of LANE_CADENCES) {
    const { lo, hi } = bandOf(cadence)
    if (gap >= lo && gap <= hi) return cadence
  }
  return null
}

function dayOfMonth(date: IsoDate): number {
  return Number(date.slice(8, 10))
}

/**
 * Days from `last` to the lane's next billing day: `anchorDay` in the next
 * month (monthly) or in the same month a year on (yearly), cut to that
 * month's last day, so a month-end biller is expected on its last day.
 */
function expectedGap(
  last: IsoDate,
  anchorDay: number,
  cadence: SubscriptionCadence,
): number {
  if (cadence === 'weekly') {
    throw new RangeError('a weekly lane is never dealt (#393)')
  }
  const step = cadence === 'yearly' ? MONTHS_PER_YEAR : 1
  const index =
    Number(last.slice(0, 4)) * MONTHS_PER_YEAR +
    (Number(last.slice(5, 7)) - 1) +
    step
  const year = (index - (index % MONTHS_PER_YEAR)) / MONTHS_PER_YEAR
  const month = (index % MONTHS_PER_YEAR) + 1
  const day = Math.min(anchorDay, daysInMonth(year, month))
  const pad = (n: number, width: number) => String(n).padStart(width, '0')
  return daysBetween(last, `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`)
}

/**
 * The charges dated `start` to `end` (one date) that `lane` may take, or
 * none. See the header for each test; `days` holds each charge's date as
 * days from the first.
 */
function offersFrom(
  charges: readonly Charge[],
  days: readonly number[],
  lane: GrowingLane,
  laneAt: number,
  start: number,
  end: number,
): Offer[] {
  const lastAt = lane.members[lane.members.length - 1]
  const last = charges[lastAt]
  const gap = days[start] - days[lastAt]
  const cadence = laneCadenceOf(gap)
  if (cadence === null) return []
  if (lane.cadence !== null && lane.cadence !== cadence) return []
  if (
    lane.members.length > 1 &&
    Math.max(lane.maxGap, gap) - Math.min(lane.minGap, gap) >
      LANE_MAX_GAP_SPREAD_DAYS
  ) {
    return []
  }
  const expected = expectedGap(last.tx.date, lane.anchorDay, cadence)
  const off = Math.abs(gap - expected)
  if (off > LANE_MAX_DEVIATION_DAYS) return []

  // Wait for a later charge nearer the expected day and no further in
  // cents, so a lane does not take a sibling's charge that comes first.
  const centsApart = (at: number) =>
    Math.abs(charges[at].amountCents - last.amountCents)
  let nearest = centsApart(start)
  for (let at = start + 1; at < end; at++)
    nearest = Math.min(nearest, centsApart(at))
  const { lo, hi } = bandOf(cadence)
  for (let at = end; at < charges.length; at++) {
    const later = days[at] - days[lastAt]
    if (later > hi) break
    if (
      later >= lo &&
      Math.abs(later - expected) < off &&
      centsApart(at) <= nearest
    ) {
      return []
    }
  }

  const offers: Offer[] = []
  for (let at = start; at < end; at++) {
    offers.push({
      lane: laneAt,
      charge: at,
      lateness: Math.max(0, off - LANE_DEVIATION_SLACK_DAYS),
      established: lane.members.length > 1,
      centsApart: centsApart(at),
      sameName: displayName(charges[at].tx) === displayName(last.tx),
    })
  }
  return offers
}

function byOffer(a: Offer, b: Offer): number {
  return (
    a.lateness - b.lateness ||
    Number(b.established) - Number(a.established) ||
    a.centsApart - b.centsApart ||
    Number(b.sameName) - Number(a.sameName) ||
    a.lane - b.lane ||
    a.charge - b.charge
  )
}

/**
 * Deals the charges (in lane order) to lanes one date at a time, oldest
 * first. Each charge joins at most one lane that existed before its date,
 * each lane takes at most one charge a date, and a charge no lane takes
 * starts a lane of its own. Nothing dealt is ever taken back by a later
 * date, except through the wait for a nearer charge (see the header).
 */
function growLanes(
  charges: readonly Charge[],
  days: readonly number[],
): GrowingLane[] {
  const lanes: GrowingLane[] = []
  // A lane whose last charge is past every band's high edge never grows.
  let reach = 0
  for (const cadence of LANE_CADENCES)
    reach = Math.max(reach, bandOf(cadence).hi)
  let open: number[] = []
  let start = 0
  while (start < charges.length) {
    let end = start + 1
    while (end < charges.length && days[end] === days[start]) end++
    open = open.filter(
      (k) =>
        days[start] - days[lanes[k].members[lanes[k].members.length - 1]] <=
        reach,
    )
    const offers: Offer[] = []
    for (const k of open)
      offers.push(...offersFrom(charges, days, lanes[k], k, start, end))
    offers.sort(byOffer)
    const laneTaken = new Set<number>()
    const chargeTaken = new Set<number>()
    for (const offer of offers) {
      if (laneTaken.has(offer.lane) || chargeTaken.has(offer.charge)) continue
      const lane = lanes[offer.lane]
      const gap =
        days[offer.charge] - days[lane.members[lane.members.length - 1]]
      lane.cadence = laneCadenceOf(gap)
      lane.minGap = lane.members.length > 1 ? Math.min(lane.minGap, gap) : gap
      lane.maxGap = lane.members.length > 1 ? Math.max(lane.maxGap, gap) : gap
      lane.members.push(offer.charge)
      lane.anchorDay = Math.max(
        lane.anchorDay,
        dayOfMonth(charges[offer.charge].tx.date),
      )
      laneTaken.add(offer.lane)
      chargeTaken.add(offer.charge)
    }
    for (let at = start; at < end; at++) {
      if (chargeTaken.has(at)) continue
      open.push(lanes.length)
      lanes.push({
        cadence: null,
        members: [at],
        minGap: 0,
        maxGap: 0,
        anchorDay: dayOfMonth(charges[at].tx.date),
      })
    }
    start = end
  }
  return lanes
}

/**
 * The formed lanes, in the order they formed: by the date of their
 * `MIN_CHARGES`-th charge, then their first charge, then lane order. A
 * later charge only appends to this order. `clear` is worked out here and
 * never moves a key (see the header).
 */
function formedLanes(
  charges: readonly Charge[],
  days: readonly number[],
): FormedLane[] {
  const formed: { cadence: SubscriptionCadence; members: number[] }[] = []
  for (const lane of growLanes(charges, days)) {
    if (lane.cadence !== null && lane.members.length >= MIN_CHARGES)
      formed.push({ cadence: lane.cadence, members: lane.members })
  }
  const inFormed = new Set(formed.flatMap((lane) => lane.members))
  const first = (lane: { members: number[] }) => days[lane.members[0]]
  const last = (lane: { members: number[] }) =>
    days[lane.members[lane.members.length - 1]]

  // The most formed lanes whose spans hold one charge's date, over all time.
  let overlap = 0
  for (const day of days) {
    let holding = 0
    for (const lane of formed)
      if (first(lane) <= day && day <= last(lane)) holding++
    overlap = Math.max(overlap, holding)
  }

  const formedOn = (lane: { members: number[] }) =>
    days[lane.members[MIN_CHARGES - 1]]
  return formed
    .map((lane) => {
      let strays = 0
      for (let at = 0; at < charges.length; at++) {
        if (inFormed.has(at)) continue
        if (first(lane) <= days[at] && days[at] <= last(lane)) strays++
      }
      // The noise guard: at most one stray for every two of its own.
      const clear =
        2 * strays <= lane.members.length &&
        overlap <= LANE_MAX_CONCURRENT &&
        (overlap < 2 ||
          lane.cadence !== 'monthly' ||
          lane.members.length >= LANE_MIN_CHARGES_SHARED)
      return { ...lane, clear }
    })
    .sort(
      (a, b) =>
        formedOn(a) - formedOn(b) ||
        first(a) - first(b) ||
        a.members[0] - b.members[0],
    )
}

/** The lane key built from a lane's first charge (see the header). */
function laneKey(bareKey: string, first: Charge): string {
  return `${bareKey}${LANE_KEY_SEPARATOR}${first.tx.date}:${first.amountCents}`
}

/**
 * One charge before another in lane order: by date, then cents, then name,
 * then input order. Charges on one date are dealt in this order, so the
 * order the rows arrive in on one date never changes a lane.
 */
function inLaneOrder(a: Charge, b: Charge): number {
  const byDate = compareDates(a.tx.date, b.tx.date)
  if (byDate !== 0) return byDate
  if (a.amountCents !== b.amountCents) return a.amountCents - b.amountCents
  const an = displayName(a.tx)
  const bn = displayName(b.tx)
  return an < bn ? -1 : an > bn ? 1 : 0
}

/**
 * The lanes to list, each with its key, or null when there is none to list
 * or the merchant may not be split. `charges` are in lane order.
 * `isBareKey` says whether a key is some merchant's bare key in this scope;
 * `pinned` whether Hannah has marked a key (an answer or a cancel date).
 */
function listedLanes(
  bareKey: string,
  charges: readonly Charge[],
  isBareKey: (key: string) => boolean,
  pinned: (key: string) => boolean,
): KeyedLane[] | null {
  if (charges.length < MIN_CHARGES) return null
  const days = charges.map((c) => daysBetween(charges[0].tx.date, c.tx.date))
  const formed = formedLanes(charges, days)
  if (formed.length === 0) return null
  if (
    formed.length > 1 &&
    (bareKey.includes(LANE_KEY_SEPARATOR) ||
      bareKey.length + LANE_KEY_HEADROOM > MAX_MERCHANT_KEY_LENGTH)
  ) {
    return null
  }
  const latest = days[days.length - 1]
  const seen = new Map<string, number>()
  const keyed: KeyedLane[] = formed.map((lane, k) => {
    const live =
      latest - days[lane.members[lane.members.length - 1]] <=
      bandOf(lane.cadence).hi
    const detected = lane.clear && live
    if (k === 0) return { ...lane, merchantKey: bareKey, detected }
    const built = laneKey(bareKey, charges[lane.members[0]])
    const n = (seen.get(built) ?? 0) + 1
    seen.set(built, n)
    const merchantKey = n === 1 ? built : `${built}.${n}`
    return { ...lane, merchantKey, detected }
  })
  if (
    keyed.some(
      (lane, k) =>
        k > 0 &&
        (!isMerchantKey(lane.merchantKey) || isBareKey(lane.merchantKey)),
    )
  ) {
    return null
  }
  const listed = keyed.filter(
    (lane) => lane.detected || pinned(lane.merchantKey),
  )
  return listed.length === 0 ? null : listed
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
    if (!isCharge(tx, scope)) continue
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
      compareDates(a.tx.date, b.tx.date),
    )
    const dates = charges.map((c) => c.tx.date)
    const merchant = merchantOf(group.scope, group.merchantKey, charges)

    const mark = marks.get(key)
    const answer = mark?.answer ?? null
    const cancelledOn = mark?.cancelledOn ?? null
    // With a cancel date, the charges up to it can stand for the merchant
    // when all of them cannot: a charge-again off the cadence must not hide
    // the row (see the header).
    const upToCancel =
      cancelledOn === null ? [] : dates.filter((d) => d <= cancelledOn)
    const cadenceAll = classifyGaps(dates)
    const cadenceUpToCancel = classifyGaps(upToCancel)
    const cadence = cadenceAll ?? cadenceUpToCancel
    const detected =
      (dates.length >= MIN_CHARGES && cadenceAll !== null) ||
      (upToCancel.length >= MIN_CHARGES && cadenceUpToCancel !== null)

    if (answer === 'not_subscription') {
      // On the bare key this hides every lane too (prd-02 Ruling 16).
      notSubscriptions.push(merchant)
      continue
    }

    // What the all-history rule misses is read again as lanes (Ruling 16),
    // over the charges in lane order.
    const laneOrdered = detected ? [] : [...charges].sort(inLaneOrder)
    const lanes = detected
      ? null
      : listedLanes(
          group.merchantKey,
          laneOrdered,
          (k) => groups.has(groupKey(group.scope, k)),
          (k) => {
            const pin = marks.get(groupKey(group.scope, k))
            return (
              pin !== undefined &&
              (pin.answer !== null || pin.cancelledOn !== null)
            )
          },
        )
    if (lanes !== null) {
      for (const lane of lanes) {
        const laneCharges = lane.members.map((at) => laneOrdered[at])
        const laneMerchant = merchantOf(
          group.scope,
          lane.merchantKey,
          laneCharges,
        )
        const laneMark = marks.get(groupKey(group.scope, lane.merchantKey))
        if (laneMark?.answer === 'not_subscription') {
          notSubscriptions.push(laneMerchant)
        } else {
          rows.push(
            subscriptionRow(
              laneMerchant,
              laneCharges.map((c) => c.tx.date),
              lane.cadence,
              lane.detected,
              laneMark?.answer === 'subscription',
              laneMark?.cancelledOn ?? null,
            ),
          )
        }
      }
    } else if (answer === 'subscription' || detected) {
      rows.push(
        subscriptionRow(
          merchant,
          dates,
          cadence,
          detected,
          answer === 'subscription',
          cancelledOn,
        ),
      )
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

/**
 * Every merchant key a write may name in `scope` now: the bare key of every
 * charge there, and every lane key `subscriptions` lists there (prd-02
 * Ruling 16), pinned ones included. A lane hidden by `not_subscription` on
 * its bare key, or one not listed (stale or not clear, with no answer or
 * cancel date on its key), is not in it. Sorted, no repeats. Throws as
 * `subscriptions` does.
 */
export function chargeKeys(input: {
  scope: RowScope
  transactions: readonly SubscriptionTransaction[]
  marks: readonly SubscriptionMark[]
}): string[] {
  if (!isRowScope(input.scope)) {
    throw new RangeError(
      `scope must be personal or strawb, got "${String(input.scope)}"`,
    )
  }
  const listed = subscriptions(input)
  const keys = new Set<string>()
  for (const tx of input.transactions) {
    if (!isCharge(tx, input.scope)) continue
    const key = merchantKeyOf(tx)
    if (key !== null) keys.add(key)
  }
  for (const merchant of [
    ...listed.subscriptions,
    ...listed.questions,
    ...listed.notSubscriptions,
  ]) {
    keys.add(merchant.merchantKey)
  }
  return [...keys].sort()
}

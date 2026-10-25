// The insights agent's typed aggregate queries (prd-04 Ruling 3, Ruling 7;
// #47). Ruling 7: the agent makes no model call, so every insight is these
// fixed queries, folded in code and filled into a template (./prompt.ts).
//
// One read reaches the database, `loadLedger`, and it reads only settled
// Akahu rows on stored Akahu accounts of one scope. It never selects a
// transaction's id, description, reference, particulars or code, so nothing
// an insight says can carry them. Everything after it is a pure fold over
// the loaded rows, which the tests check against a hand-written query.
//
// Days are Pacific/Auckland calendar days (YYYY-MM-DD), bucketed here in JS:
// SQL date functions would need raw SQL, which nothing under server/agents/
// may use. The NZ date code mirrors server/db/overview.ts rather than
// importing it, because that module writes.
//
// Money is integer cents. Spend is an outflow's amount made positive;
// inflows are never netted against spend. Totals go through `sumCents`, and
// nothing here divides cents.
//
// Merchant and category text is untrusted (Ruling 8): it is cleaned once, at
// load, by `cleanLabel`, and only cleaned labels leave this module. Errors
// name the field, never its value.
import type { InsightScope } from '../../../models/insights.ts'
import { sumCents } from '../../../shared/money.ts'
import connection from '../../db/connection.ts'

/** A Pacific/Auckland calendar date, `YYYY-MM-DD`. */
export type IsoDate = string

export interface LedgerRow {
  // The NZ calendar day of the transaction.
  date: IsoDate
  accountId: string
  // Signed: an outflow is negative.
  amountCents: number
  // Cleaned; "Uncategorised" when the row has none.
  category: string
  // Cleaned; "Unknown merchant" when the row has none.
  merchant: string
}

// Two legs of a transfer between the scope's own accounts may post on
// different days; legs further apart than this are not paired.
export const TRANSFER_WINDOW_DAYS = 2
export const UNUSUAL_LOOKBACK_WEEKS = 8
export const UNUSUAL_MIN_HISTORY = 3
export const UNUSUAL_FLOOR_CENTS = 5000
export const UNUSUAL_MULTIPLE = 3
export const UNUSUAL_LIMIT = 5
export const TOP_MERCHANTS_LIMIT = 5
export const MONTHLY_MONTHS = 6
// Categories outside the top ones are summed into OTHER_CATEGORIES per month.
export const MONTHLY_TOP_CATEGORIES = 6
export const LABEL_MAX_CODE_POINTS = 40

export const UNKNOWN_MERCHANT = 'Unknown merchant'
export const UNCATEGORISED = 'Uncategorised'
export const OTHER_CATEGORIES = 'Other categories'

const SCOPES: Record<InsightScope, true> = { personal: true, strawb: true }

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// Built once. `formatToParts` is read field by field rather than trusting a
// locale's string order (as server/db/overview.ts does).
const NZ_DATE = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The calendar date `at` falls on in Pacific/Auckland, as `YYYY-MM-DD`. */
export function nzCalendarDate(at: Date): IsoDate {
  if (Number.isNaN(at.getTime())) {
    throw new RangeError('date is not a valid instant')
  }
  let year = ''
  let month = ''
  let day = ''
  for (const part of NZ_DATE.formatToParts(at)) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year.padStart(4, '0')}-${month}-${day}`
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

interface CivilDate {
  year: number
  month: number // 1 to 12
  day: number
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month, 0)
  return d.getUTCDate()
}

function parseIsoDate(value: IsoDate): CivilDate {
  const match = ISO_DATE.exec(value)
  if (match) {
    const [, y, m, d] = match
    const year = Number(y)
    const month = Number(m)
    const day = Number(d)
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) {
      return { year, month, day }
    }
  }
  throw new RangeError('date must be a YYYY-MM-DD calendar date')
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function formatIsoDate({ year, month, day }: CivilDate): IsoDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

// UTC midnight of the civil date. Built with `setUTCFullYear`, never
// `Date.UTC`, which reads the years 0 to 99 as 1900 to 1999.
function civilInstant(date: IsoDate): Date {
  const { year, month, day } = parseIsoDate(date)
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  return d
}

// Whole days since 1970-01-01; differences of these are day counts.
function dayIndex(date: IsoDate): number {
  return Math.round(civilInstant(date).getTime() / MS_PER_DAY)
}

function addDays(date: IsoDate, days: number): IsoDate {
  const d = civilInstant(date)
  d.setUTCDate(d.getUTCDate() + days)
  return formatIsoDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() })
}

// 1 for Monday to 7 for Sunday.
function isoWeekday(date: IsoDate): number {
  return ((civilInstant(date).getUTCDay() + 6) % 7) + 1
}

/** The ISO-8601 week a date falls in, e.g. "2026-W43" (the week's Thursday names the year). */
export function isoWeekOf(date: IsoDate): string {
  const thursday = addDays(date, 4 - isoWeekday(date))
  const { year } = parseIsoDate(thursday)
  const week = Math.floor((dayIndex(thursday) - dayIndex(`${pad(year, 4)}-01-01`)) / 7) + 1
  return `${pad(year, 4)}-W${pad(week, 2)}`
}

const WEEK_LABEL = /^(\d{4})-W(\d{2})$/

export interface WeekRange {
  label: string
  // Monday.
  start: IsoDate
  // Sunday.
  end: IsoDate
}

/** The Monday and Sunday of an ISO week label. Throws on a label that names no week. */
export function weekRange(label: string): WeekRange {
  const refused = new RangeError('period must be an ISO week label (YYYY-Www)')
  const match = typeof label === 'string' ? WEEK_LABEL.exec(label) : null
  if (!match) throw refused
  const [, y, w] = match
  const week = Number(w)
  if (week < 1) throw refused
  const jan4 = `${y}-01-04`
  const firstMonday = addDays(jan4, 1 - isoWeekday(jan4))
  const start = addDays(firstMonday, 7 * (week - 1))
  // Week 53 exists only in some years; a label past the year's last week
  // round-trips to the next year's week and is refused.
  if (isoWeekOf(start) !== label) throw refused
  return { label, start, end: addDays(start, 6) }
}

/** The last full Monday-to-Sunday NZ week strictly before the NZ week `now` falls in. */
export function lastCompleteWeek(now: Date): string {
  const today = nzCalendarDate(now)
  const thisMonday = addDays(today, 1 - isoWeekday(today))
  return isoWeekOf(addDays(thisMonday, -7))
}

/** The `n` calendar months ending with the one `end` falls in, ascending, as `YYYY-MM`. */
export function monthsEnding(end: IsoDate, n: number = MONTHLY_MONTHS): string[] {
  const { year, month } = parseIsoDate(end)
  const last = year * 12 + (month - 1)
  const months: string[] = []
  for (let index = last - n + 1; index <= last; index += 1) {
    months.push(`${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1, 2)}`)
  }
  return months
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// Letters, digits, the ASCII space and a few marks merchant names use. Every
// other character becomes a space: `:` and `/` (so no URL scheme or path
// survives), `<` `>` `\` and the backtick (no markup and no way out of a
// markdown code span), brackets, `*` `|` `~` `!`, and every control, format
// and bidi character.
const LABEL_CHAR = /[\p{L}\p{N} &'.,\-+()#@%_]/u

/**
 * Merchant or category text made safe to show: NFKC-folded first (so a
 * full-width colon is a colon before it is dropped), disallowed characters
 * replaced by spaces, whitespace collapsed, and cut to a maximum number of
 * code points without splitting a surrogate pair. Empty after that, it is
 * `fallback`.
 */
export function cleanLabel(text: string | null, fallback: string): string {
  if (typeof text !== 'string') return fallback
  let kept = ''
  for (const char of text.normalize('NFKC')) kept += LABEL_CHAR.test(char) ? char : ' '
  const collapsed = kept.replace(/\s+/g, ' ').trim()
  const cut = Array.from(collapsed).slice(0, LABEL_MAX_CODE_POINTS).join('').trim()
  return cut === '' ? fallback : cut
}

// ---------------------------------------------------------------------------
// The one read
// ---------------------------------------------------------------------------

interface StoredRow {
  account_id: string
  date: string
  amount_cents: number
  category: string | null
  merchant_name: string | null
}

/**
 * Settled Akahu transactions on the scope's stored Akahu accounts whose NZ
 * day is `from` to `to` inclusive. A row with no date, an unparseable date
 * or a non-integer amount is dropped.
 */
export async function loadLedger(
  scope: InsightScope,
  from: IsoDate,
  to: IsoDate,
  db = connection,
): Promise<LedgerRow[]> {
  if (typeof scope !== 'string' || !Object.prototype.hasOwnProperty.call(SCOPES, scope)) {
    throw new Error('scope must be personal or strawb')
  }
  // `date` is stored as UTC ISO-8601 text. The SQL bounds are whole UTC
  // days padded past the NZ offset either way; the exact NZ day is applied
  // below, after conversion.
  const lowerDay = addDays(from, -1)
  const upperDay = addDays(to, 2)
  const stored: StoredRow[] = await db('transactions as t')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'a.scope': scope, 'a.source': 'akahu', 't.source': 'akahu', 't.status': 'settled' })
    .whereNotNull('t.date')
    .whereNotNull('t.amount_cents')
    .where('t.date', '>=', lowerDay)
    .where('t.date', '<', upperDay)
    .select('t.account_id', 't.date', 't.amount_cents', 't.category', 't.merchant_name')

  const rows: LedgerRow[] = []
  for (const row of stored) {
    const at = new Date(row.date)
    if (Number.isNaN(at.getTime()) || !Number.isSafeInteger(row.amount_cents)) continue
    const date = nzCalendarDate(at)
    if (date < from || date > to) continue
    rows.push({
      date,
      accountId: row.account_id,
      amountCents: row.amount_cents,
      category: cleanLabel(row.category, UNCATEGORISED),
      merchant: cleanLabel(row.merchant_name, UNKNOWN_MERCHANT),
    })
  }
  return rows.sort(
    (a, b) =>
      compareText(a.date, b.date) ||
      compareText(a.accountId, b.accountId) ||
      a.amountCents - b.amountCents ||
      compareText(a.merchant, b.merchant),
  )
}

// ---------------------------------------------------------------------------
// Pure folds
// ---------------------------------------------------------------------------

// Code-unit order: the same on every machine, unlike `localeCompare`.
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function inRange(row: LedgerRow, start: IsoDate, end: IsoDate): boolean {
  return row.date >= start && row.date <= end
}

// Positive spend of an outflow in range; undefined for inflows and others.
function spendIn(row: LedgerRow, start: IsoDate, end: IsoDate): number | undefined {
  return row.amountCents < 0 && inRange(row, start, end) ? -row.amountCents : undefined
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * Drops transfers between the scope's own accounts. An outflow pairs with an
 * unpaired inflow of the same absolute cents on a different account no more
 * than TRANSFER_WINDOW_DAYS apart, the nearest first, a tie going to the
 * earlier inflow (then the lower account id). Each leg pairs at most once,
 * and both legs of a pair are dropped. Only the rows given are seen, so a
 * leg in another scope (an owner's drawings) is never paired (#264).
 */
export function excludeTransfers(rows: readonly LedgerRow[]): LedgerRow[] {
  const inflows = new Map<number, LedgerRow[]>()
  const byDateThenAccount = (a: LedgerRow, b: LedgerRow) =>
    compareText(a.date, b.date) ||
    compareText(a.accountId, b.accountId) ||
    compareText(a.merchant, b.merchant)
  for (const row of rows.filter((r) => r.amountCents > 0).sort(byDateThenAccount)) {
    const list = inflows.get(row.amountCents)
    if (list) list.push(row)
    else inflows.set(row.amountCents, [row])
  }
  const outflows = rows
    .filter((r) => r.amountCents < 0)
    .sort(
      (a, b) =>
        compareText(a.date, b.date) ||
        a.amountCents - b.amountCents ||
        compareText(a.merchant, b.merchant) ||
        compareText(a.accountId, b.accountId),
    )

  const paired = new Set<LedgerRow>()
  for (const out of outflows) {
    const day = dayIndex(out.date)
    let best: LedgerRow | undefined
    let bestGap = Infinity
    // Candidates are in date-then-account order, so a strict `<` keeps the
    // earlier of two equally near inflows.
    for (const inflow of inflows.get(-out.amountCents) ?? []) {
      if (paired.has(inflow) || inflow.accountId === out.accountId) continue
      const gap = Math.abs(dayIndex(inflow.date) - day)
      if (gap <= TRANSFER_WINDOW_DAYS && gap < bestGap) {
        best = inflow
        bestGap = gap
      }
    }
    if (best) {
      paired.add(out)
      paired.add(best)
    }
  }
  return rows.filter((r) => !paired.has(r))
}

export interface MonthlyCell {
  // YYYY-MM.
  month: string
  category: string
  spendCents: number
}

/**
 * Spend per category per month, for the months given. The `keep` categories
 * with the most spend over all those months are shown by name; the rest are
 * summed per month into OTHER_CATEGORIES (a category already called that
 * joins the sum). Only cells with spend appear: months ascending, then spend
 * descending, then category, with OTHER_CATEGORIES last in its month.
 */
export function spendByCategoryPerMonth(
  rows: readonly LedgerRow[],
  months: readonly string[],
  keep: number = MONTHLY_TOP_CATEGORIES,
): MonthlyCell[] {
  const wanted = new Set(months)
  const totals = new Map<string, number[]>()
  const cells = new Map<string, Map<string, number[]>>()
  for (const row of rows) {
    const month = row.date.slice(0, 7)
    if (row.amountCents >= 0 || !wanted.has(month)) continue
    const spend = -row.amountCents
    push(totals, row.category, spend)
    const byCategory = cells.get(month) ?? new Map<string, number[]>()
    push(byCategory, row.category, spend)
    cells.set(month, byCategory)
  }

  const shown = new Set(
    [...totals]
      .filter(([category]) => category !== OTHER_CATEGORIES)
      .map(([category, values]) => ({ category, spendCents: sumCents(values) }))
      .sort((a, b) => b.spendCents - a.spendCents || compareText(a.category, b.category))
      .slice(0, keep)
      .map((c) => c.category),
  )

  const out: MonthlyCell[] = []
  for (const month of [...wanted].sort(compareText)) {
    const byCategory = cells.get(month)
    if (!byCategory) continue
    const named: MonthlyCell[] = []
    const other: number[] = []
    for (const [category, values] of byCategory) {
      if (shown.has(category)) named.push({ month, category, spendCents: sumCents(values) })
      else other.push(...values)
    }
    named.sort((a, b) => b.spendCents - a.spendCents || compareText(a.category, b.category))
    out.push(...named)
    if (other.length > 0) out.push({ month, category: OTHER_CATEGORIES, spendCents: sumCents(other) })
  }
  return out
}

export interface MerchantSpend {
  merchant: string
  spendCents: number
  // Outflows that make up the spend.
  count: number
}

/** The merchants with the most spend in the week, spend descending then merchant. */
export function topMerchants(
  rows: readonly LedgerRow[],
  week: string,
  limit: number = TOP_MERCHANTS_LIMIT,
): MerchantSpend[] {
  const { start, end } = weekRange(week)
  const spends = new Map<string, number[]>()
  for (const row of rows) {
    const spend = spendIn(row, start, end)
    if (spend !== undefined) push(spends, row.merchant, spend)
  }
  return [...spends]
    .map(([merchant, values]) => ({ merchant, spendCents: sumCents(values), count: values.length }))
    .sort((a, b) => b.spendCents - a.spendCents || compareText(a.merchant, b.merchant))
    .slice(0, limit)
}

export interface CategoryChange {
  category: string
  thisCents: number
  lastCents: number
  // thisCents - lastCents: positive is more spend this week.
  changeCents: number
}

export interface WeekOverWeek {
  thisWeekCents: number
  lastWeekCents: number
  changeCents: number
  // Whole percent, rounded; null when last week had no spend. A display
  // figure only: it never goes into a chart spec.
  changePct: number | null
  // Every category with spend in either week, by size of change descending,
  // then category.
  byCategory: CategoryChange[]
}

/** Spend in the week against the week before it, in total and per category. */
export function weekOverWeek(rows: readonly LedgerRow[], week: string): WeekOverWeek {
  const current = weekRange(week)
  const previous = weekRange(isoWeekOf(addDays(current.start, -7)))
  const thisWeek = new Map<string, number[]>()
  const lastWeek = new Map<string, number[]>()
  for (const row of rows) {
    const nowSpend = spendIn(row, current.start, current.end)
    if (nowSpend !== undefined) push(thisWeek, row.category, nowSpend)
    const thenSpend = spendIn(row, previous.start, previous.end)
    if (thenSpend !== undefined) push(lastWeek, row.category, thenSpend)
  }

  const categories = new Set([...thisWeek.keys(), ...lastWeek.keys()])
  const byCategory = [...categories]
    .map((category) => {
      const thisCents = sumCents(thisWeek.get(category) ?? [])
      const lastCents = sumCents(lastWeek.get(category) ?? [])
      return { category, thisCents, lastCents, changeCents: thisCents - lastCents }
    })
    .sort(
      (a, b) =>
        Math.abs(b.changeCents) - Math.abs(a.changeCents) || compareText(a.category, b.category),
    )

  const thisWeekCents = sumCents(byCategory.map((c) => c.thisCents))
  const lastWeekCents = sumCents(byCategory.map((c) => c.lastCents))
  const changeCents = thisWeekCents - lastWeekCents
  return {
    thisWeekCents,
    lastWeekCents,
    changeCents,
    changePct: lastWeekCents === 0 ? null : Math.round((changeCents * 100) / lastWeekCents),
    byCategory,
  }
}

export interface UnusualSpend {
  date: IsoDate
  merchant: string
  category: string
  amountCents: number
  // The median of the merchant's earlier outflows (the lower middle one of
  // an even count).
  typicalCents: number
}

/**
 * Outflows in the week that are large for their merchant. A merchant needs
 * at least UNUSUAL_MIN_HISTORY outflows in the UNUSUAL_LOOKBACK_WEEKS weeks
 * before the week; an outflow is unusual when it is at least
 * UNUSUAL_FLOOR_CENTS and at least UNUSUAL_MULTIPLE times the median of
 * those. Amount descending, then merchant, then date; at most `limit`.
 */
export function unusualSpends(
  rows: readonly LedgerRow[],
  week: string,
  limit: number = UNUSUAL_LIMIT,
): UnusualSpend[] {
  const { start, end } = weekRange(week)
  const historyStart = addDays(start, -7 * UNUSUAL_LOOKBACK_WEEKS)
  const historyEnd = addDays(start, -1)
  const history = new Map<string, number[]>()
  for (const row of rows) {
    const spend = spendIn(row, historyStart, historyEnd)
    if (spend !== undefined) push(history, row.merchant, spend)
  }

  const typical = new Map<string, number>()
  for (const [merchant, values] of history) {
    if (values.length < UNUSUAL_MIN_HISTORY) continue
    const sorted = [...values].sort((a, b) => a - b)
    // An index into a count, not a division of cents.
    const middle = Math.floor((sorted.length - 1) / 2)
    const [median] = sorted.slice(middle, middle + 1)
    typical.set(merchant, median)
  }

  const found: UnusualSpend[] = []
  for (const row of rows) {
    const spend = spendIn(row, start, end)
    const typicalCents = typical.get(row.merchant)
    if (spend === undefined || typicalCents === undefined) continue
    if (spend >= UNUSUAL_FLOOR_CENTS && spend >= UNUSUAL_MULTIPLE * typicalCents) {
      found.push({ date: row.date, merchant: row.merchant, category: row.category, amountCents: spend, typicalCents })
    }
  }
  return found
    .sort(
      (a, b) =>
        b.amountCents - a.amountCents ||
        compareText(a.merchant, b.merchant) ||
        compareText(a.date, b.date),
    )
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Everything one run needs
// ---------------------------------------------------------------------------

/** The only input the template (./prompt.ts) accepts. */
export interface Aggregates {
  // The ISO week label the run covers.
  week: string
  // The months the monthly chart covers, ascending, ending with the month
  // the week's Sunday falls in.
  months: string[]
  // The week's Sunday: nothing after it is counted.
  asOf: IsoDate
  // Rows read for the analysis window, transfers included.
  ledgerRowCount: number
  topMerchants: MerchantSpend[]
  wow: WeekOverWeek
  unusual: UnusualSpend[]
  monthly: MonthlyCell[]
}

/**
 * Reads the scope's ledger once and folds it for one ISO week. The window
 * runs from the earlier of the first monthly month and the unusual-spend
 * lookback to the week's Sunday; it is read TRANSFER_WINDOW_DAYS wider on
 * both sides so a transfer whose other leg falls just outside still pairs.
 * Rows after the Sunday are otherwise ignored, so a week reads the same
 * whenever it is run, except for a transfer leg posted in those padding days.
 */
export async function collectAggregates(
  scope: InsightScope,
  weekLabel: string,
  db = connection,
): Promise<Aggregates> {
  const range = weekRange(weekLabel)
  const months = monthsEnding(range.end, MONTHLY_MONTHS)
  const [firstMonth] = months
  const monthStart = `${firstMonth}-01`
  const lookbackStart = addDays(range.start, -7 * UNUSUAL_LOOKBACK_WEEKS)
  const windowStart = monthStart < lookbackStart ? monthStart : lookbackStart

  const loaded = await loadLedger(
    scope,
    addDays(windowStart, -TRANSFER_WINDOW_DAYS),
    addDays(range.end, TRANSFER_WINDOW_DAYS),
    db,
  )
  const inWindow = (r: LedgerRow) => inRange(r, windowStart, range.end)
  const kept = excludeTransfers(loaded).filter(inWindow)

  return {
    week: range.label,
    months,
    asOf: range.end,
    ledgerRowCount: loaded.filter(inWindow).length,
    topMerchants: topMerchants(kept, range.label),
    wow: weekOverWeek(kept, range.label),
    unusual: unusualSpends(kept, range.label),
    monthly: spendByCategoryPerMonth(kept, months),
  }
}

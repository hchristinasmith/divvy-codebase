import type { BillRepeat } from '../../models/planning.ts'
import type {
  BillResponse,
  BillsResponse,
  IsoDate,
  IsoTimestamp,
  RowScope,
  Scope,
} from '../../shared/contracts.ts'
import { sumCents } from '../../shared/money.ts'
import {
  MAX_UNPAID_OCCURRENCES,
  billOccurrencesThrough,
  nzCalendarDate,
} from '../../shared/nz-dates.ts'
import { daysInMonth, nextPayday } from '../../shared/safe-to-spend.ts'
import connection from './connection.ts'
import { getSettings } from './settings.ts'

// The bills route's data module (prd-02, issue #49): the Bills screen's list,
// creating, editing and deleting a bill, and "Mark paid".
//
// Occurrences (#35 option C). Every occurrence is computed from the anchor
// (`first_due_date`) by `billOccurrencesThrough` in shared/nz-dates.ts, the
// same function the overview uses, so the two screens cannot disagree on
// which dates a bill falls due. A paid occurrence is one with a
// `bill_payments` row for its exact date, matched as overview's
// `loadInputs` matches it.
//
// A bill's current occurrence is the earliest one with no payment, whatever
// today is: a weekly bill two weeks behind shows the older week, and one
// paid ahead shows the first week not yet paid. A one-off is paid once its
// anchor has a payment, and then shows that payment.
//
// "Mark paid" always pays the current occurrence, however far ahead it is
// (Hannah, #49 decision 4). The one refusal is at the last date Divvy
// tracks, `FIRST_DUE_MAX`: past it, the list and the overview could no
// longer be computed, so the press is refused rather than stored. Payments
// are only ever appended; nothing here updates or deletes a payment row,
// except deleting a bill with none.
//
// Writes return a closed refusal code, never an HTTP status; the route
// maps each to its status and text. Errors the client may see are
// `BillsDataError`s with a fixed text; the shared modules' RangeError and
// TypeError, whose messages name values, never leave here as they are.

/**
 * A failure the route may name to the client: one of a closed set of
 * constant texts, so no id, stored value or SQL reaches a response.
 */
type BillsDataErrorMessage =
  | 'a stored bill is not valid'
  | 'bills input invalid'

export class BillsDataError extends Error {
  constructor(message: BillsDataErrorMessage) {
    super(message)
    this.name = 'BillsDataError'
  }
}

// What a bill may be: the most is $10,000,000.00.
const MAX_BILL_CENTS = 1_000_000_000
const MAX_NAME_LENGTH = 255
// The dates an anchor may take, and the last occurrence "Mark paid" stores.
// The upper bound keeps every horizon below inside the four-digit years
// `billOccurrencesThrough` can write.
const FIRST_DUE_MIN = '2000-01-01'
const FIRST_DUE_MAX = '2099-12-31'

type Db = typeof connection

/**
 * Runs a call into shared date or money code, turning its RangeError or
 * TypeError (whose messages name values) into the fixed text. A copy of
 * `guard` in ./overview.ts, which is private there, and copied again in
 * ./goals.ts; change all together.
 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new BillsDataError('bills input invalid')
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A bill as created: what POST /api/v1/bills checked and parsed. */
export interface NewBill {
  scope: RowScope
  name: string
  amountCents: number
  firstDueDate: IsoDate
  repeat: BillRepeat
  /** The `accounts.id` it is paid from, or null for none. */
  accountId: number | null
}

/** A PATCH: only the fields sent. */
export type BillChanges = Partial<NewBill>

/** One field's rule: the parsed value, or null if the sent value is refused. */
interface Rule<T> {
  parse(value: unknown): { value: T } | null
  error: string
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
// Digits only, no leading zero: Number() would also accept '1e3' and ' 7'.
const ROW_ID = /^[1-9]\d*$/

function isRealDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  )
}

const BILL_REPEATS: readonly BillRepeat[] = [
  'none',
  'weekly',
  'monthly',
  'yearly',
]

// No coercion anywhere: a numeric string, a float or null is refused where
// the field wants something else. No message echoes what was sent.
const RULES: { [K in keyof NewBill]: Rule<NewBill[K]> } = {
  scope: {
    parse: (v) => (v === 'personal' || v === 'strawb' ? { value: v } : null),
    error: 'scope must be personal or strawb',
  },
  name: {
    parse: (v) => {
      if (typeof v !== 'string') return null
      const name = v.trim()
      return name.length >= 1 && name.length <= MAX_NAME_LENGTH
        ? { value: name }
        : null
    },
    error: `name must be 1 to ${MAX_NAME_LENGTH} characters`,
  },
  amountCents: {
    parse: (v) =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v >= 1 &&
      v <= MAX_BILL_CENTS
        ? { value: v }
        : null,
    error: `amountCents must be a whole number of cents from 1 to ${MAX_BILL_CENTS}`,
  },
  firstDueDate: {
    // ISO dates compare correctly as strings.
    parse: (v) =>
      typeof v === 'string' &&
      isRealDate(v) &&
      v >= FIRST_DUE_MIN &&
      v <= FIRST_DUE_MAX
        ? { value: v }
        : null,
    error: `firstDueDate must be a YYYY-MM-DD date from ${FIRST_DUE_MIN} to ${FIRST_DUE_MAX}`,
  },
  repeat: {
    parse: (v) =>
      typeof v === 'string' && (BILL_REPEATS as readonly string[]).includes(v)
        ? { value: v as BillRepeat }
        : null,
    error: 'repeat must be none, weekly, monthly or yearly',
  },
  accountId: {
    // An id as the API sends ids, a string; a JSON number is refused.
    parse: (v) => {
      if (v === null) return { value: null }
      if (typeof v !== 'string' || !ROW_ID.test(v)) return null
      const id = Number(v)
      return Number.isSafeInteger(id) ? { value: id } : null
    },
    error: 'accountId must be an account id as a string, or null',
  },
}

// The order fields are checked in, whatever order the body sends them.
const FIELD_ORDER: readonly (keyof NewBill)[] = [
  'scope',
  'name',
  'amountCents',
  'firstDueDate',
  'repeat',
  'accountId',
]
const FIELD_SET: ReadonlySet<string> = new Set(FIELD_ORDER)

function hasOwn(body: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

// Parses `body[field]` into `out[field]`; false if the rule refuses it.
function accept<K extends keyof NewBill>(
  out: BillChanges,
  field: K,
  value: unknown,
): boolean {
  const rule: Rule<NewBill[K]> = RULES[field]
  const parsed = rule.parse(value)
  if (parsed === null) return false
  out[field] = parsed.value
  return true
}

// The checks both bodies share: a plain object with no unknown key, then
// each present field in `FIELD_ORDER`.
function validateFields(
  body: unknown,
  required: boolean,
): { fields: BillChanges } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Body must be a JSON object' }
  }
  if (Object.keys(body).some((key) => !FIELD_SET.has(key))) {
    return { error: 'Unknown field in body' }
  }
  const fields: BillChanges = {}
  for (const field of FIELD_ORDER) {
    if (!hasOwn(body, field)) {
      // `accountId` is the one optional field on create.
      if (required && field !== 'accountId') {
        return { error: RULES[field].error }
      }
      continue
    }
    const value: unknown = (body as Record<string, unknown>)[field]
    if (!accept(fields, field, value)) return { error: RULES[field].error }
  }
  return { fields }
}

/**
 * Checks a POST /api/v1/bills body. Every field but `accountId` is required;
 * an omitted `accountId` is null. The error is the first failure in
 * `FIELD_ORDER`, never in the body's key order.
 */
export function validateCreateBill(
  body: unknown,
): { bill: NewBill } | { error: string } {
  const result = validateFields(body, true)
  if ('error' in result) return result
  const { scope, name, amountCents, firstDueDate, repeat, accountId } =
    result.fields
  if (
    scope === undefined ||
    name === undefined ||
    amountCents === undefined ||
    firstDueDate === undefined ||
    repeat === undefined
  ) {
    // validateFields refused every missing required field already.
    throw new Error('a required bill field was not parsed')
  }
  return {
    bill: {
      scope,
      name,
      amountCents,
      firstDueDate,
      repeat,
      accountId: accountId ?? null,
    },
  }
}

/** Checks a PATCH /api/v1/bills/:id body: any subset; `{}` changes nothing. */
export function validateBillPatch(
  body: unknown,
): { patch: BillChanges } | { error: string } {
  const result = validateFields(body, false)
  return 'error' in result ? result : { patch: result.fields }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface BillRow {
  id: number
  scope: RowScope
  name: string
  amount_cents: number
  repeat: BillRepeat
  first_due_date: IsoDate
  account_id: number | null
  /** The paying account's display name; null when none or deleted. */
  account_name: string | null
}

interface PaymentRow {
  bill_id: number
  due_date: IsoDate
  amount_cents: number
  paid_at: IsoTimestamp
}

/** A bill's payments: `due_date` → `paid_at`. */
type PaidDates = ReadonlyMap<IsoDate, IsoTimestamp>

// Explicit columns, so no account number or Akahu id is ever read here.
function loadBillRows(db: Db) {
  return db('bills')
    .leftJoin('accounts', 'accounts.id', 'bills.account_id')
    .select<
      BillRow[]
    >(['bills.id', 'bills.scope', 'bills.name', 'bills.amount_cents', 'bills.repeat', 'bills.first_due_date', 'bills.account_id', 'accounts.name as account_name'])
    .orderBy('bills.id')
}

async function loadBillRow(db: Db, id: number): Promise<BillRow | undefined> {
  return loadBillRows(db).where('bills.id', id).first()
}

function loadPayments(db: Db) {
  return db('bill_payments')
    .select<PaymentRow[]>('bill_id', 'due_date', 'amount_cents', 'paid_at')
    .orderBy('id')
}

/** Every payment, grouped by bill. */
function paidDatesByBill(
  payments: readonly PaymentRow[],
): Map<number, Map<IsoDate, IsoTimestamp>> {
  const byBill = new Map<number, Map<IsoDate, IsoTimestamp>>()
  for (const p of payments) {
    let dates = byBill.get(p.bill_id)
    if (dates === undefined) {
      dates = new Map()
      byBill.set(p.bill_id, dates)
    }
    dates.set(p.due_date, p.paid_at)
  }
  return byBill
}

async function loadPaidDates(db: Db, billId: number): Promise<PaidDates> {
  return (
    paidDatesByBill(await loadPayments(db).where('bill_id', billId)).get(
      billId,
    ) ?? new Map()
  )
}

/**
 * The bill's current occurrence: the earliest with no payment. Paid dates
 * are only searched up to the end of the year after the latest payment:
 * every repeating bill falls due at least once a year, so the first unpaid
 * occurrence is never later than that. "Mark paid" stops at
 * `FIRST_DUE_MAX`, so the horizon is at most the end of the year after it:
 * at worst a century of weekly occurrences, which is cheap to list.
 */
function currentOccurrence(row: BillRow, paid: PaidDates): IsoDate {
  if (row.repeat === 'none' || paid.size === 0) return row.first_due_date
  let latestYear = 0
  for (const dueDate of paid.keys()) {
    latestYear = Math.max(latestYear, Number(dueDate.slice(0, 4)))
  }
  const horizon = `${String(latestYear + 1).padStart(4, '0')}-12-31`
  const occurrences = guard(() => billOccurrencesThrough(row, horizon))
  // Every payment is before the anchor: none of them is on the schedule.
  if (occurrences.length === 0) return row.first_due_date
  const unpaid = occurrences.find((dueDate) => !paid.has(dueDate))
  // Not reachable: no payment falls in the horizon's last year, and the bill
  // falls due in it. Kept so a mistake here is an error, never a wrong date.
  if (unpaid === undefined) {
    throw new BillsDataError('a stored bill is not valid')
  }
  return unpaid
}

/** The bill as the API shows it, at its current occurrence. */
function resolveBill(row: BillRow, paid: PaidDates): BillResponse {
  // Only a one-off is ever shown paid: a repeating bill moves on to its
  // next occurrence instead.
  const paidAt =
    row.repeat === 'none' ? (paid.get(row.first_due_date) ?? null) : null
  return {
    id: String(row.id),
    scope: row.scope,
    name: row.name,
    amountCents: row.amount_cents,
    dueDate: currentOccurrence(row, paid),
    repeat: row.repeat,
    firstDueDate: row.first_due_date,
    paid: paidAt !== null,
    paidAt,
    accountName: row.account_name,
  }
}

/** Every unpaid occurrence of a bill up to and including `through`. */
function unpaidThrough(
  bill: Pick<BillRow, 'repeat' | 'first_due_date'>,
  paid: PaidDates,
  through: IsoDate,
): IsoDate[] {
  return guard(() => billOccurrencesThrough(bill, through)).filter(
    (dueDate) => !paid.has(dueDate),
  )
}

/**
 * The next payday as the overview reads it, from the settings module, so a
 * stored payday that is not valid reads as the default here. The overview
 * reads the same row strictly and answers 500 for it instead.
 */
async function readNextPayday(now: Date, db: Db): Promise<IsoDate> {
  const today = guard(() => nzCalendarDate(now))
  const settings = await getSettings(db)
  return guard(() => nextPayday(today, settings.paydayWeekday))
}

/** The calendar month an instant falls in, in Pacific/Auckland: `YYYY-MM`. */
function nzMonth(at: Date): string {
  return guard(() => nzCalendarDate(at)).slice(0, 7)
}

function byListOrder(a: BillResponse, b: BillResponse): number {
  if (a.paid !== b.paid) return a.paid ? 1 : -1
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
  return Number(a.id) - Number(b.id)
}

/**
 * The Bills screen for one scope. Items are unpaid first, then by current
 * due date, then by id. `dueBeforePaydayCents` counts every unpaid
 * occurrence due on or before the next payday, overdue ones included
 * (#151), before the Strawb tax-pot buffer (prd-02 Ruling 12), so it is
 * the overview's `unpaidBillsCents + strawbBillsBufferCents`. Reads only.
 */
export async function listBills(
  scope: Scope,
  now: Date = new Date(),
  db = connection,
): Promise<BillsResponse> {
  const next = await readNextPayday(now, db)
  const rows = (await loadBillRows(db)).filter(
    (row) => scope === 'all' || row.scope === scope,
  )
  const payments = await loadPayments(db)
  const paidByBill = paidDatesByBill(payments)
  const none: PaidDates = new Map()

  const items = rows
    .map((row) => resolveBill(row, paidByBill.get(row.id) ?? none))
    .sort(byListOrder)

  // One amount per unpaid occurrence, as the overview passes each one to
  // safe-to-spend.
  const dueAmounts: number[] = []
  for (const row of rows) {
    const paid = paidByBill.get(row.id) ?? none
    const due = unpaidThrough(row, paid, next).length
    for (let i = 0; i < due; i += 1) dueAmounts.push(row.amount_cents)
  }

  // A payment counts in the month it was paid, whatever occurrence it paid,
  // at the amount paid then (the snapshot), not the bill's amount now.
  const inScope = new Set(rows.map((row) => row.id))
  const thisMonth = nzMonth(now)
  const paidAmounts: number[] = []
  for (const p of payments) {
    if (!inScope.has(p.bill_id)) continue
    const paidAt = new Date(p.paid_at)
    if (Number.isNaN(paidAt.getTime())) {
      throw new BillsDataError('a stored bill is not valid')
    }
    if (nzMonth(paidAt) === thisMonth) paidAmounts.push(p.amount_cents)
  }

  return {
    items,
    dueBeforePaydayCents: guard(() => sumCents(dueAmounts)),
    nextBill: items.find((item) => !item.paid) ?? null,
    paidThisMonthCents: guard(() => sumCents(paidAmounts)),
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Why a write was refused. The route maps each to a status and a text. */
export type BillRefusal =
  | 'not_found'
  | 'cannot_delete_paid'
  | 'cannot_reschedule_paid'
  | 'account_not_found'
  | 'account_scope_mismatch'
  | 'too_many_unpaid'
  | 'already_paid'
  | 'paid_too_far_ahead'

export type BillWrite<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: BillRefusal }

function refuse(refusal: BillRefusal): { ok: false; refusal: BillRefusal } {
  return { ok: false, refusal }
}

/**
 * Whether a bill may be paid from this account: a stored Akahu account
 * (never a Xero row, prd-01 Ruling 9) in the bill's own scope. The
 * database does not check the scope (#39), so this does.
 */
async function checkAccount(
  db: Db,
  accountId: number,
  scope: RowScope,
): Promise<BillRefusal | null> {
  const account: { scope: RowScope } | undefined = await db('accounts')
    .where({ id: accountId, source: 'akahu' })
    .first('scope')
  if (account === undefined) return 'account_not_found'
  return account.scope === scope ? null : 'account_scope_mismatch'
}

/**
 * Whether a schedule leaves more unpaid occurrences than the overview takes.
 * The limit is `MAX_UNPAID_OCCURRENCES` in shared/nz-dates.ts, the one the
 * overview reads with; a write past it is refused, because the overview
 * would answer 500 for the bill.
 */
function tooManyUnpaid(
  schedule: Pick<BillRow, 'repeat' | 'first_due_date'>,
  paid: PaidDates,
  next: IsoDate,
): boolean {
  return unpaidThrough(schedule, paid, next).length > MAX_UNPAID_OCCURRENCES
}

async function resolveStored(db: Db, id: number): Promise<BillResponse> {
  const row = await loadBillRow(db, id)
  if (row === undefined) throw new Error('a written bill was not stored')
  return resolveBill(row, await loadPaidDates(db, id))
}

/**
 * Creates a bill. Refuses an account that is not a stored Akahu account in
 * the bill's scope, and a schedule that would leave more unpaid occurrences
 * through the next payday than the overview can take.
 */
export async function createBill(
  input: NewBill,
  now: Date = new Date(),
  db = connection,
): Promise<BillWrite<BillResponse>> {
  return db.transaction(async (trx) => {
    if (input.accountId !== null) {
      const refusal = await checkAccount(trx, input.accountId, input.scope)
      if (refusal !== null) return refuse(refusal)
    }
    const next = await readNextPayday(now, trx)
    const schedule = {
      repeat: input.repeat,
      first_due_date: input.firstDueDate,
    }
    if (tooManyUnpaid(schedule, new Map(), next)) {
      return refuse('too_many_unpaid')
    }
    const stamp = now.toISOString()
    // SQLite answers the new row's id.
    const [insertedId]: number[] = await trx('bills').insert({
      scope: input.scope,
      name: input.name,
      amount_cents: input.amountCents,
      repeat: input.repeat,
      first_due_date: input.firstDueDate,
      account_id: input.accountId,
      created_at: stamp,
      updated_at: stamp,
    })
    return { ok: true, value: await resolveStored(trx, insertedId) }
  })
}

/**
 * Edits a bill. Refusals come in this order: no such bill; a new first due
 * date or repeat on a bill with payments, because its payments would no
 * longer lie on its schedule (#49 decision 2); an account that fails
 * `checkAccount` against the final scope; a new schedule with too many
 * unpaid occurrences. A field resent with its stored value is no change,
 * and a write with no change leaves `updated_at` alone.
 *
 * The account is checked only when the body sends `scope` or `accountId`,
 * so a name or amount edit never refuses a bill stored before this check.
 */
export async function updateBill(
  id: number,
  changes: BillChanges,
  now: Date = new Date(),
  db = connection,
): Promise<BillWrite<BillResponse>> {
  return db.transaction(async (trx) => {
    const row = await loadBillRow(trx, id)
    if (row === undefined) return refuse('not_found')
    const paid = await loadPaidDates(trx, id)

    const final = {
      scope: changes.scope ?? row.scope,
      name: changes.name ?? row.name,
      amount_cents: changes.amountCents ?? row.amount_cents,
      repeat: changes.repeat ?? row.repeat,
      first_due_date: changes.firstDueDate ?? row.first_due_date,
      account_id:
        changes.accountId !== undefined ? changes.accountId : row.account_id,
    }
    const scheduleChanged =
      final.first_due_date !== row.first_due_date || final.repeat !== row.repeat
    if (scheduleChanged && paid.size > 0) {
      return refuse('cannot_reschedule_paid')
    }
    if (
      (changes.scope !== undefined || changes.accountId !== undefined) &&
      final.account_id !== null
    ) {
      const refusal = await checkAccount(trx, final.account_id, final.scope)
      if (refusal !== null) return refuse(refusal)
    }
    if (scheduleChanged) {
      const next = await readNextPayday(now, trx)
      if (tooManyUnpaid(final, paid, next)) return refuse('too_many_unpaid')
    }

    const changed =
      final.scope !== row.scope ||
      final.name !== row.name ||
      final.amount_cents !== row.amount_cents ||
      scheduleChanged ||
      final.account_id !== row.account_id
    if (changed) {
      await trx('bills')
        .where({ id })
        .update({ ...final, updated_at: now.toISOString() })
    }
    return { ok: true, value: await resolveStored(trx, id) }
  })
}

/**
 * Deletes a bill that has no payments. One with payments is refused (#49
 * decision 2): its payments are what "paid this month" is counted from.
 */
export async function deleteBill(
  id: number,
  db = connection,
): Promise<BillWrite<null>> {
  return db.transaction(async (trx) => {
    const row: { id: number } | undefined = await trx('bills')
      .where({ id })
      .first('id')
    if (row === undefined) return refuse('not_found')
    const payment: { id: number } | undefined = await trx('bill_payments')
      .where({ bill_id: id })
      .first('id')
    if (payment !== undefined) return refuse('cannot_delete_paid')
    await trx('bills').where({ id }).delete()
    return { ok: true, value: null }
  })
}

/**
 * Whether `err` is the database refusing a second payment for the same
 * occurrence (UNIQUE (bill_id, due_date), #39), and not any other
 * constraint.
 */
export function isPaymentConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  return (
    code === 'SQLITE_CONSTRAINT' &&
    /UNIQUE constraint failed: bill_payments\.bill_id, bill_payments\.due_date/.test(
      err.message,
    )
  )
}

/**
 * "Mark paid": records a payment for the bill's current occurrence, at the
 * bill's amount now, and answers the bill afterwards. Refuses a one-off
 * already paid, and an occurrence after `FIRST_DUE_MAX` (#49 decision 4).
 * Two presses at once cannot pay one occurrence twice: the database's
 * UNIQUE (bill_id, due_date) refuses the second, which answers as already
 * paid.
 */
export async function markBillPaid(
  id: number,
  now: Date = new Date(),
  db = connection,
): Promise<BillWrite<BillResponse>> {
  try {
    return await db.transaction(async (trx) => {
      const row = await loadBillRow(trx, id)
      if (row === undefined) return refuse('not_found')
      const paid = await loadPaidDates(trx, id)
      if (row.repeat === 'none' && paid.has(row.first_due_date)) {
        return refuse('already_paid')
      }
      const dueDate = currentOccurrence(row, paid)
      if (dueDate > FIRST_DUE_MAX) return refuse('paid_too_far_ahead')
      await trx('bill_payments').insert({
        bill_id: id,
        due_date: dueDate,
        amount_cents: row.amount_cents,
        paid_at: now.toISOString(),
      })
      return { ok: true, value: await resolveStored(trx, id) }
    })
  } catch (err) {
    if (isPaymentConflict(err)) return refuse('already_paid')
    throw err
  }
}

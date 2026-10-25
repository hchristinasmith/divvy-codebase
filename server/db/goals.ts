import type {
  GoalResponse,
  GoalsResponse,
  IsoDate,
  IsoTimestamp,
} from '../../shared/contracts.ts'
import { goalPace } from '../../shared/goals.ts'
import { sumCents } from '../../shared/money.ts'
import { daysInMonth } from '../../shared/safe-to-spend.ts'
import connection from './connection.ts'
import { OverviewDataError, nzCalendarDate } from './overview.ts'

// The goals route's data module (prd-02, issue #50): the Goals screen's
// list, creating, editing and deleting a goal, and adding a contribution.
//
// Saved is derived, never stored: a goal's `savedCents` is the sum of its
// `goal_contributions` rows, in integer cents (prd-02 Ruling 5). Its pace
// and months to go come from `goalPace` in shared/goals.ts, which does the
// one rounding; nothing here divides.
//
// Contributions are only ever appended. Nothing here updates or deletes a
// contribution row; the one way they go is deleting the whole goal, which
// removes them through the foreign key's ON DELETE CASCADE (foreign_keys is
// on in every pool in ./knexfile.js).
//
// A contribution is a record, not a transfer (prd-02 Ruling 5): adding one
// writes a single `goal_contributions` row and nothing else, so no balance,
// transaction or setting moves, and safe-to-spend is the same before and
// after. The amount is whatever the request sent; no button amount lives
// on the server.
//
// Writes return a closed refusal code, never an HTTP status; the route
// maps it to its status and text. Errors the client may see are
// `GoalsDataError`s with a fixed text; the shared modules' RangeError and
// TypeError, whose messages may name values, never leave here as they are.

/**
 * A failure the route may name to the client: one of a closed set of
 * constant texts, so no id, stored value or SQL reaches a response.
 */
type GoalsDataErrorMessage =
  | 'a stored goal is not valid'
  | 'goals input invalid'

export class GoalsDataError extends Error {
  constructor(message: GoalsDataErrorMessage) {
    super(message)
    this.name = 'GoalsDataError'
  }
}

// Copies of `MAX_BILL_CENTS`, `MAX_NAME_LENGTH`, `FIRST_DUE_MIN` and
// `FIRST_DUE_MAX` in ./bills.ts; change together. The most a goal or a
// single contribution may be is $10,000,000.00.
const MAX_GOAL_CENTS = 1_000_000_000
const MAX_CONTRIBUTION_CENTS = 1_000_000_000
const MAX_NAME_LENGTH = 255
const TARGET_DATE_MIN = '2000-01-01'
const TARGET_DATE_MAX = '2099-12-31'

type Db = typeof connection

/**
 * Runs shared money code over stored rows, turning its RangeError or
 * TypeError (whose messages name values) into the fixed text: a sum that
 * is not a safe integer, or a stored target the pace refuses.
 */
function guardStored<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new GoalsDataError('a stored goal is not valid')
    }
    throw err
  }
}

/**
 * Runs a call into shared date code, turning its RangeError or TypeError,
 * or an `OverviewDataError` from a function borrowed from ./overview.ts,
 * into the fixed text. A copy of `guard` in ./bills.ts (itself a copy of
 * the private one in ./overview.ts); change all together.
 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (
      err instanceof RangeError ||
      err instanceof TypeError ||
      err instanceof OverviewDataError
    ) {
      throw new GoalsDataError('goals input invalid')
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A goal as created: what POST /api/v1/goals checked and parsed. */
export interface NewGoal {
  name: string
  targetCents: number
  targetDate: IsoDate | null
}

/** A PATCH: only the fields sent. */
export type GoalChanges = Partial<NewGoal>

/**
 * One field's rule: the parsed value, or null if the sent value is refused.
 * A copy of `Rule` in ./bills.ts; change together.
 */
interface Rule<T> {
  parse(value: unknown): { value: T } | null
  error: string
}

// A copy of `ISO_DATE` and `isRealDate` in ./bills.ts; change together.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

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

// No coercion anywhere: a numeric string, a float or null is refused where
// the field wants something else. No message echoes what was sent.
const RULES: { [K in keyof NewGoal]: Rule<NewGoal[K]> } = {
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
  targetCents: {
    parse: (v) =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v >= 1 &&
      v <= MAX_GOAL_CENTS
        ? { value: v }
        : null,
    error: `targetCents must be a whole number of cents from 1 to ${MAX_GOAL_CENTS}`,
  },
  targetDate: {
    // ISO dates compare correctly as strings. Null is "no date".
    parse: (v) => {
      if (v === null) return { value: null }
      return typeof v === 'string' &&
        isRealDate(v) &&
        v >= TARGET_DATE_MIN &&
        v <= TARGET_DATE_MAX
        ? { value: v }
        : null
    },
    error: `targetDate must be a YYYY-MM-DD date from ${TARGET_DATE_MIN} to ${TARGET_DATE_MAX}, or null`,
  },
}

// The order fields are checked in, whatever order the body sends them.
const FIELD_ORDER: readonly (keyof NewGoal)[] = [
  'name',
  'targetCents',
  'targetDate',
]
const FIELD_SET: ReadonlySet<string> = new Set(FIELD_ORDER)

// A copy of `hasOwn` in ./bills.ts; change together.
function hasOwn(body: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function isPlainBody(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
}

// Parses `value` into `out[field]`; false if the rule refuses it.
function accept<K extends keyof NewGoal>(
  out: GoalChanges,
  field: K,
  value: unknown,
): boolean {
  const rule: Rule<NewGoal[K]> = RULES[field]
  const parsed = rule.parse(value)
  if (parsed === null) return false
  out[field] = parsed.value
  return true
}

// The checks both goal bodies share: a plain object with no unknown key,
// then each present field in `FIELD_ORDER`.
function validateFields(
  body: unknown,
  required: boolean,
): { fields: GoalChanges } | { error: string } {
  if (!isPlainBody(body)) return { error: 'Body must be a JSON object' }
  if (Object.keys(body).some((key) => !FIELD_SET.has(key))) {
    return { error: 'Unknown field in body' }
  }
  const fields: GoalChanges = {}
  for (const field of FIELD_ORDER) {
    if (!hasOwn(body, field)) {
      // `targetDate` is the one optional field on create.
      if (required && field !== 'targetDate') {
        return { error: RULES[field].error }
      }
      continue
    }
    if (!accept(fields, field, body[field])) {
      return { error: RULES[field].error }
    }
  }
  return { fields }
}

/**
 * Checks a POST /api/v1/goals body. `name` and `targetCents` are required;
 * an omitted `targetDate` is null. The name is stored trimmed. The error is
 * the first failure in `FIELD_ORDER`, never in the body's key order.
 */
export function validateCreateGoal(
  body: unknown,
): { goal: NewGoal } | { error: string } {
  const result = validateFields(body, true)
  if ('error' in result) return result
  const { name, targetCents, targetDate } = result.fields
  if (name === undefined || targetCents === undefined) {
    // validateFields refused every missing required field already.
    throw new Error('a required goal field was not parsed')
  }
  return { goal: { name, targetCents, targetDate: targetDate ?? null } }
}

/**
 * Checks a PATCH /api/v1/goals/:id body: any subset; `{}` changes nothing.
 * `targetDate: null` clears the date; a null name or target is refused.
 */
export function validateGoalPatch(
  body: unknown,
): { patch: GoalChanges } | { error: string } {
  const result = validateFields(body, false)
  return 'error' in result ? result : { patch: result.fields }
}

const AMOUNT_ERROR = `amountCents must be a whole number of cents from 1 to ${MAX_CONTRIBUTION_CENTS}`

/**
 * Checks a POST /api/v1/goals/:id/contributions body: a plain object whose
 * only key is `amountCents`. Anything else, a `contributedAt` included, is
 * an unknown field: the server stamps the time.
 */
export function validateContribution(
  body: unknown,
): { amountCents: number } | { error: string } {
  if (!isPlainBody(body)) return { error: 'Body must be a JSON object' }
  if (Object.keys(body).some((key) => key !== 'amountCents')) {
    return { error: 'Unknown field in body' }
  }
  const v = body.amountCents
  return typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    v >= 1 &&
    v <= MAX_CONTRIBUTION_CENTS
    ? { amountCents: v }
    : { error: AMOUNT_ERROR }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface GoalRow {
  id: number
  name: string
  target_cents: number
  target_date: IsoDate | null
}

interface ContributionRow {
  goal_id: number
  amount_cents: number
}

function loadGoalRows(db: Db) {
  return db('goals')
    .select<GoalRow[]>('id', 'name', 'target_cents', 'target_date')
    .orderBy('id')
}

function loadContributions(db: Db) {
  return db('goal_contributions')
    .select<ContributionRow[]>('goal_id', 'amount_cents')
    .orderBy('id')
}

/** Every contribution's amount, grouped by goal. */
function amountsByGoal(
  rows: readonly ContributionRow[],
): Map<number, number[]> {
  const byGoal = new Map<number, number[]>()
  for (const row of rows) {
    let amounts = byGoal.get(row.goal_id)
    if (amounts === undefined) {
      amounts = []
      byGoal.set(row.goal_id, amounts)
    }
    amounts.push(row.amount_cents)
  }
  return byGoal
}

/** The goal as the API shows it: saved is the sum of its contributions. */
function resolveGoal(
  row: GoalRow,
  amounts: readonly number[],
  today: IsoDate,
): GoalResponse {
  const savedCents = guardStored(() => sumCents(amounts))
  const { paceCents, monthsToGo } = guardStored(() =>
    goalPace({
      targetCents: row.target_cents,
      savedCents,
      targetDate: row.target_date,
      today,
    }),
  )
  return {
    id: String(row.id),
    name: row.name,
    targetCents: row.target_cents,
    savedCents,
    targetDate: row.target_date,
    paceCents,
    monthsToGo,
  }
}

function todayAt(now: Date): IsoDate {
  return guard(() => nzCalendarDate(now))
}

async function resolveStored(
  db: Db,
  id: number,
  today: IsoDate,
): Promise<GoalResponse> {
  const row: GoalRow | undefined = await loadGoalRows(db).where({ id }).first()
  if (row === undefined) throw new Error('a written goal was not stored')
  const amounts = (await loadContributions(db).where({ goal_id: id })).map(
    (c) => c.amount_cents,
  )
  return resolveGoal(row, amounts, today)
}

/** The Goals screen: every goal, by id. Reads only. */
export async function listGoals(
  now: Date = new Date(),
  db = connection,
): Promise<GoalsResponse> {
  const today = todayAt(now)
  const rows = await loadGoalRows(db)
  const byGoal = amountsByGoal(await loadContributions(db))
  return {
    items: rows.map((row) => resolveGoal(row, byGoal.get(row.id) ?? [], today)),
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Why a write was refused. The route maps each to a status and a text. */
export type GoalRefusal = 'not_found'

export type GoalWrite<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: GoalRefusal }

function refuse(refusal: GoalRefusal): { ok: false; refusal: GoalRefusal } {
  return { ok: false, refusal }
}

/** Creates a goal with no contributions. */
export async function createGoal(
  input: NewGoal,
  now: Date = new Date(),
  db = connection,
): Promise<GoalResponse> {
  const today = todayAt(now)
  return db.transaction(async (trx) => {
    const stamp: IsoTimestamp = now.toISOString()
    // SQLite answers the new row's id.
    const [insertedId]: number[] = await trx('goals').insert({
      name: input.name,
      target_cents: input.targetCents,
      target_date: input.targetDate,
      created_at: stamp,
      updated_at: stamp,
    })
    return resolveStored(trx, insertedId, today)
  })
}

/**
 * Edits a goal. A field resent with its stored value is no change, and a
 * write with no change leaves `updated_at` alone. A target below what is
 * already saved is allowed: the goal is then funded.
 */
export async function updateGoal(
  id: number,
  changes: GoalChanges,
  now: Date = new Date(),
  db = connection,
): Promise<GoalWrite<GoalResponse>> {
  const today = todayAt(now)
  return db.transaction(async (trx) => {
    const row: GoalRow | undefined = await loadGoalRows(trx)
      .where({ id })
      .first()
    if (row === undefined) return refuse('not_found')

    const final = {
      name: changes.name ?? row.name,
      target_cents: changes.targetCents ?? row.target_cents,
      target_date:
        changes.targetDate !== undefined ? changes.targetDate : row.target_date,
    }
    const changed =
      final.name !== row.name ||
      final.target_cents !== row.target_cents ||
      final.target_date !== row.target_date
    if (changed) {
      await trx('goals')
        .where({ id })
        .update({ ...final, updated_at: now.toISOString() })
    }
    return { ok: true, value: await resolveStored(trx, id, today) }
  })
}

/**
 * Deletes a goal. Its contributions go with it, by the foreign key's
 * ON DELETE CASCADE: the only way a contribution is ever removed.
 */
export async function deleteGoal(
  id: number,
  db = connection,
): Promise<GoalWrite<null>> {
  return db.transaction(async (trx) => {
    const row: { id: number } | undefined = await trx('goals')
      .where({ id })
      .first('id')
    if (row === undefined) return refuse('not_found')
    await trx('goals').where({ id }).delete()
    return { ok: true, value: null }
  })
}

/**
 * Records a contribution of `amountCents` to a goal and answers the goal
 * afterwards. A contribution is a record, not a transfer (prd-02 Ruling 5):
 * this appends one `goal_contributions` row and writes nothing else, not
 * even the goal's `updated_at`, so no money moves and safe-to-spend is
 * unchanged.
 */
export async function addContribution(
  id: number,
  amountCents: number,
  now: Date = new Date(),
  db = connection,
): Promise<GoalWrite<GoalResponse>> {
  const today = todayAt(now)
  return db.transaction(async (trx) => {
    const row: { id: number } | undefined = await trx('goals')
      .where({ id })
      .first('id')
    if (row === undefined) return refuse('not_found')
    await trx('goal_contributions').insert({
      goal_id: id,
      amount_cents: amountCents,
      contributed_at: now.toISOString(),
    })
    return { ok: true, value: await resolveStored(trx, id, today) }
  })
}

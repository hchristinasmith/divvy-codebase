import type {
  BudgetResponse,
  BudgetsResponse,
  IsoTimestamp,
  RowScope,
  Scope,
} from '../../shared/contracts.ts'
import { isKnownCategory } from './categories.ts'
import connection from './connection.ts'
import { readOverview } from './overview.ts'

// The budgets route's data module (prd-02, issue #48): the Budgets screen's
// list, and creating, adjusting and deleting a budget (Ruling 6: scope,
// category, a limit in integer cents and a note).
//
// Spent is never computed here (Ruling 1). Every read goes through
// `readOverview` in ./overview.ts and takes each budget's line off
// `safeToSpend.budgets`, exactly as the overview's ledger has it: spent is
// effective-category outflow, settled and pending, since the last payday
// (Ruling 2), with drawings left out (Ruling 15), and the limit is a weekly
// amount (Ruling 9). The list, a written budget and the overview therefore
// cannot disagree on spent, remaining or over. This module adds only the
// note, joined by id.
//
// Every operation runs in one transaction, and the read after a write is in
// that same transaction, so the line answered is the line just written. If
// that read fails (an account with no balance, a stored setting that is not
// valid) the write is rolled back and the route answers 500: a write is
// never stored without the screen being able to show it.
//
// A budget's category is a known NZFCC category (./categories.ts), never
// Drawings: a row in Drawings is never spent (Ruling 15), so a Drawings
// budget would always show nothing spent. One budget per category per
// scope: the table's UNIQUE (scope, category) refuses a second, and that
// refusal is answered as `duplicate`.
//
// Writes return a closed refusal code, never an HTTP status; the route maps
// each to its status and text. Errors the client may see are
// `BudgetsDataError`s with a fixed text, or the overview's own
// `OverviewDataError`s, which are fixed texts too.

/**
 * A failure the route may name to the client: one of a closed set of
 * constant texts, so no id, stored value or SQL reaches a response.
 */
type BudgetsDataErrorMessage = 'a stored budget is not valid'

export class BudgetsDataError extends Error {
  constructor(message: BudgetsDataErrorMessage) {
    super(message)
    this.name = 'BudgetsDataError'
  }
}

// A copy of `MAX_BILL_CENTS` in ./bills.ts and `MAX_GOAL_CENTS` in
// ./goals.ts; change together. The most a weekly limit may be is
// $10,000,000.00. UNIQUE (scope, category) bounds how many budgets there
// are, so their sum, `remainingBudgetCents`, stays a safe integer.
const MAX_BUDGET_CENTS = 1_000_000_000
const MAX_NOTE_LENGTH = 500

type Db = typeof connection

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A budget as created: what POST /api/v1/budgets checked and parsed. */
export interface NewBudget {
  scope: RowScope
  category: string
  limitCents: number
  note: string | null
}

/** A PATCH: only the fields sent. Scope and category never change. */
export interface BudgetChanges {
  limitCents?: number
  note?: string | null
}

/**
 * One field's rule: the parsed value, or null if the sent value is refused.
 * A copy of `Rule` in ./bills.ts and ./goals.ts; change all together.
 */
interface Rule<T> {
  parse(value: unknown): { value: T } | null
  error: string
}

// No coercion anywhere: a numeric string, a float, a boolean or null is
// refused where the field wants something else. No message echoes what was
// sent.
const RULES: { [K in keyof NewBudget]: Rule<NewBudget[K]> } = {
  scope: {
    parse: (v) => (v === 'personal' || v === 'strawb' ? { value: v } : null),
    error: 'scope must be personal or strawb',
  },
  category: {
    // Exact match: no trimming and no case folding, because spent is
    // matched on the exact effective-category name.
    parse: (v) =>
      typeof v === 'string' && isKnownCategory(v) ? { value: v } : null,
    error: 'category must be a known spending category (not Drawings)',
  },
  limitCents: {
    // 0 is allowed: a category Hannah means to spend nothing in.
    parse: (v) =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v >= 0 &&
      v <= MAX_BUDGET_CENTS
        ? { value: v }
        : null,
    error: `limitCents must be a whole number of cents from 0 to ${MAX_BUDGET_CENTS}`,
  },
  note: {
    // Stored trimmed; blank is no note. Null is no note too.
    parse: (v) => {
      if (v === null) return { value: null }
      if (typeof v !== 'string') return null
      const note = v.trim()
      if (note.length > MAX_NOTE_LENGTH) return null
      return { value: note.length === 0 ? null : note }
    },
    error: `note must be text of at most ${MAX_NOTE_LENGTH} characters, or null`,
  },
}

// The order fields are checked in, whatever order the body sends them. A
// PATCH takes only the fields that may change; scope, category or anything
// else in its body is an unknown field.
const CREATE_FIELDS: readonly (keyof NewBudget)[] = [
  'scope',
  'category',
  'limitCents',
  'note',
]
const PATCH_FIELDS: readonly (keyof BudgetChanges)[] = ['limitCents', 'note']

// A copy of `hasOwn` in ./bills.ts and ./goals.ts; change all together.
function hasOwn(body: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

// Parses `value` into `out[field]`; false if the rule refuses it.
function accept<K extends keyof NewBudget>(
  out: Partial<NewBudget>,
  field: K,
  value: unknown,
): boolean {
  const rule: Rule<NewBudget[K]> = RULES[field]
  const parsed = rule.parse(value)
  if (parsed === null) return false
  out[field] = parsed.value
  return true
}

// The checks both budget bodies share: a plain object with no key outside
// `order`, then each present field in `order`.
function validateFields(
  body: unknown,
  order: readonly (keyof NewBudget)[],
  required: boolean,
): { fields: Partial<NewBudget> } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Body must be a JSON object' }
  }
  const allowed: ReadonlySet<string> = new Set(order)
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { error: 'Unknown field in body' }
  }
  const fields: Partial<NewBudget> = {}
  for (const field of order) {
    if (!hasOwn(body, field)) {
      // `note` is the one optional field on create.
      if (required && field !== 'note') return { error: RULES[field].error }
      continue
    }
    const value: unknown = (body as Record<string, unknown>)[field]
    if (!accept(fields, field, value)) return { error: RULES[field].error }
  }
  return { fields }
}

/**
 * Checks a POST /api/v1/budgets body. `scope`, `category` and `limitCents`
 * are required; an omitted `note` is null. The error is the first failure
 * in field order, never in the body's key order.
 */
export function validateCreateBudget(
  body: unknown,
): { budget: NewBudget } | { error: string } {
  const result = validateFields(body, CREATE_FIELDS, true)
  if ('error' in result) return result
  const { scope, category, limitCents, note } = result.fields
  if (
    scope === undefined ||
    category === undefined ||
    limitCents === undefined
  ) {
    // validateFields refused every missing required field already.
    throw new Error('a required budget field was not parsed')
  }
  return { budget: { scope, category, limitCents, note: note ?? null } }
}

/**
 * Checks a PATCH /api/v1/budgets/:id body: `limitCents` and `note`, any
 * subset; `{}` changes nothing and `note: null` clears the note. The +/-10
 * step on the screen sends the new absolute limit.
 */
export function validateBudgetPatch(
  body: unknown,
): { patch: BudgetChanges } | { error: string } {
  const result = validateFields(body, PATCH_FIELDS, false)
  if ('error' in result) return result
  const patch: BudgetChanges = {}
  if (result.fields.limitCents !== undefined) {
    patch.limitCents = result.fields.limitCents
  }
  if (result.fields.note !== undefined) patch.note = result.fields.note
  return { patch }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface BudgetRow {
  id: number
  scope: RowScope
  limit_cents: number
  note: unknown
}

/**
 * The Budgets screen for one scope, read in `db`, which is a transaction
 * whenever a write came first. Items are the overview's budget lines in its
 * order (by id), each with its note; the period is the overview's.
 */
async function readBudgets(
  db: Db,
  scope: Scope,
  now: Date,
): Promise<BudgetsResponse> {
  const { safeToSpend } = await readOverview(scope, now, db)
  const noteRows: { id: number; note: unknown }[] = await db('budgets').select(
    'id',
    'note',
  )
  const notes = new Map<string, string | null>()
  for (const row of noteRows) {
    if (row.note !== null && typeof row.note !== 'string') {
      throw new BudgetsDataError('a stored budget is not valid')
    }
    notes.set(String(row.id), row.note)
  }
  const items: BudgetResponse[] = safeToSpend.budgets.map((line) => {
    const note = notes.get(line.id)
    // Not reachable: both reads are of one snapshot.
    if (note === undefined) {
      throw new BudgetsDataError('a stored budget is not valid')
    }
    return {
      id: line.id,
      scope: line.scope,
      category: line.category,
      limitCents: line.limitCents,
      spentCents: line.spentCents,
      remainingCents: line.remainingCents,
      overCents: line.overCents,
      note,
    }
  })
  return {
    items,
    periodStart: safeToSpend.lastPayday,
    periodEnd: safeToSpend.nextPayday,
  }
}

/** One budget as the list shows it, after a write in the same `db`. */
async function readBudget(
  db: Db,
  scope: RowScope,
  id: number,
  now: Date,
): Promise<BudgetResponse> {
  const { items } = await readBudgets(db, scope, now)
  const item = items.find((i) => i.id === String(id))
  if (item === undefined) {
    throw new BudgetsDataError('a stored budget is not valid')
  }
  return item
}

/** The Budgets screen: every budget in `scope`, by id. Reads only. */
export async function listBudgets(
  scope: Scope,
  now: Date = new Date(),
  db = connection,
): Promise<BudgetsResponse> {
  return db.transaction((trx) => readBudgets(trx, scope, now))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Why a write was refused. The route maps each to a status and a text. */
export type BudgetRefusal = 'not_found' | 'duplicate'

export type BudgetWrite<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: BudgetRefusal }

function refuse(refusal: BudgetRefusal): {
  ok: false
  refusal: BudgetRefusal
} {
  return { ok: false, refusal }
}

/**
 * Whether `err` is the database refusing a second budget for the same
 * category in the same scope (UNIQUE (scope, category)), and not any other
 * constraint. Shaped like `isPaymentConflict` in ./bills.ts.
 */
function isBudgetConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  return (
    code === 'SQLITE_CONSTRAINT' &&
    /UNIQUE constraint failed: budgets\.scope, budgets\.category/.test(
      err.message,
    )
  )
}

/**
 * Creates a budget and answers its line. Spend already in the category
 * since the last payday counts against it at once. A second budget for the
 * same category and scope is refused by the database, not by a lookup
 * first, so two creates at once cannot both land.
 */
export async function createBudget(
  input: NewBudget,
  now: Date = new Date(),
  db = connection,
): Promise<BudgetWrite<BudgetResponse>> {
  try {
    return await db.transaction(async (trx) => {
      const stamp: IsoTimestamp = now.toISOString()
      // SQLite answers the new row's id.
      const [insertedId]: number[] = await trx('budgets').insert({
        scope: input.scope,
        category: input.category,
        limit_cents: input.limitCents,
        note: input.note,
        created_at: stamp,
        updated_at: stamp,
      })
      return {
        ok: true,
        value: await readBudget(trx, input.scope, insertedId, now),
      }
    })
  } catch (err) {
    if (isBudgetConflict(err)) return refuse('duplicate')
    throw err
  }
}

/**
 * Adjusts a budget's limit or note and answers its line. A field resent
 * with its stored value is no change, and a write with no change leaves
 * `updated_at` alone.
 */
export async function updateBudget(
  id: number,
  changes: BudgetChanges,
  now: Date = new Date(),
  db = connection,
): Promise<BudgetWrite<BudgetResponse>> {
  return db.transaction(async (trx) => {
    const row: BudgetRow | undefined = await trx('budgets')
      .where({ id })
      .first('id', 'scope', 'limit_cents', 'note')
    if (row === undefined) return refuse('not_found')

    const final = {
      limit_cents: changes.limitCents ?? row.limit_cents,
      note: changes.note !== undefined ? changes.note : row.note,
    }
    const changed =
      final.limit_cents !== row.limit_cents || final.note !== row.note
    if (changed) {
      await trx('budgets')
        .where({ id })
        .update({ ...final, updated_at: now.toISOString() })
    }
    return { ok: true, value: await readBudget(trx, row.scope, id, now) }
  })
}

/**
 * Deletes a budget. No table has a foreign key to it. A dismissal of its
 * over-budget alert stays, harmlessly: ids are never reused (AUTOINCREMENT),
 * so it can never match another budget's alert.
 */
export async function deleteBudget(
  id: number,
  db = connection,
): Promise<BudgetWrite<null>> {
  return db.transaction(async (trx) => {
    const row: { id: number } | undefined = await trx('budgets')
      .where({ id })
      .first('id')
    if (row === undefined) return refuse('not_found')
    await trx('budgets').where({ id }).delete()
    return { ok: true, value: null }
  })
}

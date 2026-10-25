import type {
  ApplyCategoryResponse,
  CategoriseGroupResponse,
  CategoriseGroupsResponse,
  Cents,
  IsoDate,
  Scope,
} from '../../shared/contracts.ts'
import {
  UNNAMED_MERCHANT,
  isMerchantKey,
  merchantKeyOf,
} from '../../shared/subscriptions.ts'
import type { CategorySource } from '../../models/transactions.ts'
import { isSelectableCategory } from './categories.ts'
import connection from './connection.ts'
import { applyDrawings, loadDrawingIds } from './drawings.ts'
import { nzCalendarDate } from './overview.ts'
import { listAccounts } from './synced.ts'
import { setUserCategory } from './transactions.ts'

// The Sort screen's data module (prd-02 Ruling 16, issue #259): the read
// behind GET /api/v1/categorise/groups and the write behind POST
// /api/v1/categorise/groups/apply.
//
// One loader, `loadUncategorised`, feeds both, so the rows a card counts and
// the rows its apply writes are chosen by the same predicate. A row is
// uncategorised when it is an Akahu row on a stored Akahu account in the
// view's scope (either scope for `all`), settled, dated, with an amount, and
// its effective category is null: stored `category` null, and not a half of
// a drawing (prd-02 Ruling 15), whose effective category is Drawings. A
// pending row is never read (#161): sync replaces pending rows on every run,
// and `setUserCategory` refuses them.
//
// A merchant is `merchantKeyOf` from shared/subscriptions.ts, the key the
// Subscriptions screen stores marks under: the Akahu merchant id when there
// is one, else the description lower-cased with every run of non-letters
// (per-charge references, card and store numbers) one space. A row with
// neither an id nor a letter in its description has no key and is in no
// group, so nothing can apply a category to it from here.
//
// The apply re-derives its group inside one database transaction, with the
// same loader, and calls `setUserCategory` (server/db/transactions.ts), the
// one category writer, for each row with source `user`, so each row gets
// its correction and prd-04's rules can learn from it (prd-04 Ruling 7). A
// row categorised, matched as a drawing, moved to the other scope or
// re-keyed since the list loaded is no longer in the re-derived group, so it
// is never overwritten. Applying a group that is already empty changes nothing and
// answers 0, so a double submit is harmless.
//
// Errors the client may see are `CategoriseDataError`s with a fixed text.
// The shared drawing matcher's RangeError and TypeError, whose messages name
// values, are turned into one of those before leaving here.

/**
 * A failure the route may name to the client. The message is one of a closed
 * set of constant texts, so no stored value can reach a response through it.
 */
export type CategoriseDataErrorMessage =
  | 'a transaction is incomplete'
  | 'categorise input invalid'
  | 'a total is out of range'

export class CategoriseDataError extends Error {
  constructor(message: CategoriseDataErrorMessage) {
    super(message)
    this.name = 'CategoriseDataError'
  }
}

type Db = typeof connection

/** POST /api/v1/categorise/groups/apply's body, in its wire names. */
export interface ApplyCategoryRequest {
  scope: Scope
  merchant_key: string
  category: string
}

interface UncategorisedQueryRow {
  id: number
  date: string
  description: string | null
  amount_cents: number
  merchant_id: string | null
  merchant_name: string | null
  category: string | null
  category_source: CategorySource
}

/** An uncategorised row with its merchant key, oldest first. */
interface UncategorisedRow {
  id: number
  merchantKey: string
  date: string
  amountCents: Cents
  merchantName: string | null
  description: string | null
}

/**
 * The drawing ids, with the shared matcher's RangeError or TypeError (whose
 * messages name values) turned into the fixed text.
 */
async function loadDrawings(db: Db): Promise<Set<number>> {
  try {
    return await loadDrawingIds(db)
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) {
      throw new CategoriseDataError('categorise input invalid')
    }
    throw err
  }
}

/**
 * Every uncategorised row in `scope` that has a merchant key, ordered by
 * `date` then `id`, so the last row of a merchant is its latest. See the
 * header for what uncategorised means.
 */
async function loadUncategorised(
  scope: Scope,
  db: Db,
): Promise<UncategorisedRow[]> {
  const accountIds: string[] = []
  for (const account of await listAccounts(db)) {
    if (account.akahu_id === null) continue
    if (scope === 'all' || account.scope === scope) {
      accountIds.push(account.akahu_id)
    }
  }
  if (accountIds.length === 0) return []
  const rows: UncategorisedQueryRow[] = await db('transactions')
    .select(
      'id',
      'date',
      'description',
      'amount_cents',
      'merchant_id',
      'merchant_name',
      'category',
      'category_source',
    )
    .where({ source: 'akahu', status: 'settled' })
    .whereNull('category')
    .whereNotNull('date')
    .whereNotNull('amount_cents')
    .whereIn('account_id', accountIds)
    .orderBy([
      { column: 'date', order: 'asc' },
      { column: 'id', order: 'asc' },
    ])
  const overlaid = applyDrawings(rows, await loadDrawings(db))
  const uncategorised: UncategorisedRow[] = []
  for (const row of overlaid) {
    // The rule is the effective category; the query's `whereNull` only
    // narrows the read.
    if (row.category !== null) continue
    if (!Number.isSafeInteger(row.amount_cents)) {
      throw new CategoriseDataError('a transaction is incomplete')
    }
    const merchantKey = merchantKeyOf({
      merchantId: row.merchant_id,
      description: row.description,
    })
    if (merchantKey === null) continue
    uncategorised.push({
      id: row.id,
      merchantKey,
      date: row.date,
      amountCents: row.amount_cents,
      merchantName: row.merchant_name,
      description: row.description,
    })
  }
  return uncategorised
}

/** Adds integer cents; a result that is not a safe integer is refused. */
function addCents(a: Cents, b: Cents): Cents {
  const sum = a + b
  if (!Number.isSafeInteger(sum)) {
    throw new CategoriseDataError('a total is out of range')
  }
  return sum
}

/**
 * The one definition of a group's totals (prd-02 Ruling 16, "total spend").
 * `totalCents` is the money out, as a positive amount, the way
 * `budgetSpentCents` in shared/safe-to-spend.ts counts spend: money in
 * never offsets it. `receivedCents` is the money in, as a positive amount,
 * shown beside the card when there is any. Cards are ordered on these two.
 */
function groupTotals(amounts: readonly Cents[]): {
  totalCents: Cents
  receivedCents: Cents
} {
  let totalCents = 0
  let receivedCents = 0
  for (const amount of amounts) {
    if (amount < 0) totalCents = addCents(totalCents, -amount)
    else receivedCents = addCents(receivedCents, amount)
  }
  return { totalCents, receivedCents }
}

/** The NZ calendar date of a stored instant, or null when it is not one. */
function latestDateOf(instant: string): IsoDate | null {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return null
  return nzCalendarDate(at)
}

/**
 * The merchant name of the latest row that has one, else the latest row's
 * description, else `UNNAMED_MERCHANT`.
 */
function nameOf(rows: readonly UncategorisedRow[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const name = rows[i].merchantName?.trim()
    if (name) return name
  }
  return rows[rows.length - 1].description?.trim() || UNNAMED_MERCHANT
}

function toGroup(
  merchantKey: string,
  rows: readonly UncategorisedRow[],
): CategoriseGroupResponse {
  const latest = rows[rows.length - 1]
  return {
    merchantKey,
    name: nameOf(rows),
    count: rows.length,
    ...groupTotals(rows.map((row) => row.amountCents)),
    latestDate: latestDateOf(latest.date),
    latestAmountCents: latest.amountCents,
  }
}

/** Largest total first, then most received, then most rows, then the key. */
function byTotal(
  a: CategoriseGroupResponse,
  b: CategoriseGroupResponse,
): number {
  if (a.totalCents !== b.totalCents) return b.totalCents - a.totalCents
  if (a.receivedCents !== b.receivedCents) {
    return b.receivedCents - a.receivedCents
  }
  if (a.count !== b.count) return b.count - a.count
  if (a.merchantKey === b.merchantKey) return 0
  return a.merchantKey < b.merchantKey ? -1 : 1
}

/** Every merchant with an uncategorised row in `scope`, largest total first. */
export async function listGroups(
  scope: Scope,
  db: Db = connection,
): Promise<CategoriseGroupsResponse> {
  const byKey = new Map<string, UncategorisedRow[]>()
  for (const row of await loadUncategorised(scope, db)) {
    const rows = byKey.get(row.merchantKey)
    if (rows === undefined) byKey.set(row.merchantKey, [row])
    else rows.push(row)
  }
  const groups = [...byKey].map(([key, rows]) => toGroup(key, rows))
  return { groups: groups.sort(byTotal) }
}

/**
 * Sets `category` on every row of the merchant's group in `scope` as it is
 * now, through `setUserCategory` with source `user`, in one database
 * transaction. Answers how many rows it changed.
 */
export async function applyGroup(
  request: ApplyCategoryRequest,
  db: Db = connection,
): Promise<ApplyCategoryResponse> {
  // Only `trx` inside: the pool holds one connection, so a query on `db`
  // here would wait for this transaction forever.
  return db.transaction(async (trx) => {
    const rows = (await loadUncategorised(request.scope, trx)).filter(
      (row) => row.merchantKey === request.merchant_key,
    )
    let changed = 0
    for (const row of rows) {
      const written = await setUserCategory(
        row.id,
        request.category,
        trx,
        'user',
      )
      if (typeof written === 'object') changed += 1
    }
    return { changed }
  })
}

const APPLY_KEYS = ['category', 'merchant_key', 'scope'] as const

/**
 * The apply body, or the fixed text refusing it. A plain object holding
 * exactly `scope`, `merchant_key` and `category`; the scope a view's; the key
 * a shape `merchantKeyOf` can build; the category one Hannah can pick
 * (`isSelectableCategory`, Drawings included, as PATCH /transactions).
 * Never echoes what was sent.
 */
export function validateApplyRequest(
  body: unknown,
): { request: ApplyCategoryRequest } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Invalid body' }
  }
  const keys = Object.keys(body).sort()
  if (
    keys.length !== APPLY_KEYS.length ||
    keys.some((key, i) => key !== APPLY_KEYS[i])
  ) {
    return { error: 'Invalid body' }
  }
  const { scope, merchant_key, category } = body as Record<string, unknown>
  if (scope !== 'all' && scope !== 'personal' && scope !== 'strawb') {
    return { error: 'scope must be all, personal or strawb' }
  }
  if (!isMerchantKey(merchant_key)) {
    return { error: 'merchant_key is not valid' }
  }
  if (typeof category !== 'string' || !isSelectableCategory(category)) {
    return { error: 'category is not in the category list' }
  }
  return { request: { scope, merchant_key, category } }
}

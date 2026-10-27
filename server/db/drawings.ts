import type { CategorySource } from '../../models/transactions.ts'
import type { RowScope } from '../../shared/contracts.ts'
import {
  effectiveCategory,
  findDrawingIds,
  type DrawingCandidate,
} from '../../shared/drawings.ts'
import { nzCalendarDate } from '../../shared/nz-dates.ts'
import connection from './connection.ts'

// Drawings on read (prd-02 Ruling 15): which stored transactions are a half
// of a drawing, and the overlay that shows them as Drawings. The matching
// itself is shared/drawings.ts; this module only loads its candidates and
// writes nothing, ever. Every read path that shows a category or counts
// spending calls `loadDrawingIds` once and lays the result over its rows:
// the overview (safe-to-spend, budgets, activity), spending by category,
// subscriptions, and every transaction list (account, search, Spending screen).
//
// Candidates are all-time, not a window, so neither the safe-to-spend
// window's edge nor a list's limit can hide a partner: every Akahu row on a
// stored Akahu account that could be a half, a Strawb outflow or a personal
// inflow, settled and pending alike, each taking its account's scope. Its
// date is the NZ calendar date of the stored instant (`nzCalendarDate`). A
// row with no date, or a date that is not an instant, cannot be placed in
// the window and so is never a drawing; nothing else about it changes.
//
// `nzCalendarDate` is the shared one; a Date that is not an instant is
// skipped before it is called, so its RangeError is never reached here.
//
// The insights agent imports this module, so it must stay write-free and
// must not import a module that writes (./overview.ts does).
// server/agents/__tests__/no-money-writes.test.ts enforces both for
// server/db modules, following this module's server/db imports
// transitively. It does not follow an import of a module outside
// server/db/, so that is held by this comment alone.

type Db = typeof connection

/** The only date shape the shared matcher accepts. */
const NZ_DAY = /^\d{4}-\d{2}-\d{2}$/

interface CandidateRow {
  id: number
  scope: RowScope
  date: string
  amount_cents: number
}

/** The ids of both halves of every drawing in the database, as of now. */
export async function loadDrawingIds(
  db: Db = connection,
): Promise<Set<number>> {
  const rows: CandidateRow[] = await db('transactions as t')
    .join('accounts as a', 'a.akahu_id', 't.account_id')
    .where('t.source', 'akahu')
    .where('a.source', 'akahu')
    .whereNotNull('t.date')
    .where((q) =>
      q
        .where((out) =>
          out.where('a.scope', 'strawb').where('t.amount_cents', '<', 0),
        )
        .orWhere((into) =>
          into.where('a.scope', 'personal').where('t.amount_cents', '>', 0),
        ),
    )
    .select('t.id', 'a.scope', 't.date', 't.amount_cents')
  const candidates: DrawingCandidate[] = []
  for (const row of rows) {
    const at = new Date(row.date)
    if (Number.isNaN(at.getTime())) continue
    // The shared matcher is strict and throws on one bad candidate; a row it
    // cannot place (a year past 9999, an amount that is not whole cents) is
    // skipped here instead, so one odd row never fails every list.
    const date = nzCalendarDate(at)
    if (!NZ_DAY.test(date) || !Number.isSafeInteger(row.amount_cents)) continue
    candidates.push({
      id: row.id,
      scope: row.scope,
      date,
      amountCents: row.amount_cents,
    })
  }
  return findDrawingIds(candidates)
}

/** A row as the overlay sees it: its id and its stored category columns. */
interface CategorisedRow {
  /** A row id; a text id is read as the number it holds. */
  id: number | string
  category: string | null
  category_source: CategorySource
}

/**
 * Each row with its effective category (prd-02 Ruling 15): a half of a
 * drawing shows Drawings, set by `rule`, unless Hannah set its category by
 * hand. Every other key is kept as it is, so a response's key set never
 * changes; a row that is not a drawing is returned unchanged.
 */
export function applyDrawings<Row extends CategorisedRow>(
  rows: readonly Row[],
  ids: ReadonlySet<number>,
): Row[] {
  return rows.map((row) => {
    if (!ids.has(Number(row.id))) return row
    const effective = effectiveCategory(
      { category: row.category, categorySource: row.category_source },
      true,
    )
    return {
      ...row,
      category: effective.category,
      category_source: effective.categorySource,
    }
  })
}

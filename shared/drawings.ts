// Drawings: Hannah paying herself (prd-02 Ruling 15). A transfer out of a
// `strawb` account matched by the same amount arriving in a `personal`
// account within a few days is a drawing. Both halves show the category
// Drawings unless Hannah set a different category on that row by hand, and
// a row whose effective category is Drawings is never spending: not Strawb
// spending, not personal spending, not a budget's actual, not a
// subscription. Balances are never touched, so drawings still move them.
//
// Drawings are derived on every read, never written: nothing stores
// `category = 'Drawings'` except Hannah, through the one category writer
// (`setUserCategory`, server/db/transactions.ts). A stored category would go
// stale (the partner half can land days later, pending rows are re-inserted
// on every sync) and sync never writes the user's column (prd-01 Ruling 4).
//
// This module is pure: it takes rows and returns which ids are drawings. The
// server's read paths (server/db/drawings.ts) load the candidates and lay
// the result over each row with `effectiveCategory`; shared/safe-to-spend.ts
// and the subscriptions read drop every row `isDrawingCategory` says is one.
//
// Matching (`findDrawingIds`):
//
// - Candidates are Akahu rows on stored accounts, settled or pending, blind
//   to category, type and merchant. The out half is a `strawb` row with a
//   negative amount; the in half a `personal` row with a positive one, and
//   `out = −in` exactly. A personal→strawb transfer (money put in),
//   strawb→strawb and personal→personal are never pairs.
// - The window is in NZ calendar days: the in half lands from
//   `DRAWING_DAYS_BEFORE` days before the out half to `DRAWING_DAYS_AFTER`
//   days after it, both included. After covers a Friday send posting on
//   Monday; before covers one bank's feed running ahead of the other's.
//   Equal weekly draws, seven days apart, never cross-match.
// - Pairing is one-to-one and greedy, so the answer never depends on input
//   order: of every pair in the window, the smallest absolute gap is taken
//   first, then a non-negative gap before a negative one, then the earlier
//   out date, the lower out id and the lower in id. A row already taken is
//   never taken again.
//
// The Sort screen (#259) must not list a drawing as uncategorised: run its
// rows through `effectiveCategory` (or `applyDrawings` with
// `loadDrawingIds`, server/db/drawings.ts) and test the result's category
// for null, never the stored column.
//
// Money is integer cents (M1 #8). This module must not import
// shared/safe-to-spend.ts, which imports it; its day arithmetic is its own.

import type { CategorySource, Cents, IsoDate, RowScope } from './contracts.ts'

/** The category a drawing shows, and the one Hannah can pick by hand. */
export const DRAWINGS_CATEGORY = 'Drawings'

/** The in half may land this many NZ days before the out half. */
export const DRAWING_DAYS_BEFORE = 1

/** The in half may land this many NZ days after the out half. */
export const DRAWING_DAYS_AFTER = 3

/** One row the matcher considers. Rows that cannot be a half are ignored. */
export interface DrawingCandidate {
  /** The transaction row id; unique across the candidates. */
  id: number
  /** The account's scope. */
  scope: RowScope
  /** The NZ calendar date, `YYYY-MM-DD`. */
  date: IsoDate
  /** Signed: negative is money out. */
  amountCents: Cents
}

/** A row's category and who set it, as the effective-category overlay sees it. */
export interface CategoryOnRow {
  category: string | null
  categorySource: CategorySource
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/**
 * Whole days from 1970-01-01 to a `YYYY-MM-DD` date. Built with
 * `setUTCFullYear`, never `Date.UTC`, which reads the years 0 to 99 as 1900
 * to 1999.
 */
function dayNumber(value: IsoDate, what: string): number {
  const match = ISO_DATE.exec(value)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month)
    ) {
      const d = new Date(0)
      d.setUTCFullYear(year, month - 1, day)
      return Math.round(d.getTime() / 86_400_000)
    }
  }
  throw new RangeError(
    `${what} must be a YYYY-MM-DD calendar date, got "${value}"`,
  )
}

interface Half {
  id: number
  day: number
}

interface Pair {
  out: Half
  in: Half
  gap: number
}

function pushTo(map: Map<number, Half[]>, key: number, half: Half): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [half])
  else list.push(half)
}

function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePairs(a: Pair, b: Pair): number {
  return (
    compareNumber(Math.abs(a.gap), Math.abs(b.gap)) ||
    // A non-negative gap (the in half on or after the out half) first.
    compareNumber(a.gap < 0 ? 1 : 0, b.gap < 0 ? 1 : 0) ||
    compareNumber(a.out.day, b.out.day) ||
    compareNumber(a.out.id, b.out.id) ||
    compareNumber(a.in.id, b.in.id)
  )
}

/**
 * The ids of every row that is one half of a drawing (prd-02 Ruling 15),
 * both halves. Every candidate is checked first, whether or not it could be
 * a half: a non-integer amount is a TypeError; a bad scope or date, or an id
 * that is not a safe integer or appears twice, a RangeError.
 */
export function findDrawingIds(
  candidates: readonly DrawingCandidate[],
): Set<number> {
  const seen = new Set<number>()
  const outsByAmount = new Map<number, Half[]>()
  const insByAmount = new Map<number, Half[]>()
  for (const c of candidates) {
    if (!Number.isSafeInteger(c.id)) {
      throw new RangeError(`a candidate id must be a safe integer, got ${c.id}`)
    }
    if (seen.has(c.id)) throw new RangeError(`candidate ${c.id} appears twice`)
    seen.add(c.id)
    if (!Number.isSafeInteger(c.amountCents)) {
      throw new TypeError(
        `amountCents of candidate ${c.id} must be an integer number of cents, got ${c.amountCents}`,
      )
    }
    if (c.scope !== 'personal' && c.scope !== 'strawb') {
      throw new RangeError(
        `scope of candidate ${c.id} must be personal or strawb, got "${String(c.scope)}"`,
      )
    }
    const half: Half = {
      id: c.id,
      day: dayNumber(c.date, `date of candidate ${c.id}`),
    }
    if (c.scope === 'strawb' && c.amountCents < 0) {
      pushTo(outsByAmount, -c.amountCents, half)
    } else if (c.scope === 'personal' && c.amountCents > 0) {
      pushTo(insByAmount, c.amountCents, half)
    }
  }

  const pairs: Pair[] = []
  for (const [amount, outs] of outsByAmount) {
    const ins = insByAmount.get(amount)
    if (ins === undefined) continue
    for (const out of outs) {
      for (const inHalf of ins) {
        const gap = inHalf.day - out.day
        if (gap < -DRAWING_DAYS_BEFORE || gap > DRAWING_DAYS_AFTER) continue
        pairs.push({ out, in: inHalf, gap })
      }
    }
  }
  pairs.sort(comparePairs)

  const ids = new Set<number>()
  for (const pair of pairs) {
    if (ids.has(pair.out.id) || ids.has(pair.in.id)) continue
    ids.add(pair.out.id)
    ids.add(pair.in.id)
  }
  return ids
}

/** The category is Drawings, whoever set it (prd-02 Ruling 15). */
export function isDrawingCategory(category: string | null): boolean {
  return category === DRAWINGS_CATEGORY
}

/**
 * The category a row shows and is counted by (prd-02 Ruling 15): Drawings,
 * set by `rule`, when the row is a half of a drawing and Hannah has not set
 * its category by hand; otherwise the row's own category and source. A
 * category Hannah set always wins, including Drawings on an unmatched row.
 */
export function effectiveCategory(
  row: CategoryOnRow,
  inDrawing: boolean,
): CategoryOnRow {
  if (inDrawing && row.categorySource !== 'user') {
    return { category: DRAWINGS_CATEGORY, categorySource: 'rule' }
  }
  return { category: row.category, categorySource: row.categorySource }
}

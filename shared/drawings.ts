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
// - Pairing is one-to-one and pairs as many rows as any pairing can, so a
//   closer neighbour never strands a drawing by taking its partner (#276).
// - Of all the pairings that pair that many, the answer is the one the
//   tie-breaks prefer pair by pair, so it never depends on input order. Walk
//   every pair in the window: the smallest absolute gap first, then a
//   non-negative gap before a negative one, then the earlier out date, the
//   lower out id and the lower in id. Take a pair when neither half is taken
//   and some largest pairing still holds it beside every pair taken before
//   it. Where plain greedy (take each pair whose halves are both free)
//   already pairs as many as possible, this takes exactly what greedy takes.
// - How, without listing pairs: per amount, rows on one day and side differ
//   only in their ids, so the walk runs on per-day counts and each day gives
//   up its lowest ids. Days too far apart to hold a pair split an amount into
//   independent runs. For each gap in tie-break order, out day ascending, the
//   step takes as many pairs as keep a largest pairing possible: a Hall
//   deficiency test (`RunWalk`), whose dynamic programs over days are
//   recomputed only within a window's reach of the day in hand. Cost: sorting
//   each amount's halves, then work linear in the days a run spans, times a
//   constant set by the window's width. Nothing grows as outs × ins.
//
// The Sort screen (#259) must not list a drawing as uncategorised: run its
// rows through `effectiveCategory` (or `applyDrawings` with
// `loadDrawingIds`, server/db/drawings.ts) and test the result's category
// for null, never the stored column.
//
// Money is integer cents (M1 #8). This module must not import
// shared/safe-to-spend.ts, which imports it; its day arithmetic is its own,
// and dates parse in shared/nz-dates.ts.

import type { CategorySource, Cents, IsoDate, RowScope } from './contracts.ts'
import type { CivilDate } from './nz-dates.ts'
import { parseIsoDate } from './nz-dates.ts'

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

/**
 * Whole days from 1970-01-01 to a `YYYY-MM-DD` date. Built with
 * `setUTCFullYear`, never `Date.UTC`, which reads the years 0 to 99 as 1900
 * to 1999.
 */
function dayNumber(value: IsoDate, what: string): number {
  let civil: CivilDate
  try {
    civil = parseIsoDate(value)
  } catch (error) {
    // parseIsoDate's text names a bill; this module keeps its own, which
    // names the field and echoes the value.
    if (error instanceof RangeError) {
      throw new RangeError(
        `${what} must be a YYYY-MM-DD calendar date, got "${value}"`,
      )
    }
    throw error
  }
  const d = new Date(0)
  d.setUTCFullYear(civil.year, civil.month - 1, civil.day)
  return Math.round(d.getTime() / 86_400_000)
}

interface Half {
  id: number
  day: number
}

/** Halves per day of one run, indexed from the run's first day. */
interface DayCounts {
  outs: Float64Array
  ins: Float64Array
}

/**
 * A stretch of days, per amount, holding every pair among its halves and no
 * pair with a half outside it. Its halves are sorted by day, then id.
 */
interface Run {
  first: number
  last: number
  outs: Half[]
  ins: Half[]
}

/** Out days this many days apart or more share no in day in their windows. */
const SPREAD = DRAWING_DAYS_BEFORE + DRAWING_DAYS_AFTER + 1

/** Two days further apart than this hold no pair between them. */
const REACH = Math.max(DRAWING_DAYS_BEFORE, DRAWING_DAYS_AFTER)

function pushTo(map: Map<number, Half[]>, key: number, half: Half): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [half])
  else list.push(half)
}

function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareHalves(a: Half, b: Half): number {
  return compareNumber(a.day, b.day) || compareNumber(a.id, b.id)
}

/**
 * Every gap in the window (in date − out date) in tie-break order: the
 * smaller absolute gap first, then a non-negative gap (the in half on or
 * after the out half) before a negative one.
 */
const GAP_ORDER: readonly number[] = Array.from(
  { length: SPREAD },
  (_, index) => index - DRAWING_DAYS_BEFORE,
).sort(
  (a, b) =>
    compareNumber(Math.abs(a), Math.abs(b)) ||
    compareNumber(a < 0 ? 1 : 0, b < 0 ? 1 : 0),
)

/** One amount's sorted halves, split wherever a gap between days is too wide to pair across. */
function splitIntoRuns(outs: readonly Half[], ins: readonly Half[]): Run[] {
  const runs: Run[] = []
  let current: Run | undefined
  let o = 0
  let i = 0
  while (o < outs.length || i < ins.length) {
    const isOut =
      i === ins.length || (o < outs.length && outs[o].day <= ins[i].day)
    const half = isOut ? outs[o++] : ins[i++]
    if (current === undefined || half.day - current.last > REACH) {
      current = { first: half.day, last: half.day, outs: [], ins: [] }
      runs.push(current)
    }
    current.last = half.day
    ;(isOut ? current.outs : current.ins).push(half)
  }
  return runs
}

/**
 * The tie-break walk over one run's per-day counts (prd-02 Ruling 15,
 * #276). Day p of the run is index p; an out on day p pairs with an in on
 * the days N(p), from p − `DRAWING_DAYS_BEFORE` to p + `DRAWING_DAYS_AFTER`.
 *
 * A step at gap g and out day D takes k pairs from D's outs to the ins on
 * t = D + g, the most that keep a largest pairing possible. By Hall's
 * theorem a largest pairing leaves `deficiency` outs unpaired: the most that
 * any set A of out days has in value(A) = outs on A − ins on N(A), or 0.
 * Taking k pairs adds k to value(A) when D is not in A but t is in N(A), and
 * leaves every other value as it was, so the step may take
 * min(outs left on D, ins left on t, deficiency − V), where V is the best
 * value of such a set. The deficiency never changes through the walk.
 *
 * V comes from a forward dynamic program (`ending[p]`, the best set whose
 * last day is p) and a backward one (`starting[p]`, the best set whose first
 * day is p); the best set holding p joins them at p. `ending` is kept as a
 * valid prefix and recomputed past a step. `starting` is computed at each
 * gap's start; steps run out day ascending, so it stays right above the
 * days the gap's steps have touched. A step recomputes only within a
 * window's reach of D.
 */
class RunWalk {
  private readonly length: number
  private readonly outsLeft: Float64Array
  private readonly insLeft: Float64Array
  private readonly ending: Float64Array
  /** The largest `ending` on any day up to p. */
  private readonly endingMax: Float64Array
  /** `ending` and `endingMax` are right on every day below this one. */
  private endingValid = 0
  /** `starting` as at the start of the gap in hand. */
  private readonly starting: Float64Array
  /** The largest `starting` on any day from p up. */
  private readonly startingMax: Float64Array
  /** Scratch for one step: `starting` with the step's current counts. */
  private readonly startingNow: Float64Array
  private readonly startingNowMax: Float64Array
  /** Scratch for one step: best sets that leave out the step's out day. */
  private readonly startingSkip: Float64Array
  private readonly endingSkip: Float64Array
  private readonly deficiency: number

  constructor(counts: DayCounts) {
    this.length = counts.outs.length
    this.outsLeft = counts.outs.slice()
    this.insLeft = counts.ins.slice()
    this.ending = new Float64Array(this.length)
    this.endingMax = new Float64Array(this.length)
    this.starting = new Float64Array(this.length)
    this.startingMax = new Float64Array(this.length)
    this.startingNow = new Float64Array(this.length)
    this.startingNowMax = new Float64Array(this.length)
    this.startingSkip = new Float64Array(this.length)
    this.endingSkip = new Float64Array(this.length)
    this.extendEnding(this.length - 1)
    this.deficiency = Math.max(0, this.endingMax[this.length - 1])
  }

  /** How many outs and ins on each day the walk pairs. */
  run(): DayCounts {
    const taken: DayCounts = {
      outs: new Float64Array(this.length),
      ins: new Float64Array(this.length),
    }
    for (const gap of GAP_ORDER) {
      this.restartGap()
      for (let outDay = 0; outDay < this.length; outDay += 1) {
        const inDay = outDay + gap
        if (inDay < 0 || inDay >= this.length) continue
        if (this.outsLeft[outDay] === 0 || this.insLeft[inDay] === 0) continue
        const k = Math.min(
          this.outsLeft[outDay],
          this.insLeft[inDay],
          this.deficiency - this.bestAround(outDay, inDay),
        )
        if (k <= 0) continue
        this.outsLeft[outDay] -= k
        this.insLeft[inDay] -= k
        taken.outs[outDay] += k
        taken.ins[inDay] += k
        // ending[p] reads outs up to p and ins up to p + DRAWING_DAYS_AFTER;
        // inDay − AFTER is never past outDay, so it bounds both changes.
        this.endingValid = Math.min(
          this.endingValid,
          Math.max(0, inDay - DRAWING_DAYS_AFTER),
        )
      }
    }
    return taken
  }

  /** Ins left on the days from `from` to `to`, both included. */
  private insOn(from: number, to: number): number {
    let sum = 0
    const last = Math.min(to, this.length - 1)
    for (let day = Math.max(from, 0); day <= last; day += 1) {
      sum += this.insLeft[day]
    }
    return sum
  }

  /** value({p}): the outs left on p against the ins left in N(p). */
  private own(p: number): number {
    return (
      this.outsLeft[p] -
      this.insOn(p - DRAWING_DAYS_BEFORE, p + DRAWING_DAYS_AFTER)
    )
  }

  /**
   * The best set whose last day is p, given the best set ending on each
   * earlier day (`at`) and the running maximum of those (`maxUpTo`). A set
   * ending on q at least `SPREAD` days earlier shares no in day with N(p);
   * a nearer one shares the ins from p − BEFORE to q + AFTER, counted once.
   */
  private endingAt(
    p: number,
    at: (q: number) => number,
    maxUpTo: (q: number) => number,
  ): number {
    let best = 0
    if (p - SPREAD >= 0) best = Math.max(best, maxUpTo(p - SPREAD))
    for (let q = Math.max(p - SPREAD + 1, 0); q < p; q += 1) {
      const shared = this.insOn(p - DRAWING_DAYS_BEFORE, q + DRAWING_DAYS_AFTER)
      best = Math.max(best, at(q) + shared)
    }
    return this.own(p) + best
  }

  /** `endingAt`'s mirror: the best set whose first day is p. */
  private startingAt(
    p: number,
    at: (q: number) => number,
    maxFrom: (q: number) => number,
  ): number {
    let best = 0
    if (p + SPREAD < this.length) best = Math.max(best, maxFrom(p + SPREAD))
    const last = Math.min(p + SPREAD - 1, this.length - 1)
    for (let q = p + 1; q <= last; q += 1) {
      const shared = this.insOn(q - DRAWING_DAYS_BEFORE, p + DRAWING_DAYS_AFTER)
      best = Math.max(best, at(q) + shared)
    }
    return this.own(p) + best
  }

  private extendEnding(to: number): void {
    for (; this.endingValid <= to; this.endingValid += 1) {
      const p = this.endingValid
      this.ending[p] = this.endingAt(
        p,
        (q) => this.ending[q],
        (q) => this.endingMax[q],
      )
      this.endingMax[p] =
        p === 0
          ? this.ending[p]
          : Math.max(this.endingMax[p - 1], this.ending[p])
    }
  }

  private restartGap(): void {
    for (let p = this.length - 1; p >= 0; p -= 1) {
      this.starting[p] = this.startingAt(
        p,
        (q) => this.starting[q],
        (q) => this.startingMax[q],
      )
      this.startingMax[p] =
        p === this.length - 1
          ? this.starting[p]
          : Math.max(this.startingMax[p + 1], this.starting[p])
    }
  }

  /**
   * V: the best value of a set of out days that leaves out `outDay` and
   * whose windows hold `inDay`, with the counts as they are now.
   */
  private bestAround(outDay: number, inDay: number): number {
    this.extendEnding(outDay - 1)
    // The out days whose window holds inDay.
    const low = Math.max(0, inDay - DRAWING_DAYS_AFTER)
    const high = Math.min(this.length - 1, inDay + DRAWING_DAYS_BEFORE)

    // This gap's earlier steps took outs below outDay and ins below inDay,
    // and starting[q] reads outs from q and ins from q − BEFORE: from
    // `fresh` up it is still right. Keep the inDay term: with today's
    // BEFORE no test fails without it, but with a wider BEFORE the walk
    // then reads stale values and pairs wrongly.
    const fresh = Math.max(outDay, inDay + DRAWING_DAYS_BEFORE)
    const startNow = (q: number): number =>
      q >= fresh ? this.starting[q] : this.startingNow[q]
    const startNowMax = (q: number): number =>
      q >= fresh ? this.startingMax[q] : this.startingNowMax[q]
    for (let q = Math.min(fresh, this.length) - 1; q > outDay; q -= 1) {
      this.startingNow[q] = this.startingAt(q, startNow, startNowMax)
      this.startingNowMax[q] =
        q + 1 < this.length
          ? Math.max(this.startingNow[q], startNowMax(q + 1))
          : this.startingNow[q]
    }

    // Sets that leave out outDay. Below it, a set ending there never holds
    // it; above it, a set starting there never does.
    const startSkip = (q: number): number =>
      q < outDay
        ? this.startingSkip[q]
        : q === outDay
          ? Number.NEGATIVE_INFINITY
          : startNow(q)
    for (let q = outDay - 1; q >= low; q -= 1) {
      this.startingSkip[q] = this.startingAt(q, startSkip, startNowMax)
    }
    const endSkip = (q: number): number =>
      q < outDay
        ? this.ending[q]
        : q === outDay
          ? Number.NEGATIVE_INFINITY
          : this.endingSkip[q]
    for (let p = outDay + 1; p <= high; p += 1) {
      this.endingSkip[p] = this.endingAt(p, endSkip, (q) => this.endingMax[q])
    }

    let best = Number.NEGATIVE_INFINITY
    for (let p = low; p <= high; p += 1) {
      if (p === outDay) continue
      const left = p < outDay ? this.ending[p] : this.endingSkip[p]
      const right = p < outDay ? this.startingSkip[p] : startNow(p)
      best = Math.max(best, left + right - this.own(p))
    }
    return best
  }
}

/** Adds the ids of one run's paired halves to `ids`. */
function addRunDrawingIds(run: Run, ids: Set<number>): void {
  if (run.outs.length === 0 || run.ins.length === 0) return
  const length = run.last - run.first + 1
  const counts: DayCounts = {
    outs: new Float64Array(length),
    ins: new Float64Array(length),
  }
  for (const half of run.outs) counts.outs[half.day - run.first] += 1
  for (const half of run.ins) counts.ins[half.day - run.first] += 1
  const taken = new RunWalk(counts).run()
  // Each day gives up its lowest ids: a run's halves are sorted by day, then id.
  for (const half of run.outs) {
    const p = half.day - run.first
    if (taken.outs[p] === 0) continue
    taken.outs[p] -= 1
    ids.add(half.id)
  }
  for (const half of run.ins) {
    const p = half.day - run.first
    if (taken.ins[p] === 0) continue
    taken.ins[p] -= 1
    ids.add(half.id)
  }
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

  const ids = new Set<number>()
  for (const [amount, outs] of outsByAmount) {
    const ins = insByAmount.get(amount)
    if (ins === undefined) continue
    outs.sort(compareHalves)
    ins.sort(compareHalves)
    for (const run of splitIntoRuns(outs, ins)) addRunDrawingIds(run, ids)
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

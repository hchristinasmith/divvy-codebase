import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { validateChartSpec } from '../../../../models/insights.ts'
import {
  OTHER_CATEGORIES,
  cleanLabel,
  collectAggregates,
  excludeTransfers,
  isoWeekOf,
  lastCompleteWeek,
  loadLedger,
  monthsEnding,
  nzCalendarDate,
  spendByCategoryPerMonth,
  topMerchants,
  unusualSpends,
  weekOverWeek,
  weekRange,
  type LedgerRow,
} from '../queries.ts'

// The insights agent's typed queries (#47; prd-04 Rulings 3, 7 and 8). Each
// test starts from an empty, freshly migrated in-memory database and inserts
// the rows it needs; every merchant, account and amount is invented.
//
// The database totals are checked against hand-written knex queries that
// bound NZ days with explicit UTC instants, so the oracle shares no date code
// with the module under test.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  seq = 0
})

afterAll(async () => {
  await connection.destroy()
})

const STAMP = '2026-10-01T00:00:00.000Z'
const WEEK = '2026-W43' // Monday 2026-10-19 to Sunday 2026-10-25, NZDT (UTC+13)

// UTC midnight of a date is noon or 1pm that same date in Auckland.
const day = (date: string) => `${date}T00:00:00.000Z`

async function seedAccounts(): Promise<void> {
  const account = (akahuId: string, scope: string, source = 'akahu') => ({
    akahu_id: akahuId,
    source,
    scope,
    name: 'Invented account',
    created_at: STAMP,
    updated_at: STAMP,
  })
  await connection('accounts').insert([
    account('acc_p1', 'personal'),
    account('acc_p2', 'personal'),
    account('acc_s1', 'strawb'),
    account('acc_x1', 'personal', 'xero'),
  ])
}

interface Tx {
  account?: string
  at: string | null
  cents: number | null
  merchant?: string | null
  category?: string | null
  status?: 'settled' | 'pending'
  source?: 'akahu' | 'xero'
  categorySource?: 'akahu' | 'user'
}

let seq = 0

async function tx(t: Tx): Promise<number> {
  seq += 1
  const [id] = await connection('transactions').insert({
    akahu_id: `trans_fixture_${seq}`,
    account_id: t.account ?? 'acc_p1',
    date: t.at,
    amount_cents: t.cents,
    merchant_name: t.merchant ?? null,
    category: t.category ?? null,
    category_source: t.categorySource ?? 'akahu',
    status: t.status ?? 'settled',
    source: t.source ?? 'akahu',
    description: 'SENTINEL DESC card 1234',
    reference: 'SENTINEL REF',
    particulars: 'SENTINEL PART',
    code: 'SENTINEL CODE',
  })
  return id
}

const PERSONAL_SENTINEL = { merchant: 'Personal Only Bakery', cents: 66666 }
const STRAWB_SENTINEL = { merchant: 'Strawb Only Supplies', cents: 55555 }

// The personal ledger every database test below shares. Returns the ids of
// the transfer legs, which the oracle leaves out by id.
async function seedLedger(): Promise<number[]> {
  await seedAccounts()
  const transferIds: number[] = []
  const rows: Tx[] = [
    // The week.
    { at: day('2026-10-19'), cents: -1250, merchant: 'Fixture Bakery', category: 'Cafes' },
    { at: day('2026-10-20'), cents: -4500, merchant: 'Invented Grocer', category: 'Groceries' },
    { at: day('2026-10-22'), cents: -3200, merchant: 'Invented Grocer', category: 'Groceries' },
    { at: day('2026-10-23'), cents: -6000, merchant: 'Sample Fuel', category: 'Fuel' },
    { at: day('2026-10-21'), cents: 150000, merchant: 'Invented Employer', category: 'Income' },
    { at: day('2026-10-25'), cents: -800, merchant: null, category: null },
    { at: day('2026-10-21'), cents: -PERSONAL_SENTINEL.cents, merchant: PERSONAL_SENTINEL.merchant, category: 'Cafes' },
    // NZ day boundaries of the week.
    { at: '2026-10-18T10:59:00.000Z', cents: -999, merchant: 'Example Books', category: 'Books' },
    { at: '2026-10-18T11:00:00.000Z', cents: -777, merchant: 'Example Books', category: 'Books' },
    { at: '2026-10-25T10:59:00.000Z', cents: -333, merchant: 'Mock Hardware', category: 'Hardware' },
    { at: '2026-10-25T11:00:00.000Z', cents: -444, merchant: 'Mock Hardware', category: 'Hardware' },
    // A strawb inflow of the same cents the same day: another scope, so it
    // cannot cancel this outflow.
    { at: day('2026-10-20'), cents: -2500, merchant: 'Placeholder Cafe', category: 'Cafes' },
    { account: 'acc_s1', at: day('2026-10-20'), cents: 2500, merchant: 'Strawb Customer', category: 'Sales' },
    // Strawb spend.
    { account: 'acc_s1', at: day('2026-10-20'), cents: -STRAWB_SENTINEL.cents, merchant: STRAWB_SENTINEL.merchant, category: 'Supplies' },
    // The week before.
    { at: day('2026-10-13'), cents: -1000, merchant: 'Fixture Bakery', category: 'Cafes' },
    { at: day('2026-10-14'), cents: -5000, merchant: 'Invented Grocer', category: 'Groceries' },
    // Sample Fuel's history in the lookback.
    { at: day('2026-09-01'), cents: -1500, merchant: 'Sample Fuel', category: 'Fuel' },
    { at: day('2026-09-15'), cents: -1600, merchant: 'Sample Fuel', category: 'Fuel' },
    { at: day('2026-10-06'), cents: -1700, merchant: 'Sample Fuel', category: 'Fuel' },
    // Earlier months, and the NZ month boundaries (NZST, UTC+12, until
    // 2026-09-27).
    { at: day('2026-05-10'), cents: -2500, merchant: 'Invented Grocer', category: 'Groceries' },
    { at: day('2026-07-15'), cents: -3000, merchant: 'Sample Fuel', category: 'Fuel' },
    { at: day('2026-09-28'), cents: -1800, merchant: 'Placeholder Cafe', category: 'Cafes' },
    { at: '2026-04-30T12:00:00.000Z', cents: -1111, merchant: 'Example Books', category: 'Books' },
    { at: '2026-04-30T11:59:00.000Z', cents: -2222, merchant: 'Example Books', category: 'Books' },
    { at: '2026-09-30T10:59:00.000Z', cents: -1234, merchant: 'Mock Hardware', category: 'Hardware' },
    { at: '2026-09-30T11:00:00.000Z', cents: -4321, merchant: 'Mock Hardware', category: 'Hardware' },
    // Rows the ledger never reads.
    { at: day('2026-10-20'), cents: -11111, merchant: 'Excluded Pending', status: 'pending' },
    { at: day('2026-10-20'), cents: -22222, merchant: 'Excluded Xero', source: 'xero' },
    { account: 'acc_missing', at: day('2026-10-20'), cents: -33333, merchant: 'Excluded Unstored' },
    { account: 'acc_x1', at: day('2026-10-20'), cents: -12121, merchant: 'Excluded Xero Account' },
    { at: null, cents: -44444, merchant: 'Excluded Undated' },
    { at: day('2026-10-20'), cents: null, merchant: 'Excluded Null Amount' },
  ]
  for (const row of rows) await tx(row)
  // A transfer between the two personal accounts, inside the week.
  transferIds.push(await tx({ at: day('2026-10-24'), cents: -20000, category: 'Transfers' }))
  transferIds.push(await tx({ account: 'acc_p2', at: day('2026-10-24'), cents: 20000, category: 'Transfers' }))
  // A transfer whose inflow posts the Monday after the week: it pairs only
  // because the ledger is read wider than the week.
  transferIds.push(
    await tx({ at: '2026-10-25T05:00:00.000Z', cents: -7000, merchant: 'Invented Transfer', category: 'Transfers' }),
  )
  transferIds.push(
    await tx({ account: 'acc_p2', at: day('2026-10-26'), cents: 7000, merchant: 'Invented Transfer', category: 'Transfers' }),
  )
  return transferIds
}

// Drawings (prd-02 Ruling 15), laid over seedLedger: strawb outflows and
// the personal inflows that match them. Returns the ids the oracle leaves
// out: both halves of every drawing and every row categorised Drawings.
async function seedDrawings(): Promise<number[]> {
  const excluded: number[] = []
  const owner = { merchant: 'Owner Pay Fixture', category: 'Transfers' }
  // Owner Pay Fixture's strawb history: three small outflows no personal
  // inflow matches, so its drawing this week would be unusual if counted.
  for (const at of ['2026-09-01', '2026-09-08', '2026-09-15']) {
    await tx({ account: 'acc_s1', at: day(at), cents: -1000, ...owner })
  }
  // A drawing in the week: out on Tuesday, in on Wednesday.
  excluded.push(await tx({ account: 'acc_s1', at: day('2026-10-20'), cents: -30000, ...owner }))
  excluded.push(await tx({ at: day('2026-10-21'), cents: 30000, ...owner }))
  // The week before, the in half four days after the out half: past
  // DRAWING_DAYS_AFTER, so not a drawing, and the outflow is strawb spend.
  await tx({ account: 'acc_s1', at: day('2026-10-14'), cents: -40000, ...owner })
  await tx({ at: day('2026-10-18'), cents: 40000, ...owner })
  // A drawing whose strawb half Hannah categorised by hand: it counts, under
  // her category.
  await tx({ account: 'acc_s1', at: day('2026-10-22'), cents: -35000, merchant: 'Hand Sorted Fixture', category: 'Equipment', categorySource: 'user' })
  excluded.push(await tx({ at: day('2026-10-22'), cents: 35000, merchant: 'Hand Sorted Fixture', category: 'Transfers' }))
  // A drawing whose in half is still pending: the matcher reads pending rows.
  excluded.push(await tx({ account: 'acc_s1', at: day('2026-10-23'), cents: -12345, merchant: 'Pending Partner Fixture', category: 'Transfers' }))
  excluded.push(await tx({ at: day('2026-10-24'), cents: 12345, merchant: 'Pending Partner Fixture', status: 'pending' }))
  // A drawing out on the Sunday whose in half lands three days later, past
  // the ledger's read window: only an all-time candidate read finds it.
  excluded.push(await tx({ account: 'acc_s1', at: day('2026-10-25'), cents: -45600, merchant: 'Edge Partner Fixture', category: 'Transfers' }))
  excluded.push(await tx({ at: day('2026-10-28'), cents: 45600, merchant: 'Edge Partner Fixture' }))
  // Rows Hannah categorised Drawings by hand, with no partner: never spend.
  excluded.push(await tx({ at: day('2026-10-20'), cents: -2700, merchant: 'Hand Drawings Fixture', category: 'Drawings', categorySource: 'user' }))
  excluded.push(await tx({ account: 'acc_s1', at: day('2026-10-21'), cents: -1900, merchant: 'Hand Drawings Strawb', category: 'Drawings', categorySource: 'user' }))
  return excluded
}

// seedLedger and seedDrawings together; the ids the oracle leaves out.
async function seedWithDrawings(): Promise<number[]> {
  const transferIds = await seedLedger()
  return [...transferIds, ...(await seedDrawings())]
}

// ---- The oracle: hand-written knex, explicit UTC instants ----

// NZ midnight at the start of each day named, as a UTC instant.
const NZ_WEEK = { start: '2026-10-18T11:00:00.000Z', end: '2026-10-25T10:59:59.999Z' }
const NZ_LAST_WEEK = { start: '2026-10-11T11:00:00.000Z', end: '2026-10-18T10:59:59.999Z' }
const NZ_MONTHS: [string, string, string][] = [
  ['2026-05', '2026-04-30T12:00:00.000Z', '2026-05-31T11:59:59.999Z'],
  ['2026-06', '2026-05-31T12:00:00.000Z', '2026-06-30T11:59:59.999Z'],
  ['2026-07', '2026-06-30T12:00:00.000Z', '2026-07-31T11:59:59.999Z'],
  ['2026-08', '2026-07-31T12:00:00.000Z', '2026-08-31T11:59:59.999Z'],
  ['2026-09', '2026-08-31T12:00:00.000Z', '2026-09-30T10:59:59.999Z'],
  // Ends at the week's Sunday: nothing after it is counted.
  ['2026-10', '2026-09-30T11:00:00.000Z', '2026-10-25T10:59:59.999Z'],
]

function scopeSpend(scope: 'personal' | 'strawb', from: string, to: string, excludedIds: number[]) {
  return connection('transactions as t')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'a.scope': scope, 'a.source': 'akahu', 't.source': 'akahu', 't.status': 'settled' })
    .where('t.amount_cents', '<', 0)
    .whereBetween('t.date', [from, to])
    .whereNotIn('t.id', excludedIds)
}

async function oracleBy(
  column: 'merchant_name' | 'category',
  from: string,
  to: string,
  excludedIds: number[],
  scope: 'personal' | 'strawb' = 'personal',
): Promise<Map<string, { spend: number; count: number }>> {
  const rows: { label: string | null; total: number; n: number }[] = await scopeSpend(scope, from, to, excludedIds)
    .select({ label: `t.${column}` })
    .sum({ total: 't.amount_cents' })
    .count({ n: 't.id' })
    .groupBy(`t.${column}`)
  const fallback = column === 'merchant_name' ? 'Unknown merchant' : 'Uncategorised'
  return new Map(rows.map((r) => [r.label ?? fallback, { spend: -r.total, count: Number(r.n) }]))
}

const bySpend = <T extends { spend: number; label: string }>(a: T, b: T) =>
  b.spend - a.spend || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)

describe('collectAggregates against the hand-written oracle', () => {
  it('top merchants equal the oracle to the cent', async () => {
    const excludedIds = await seedWithDrawings()
    const a = await collectAggregates('personal', WEEK)
    const oracle = [...(await oracleBy('merchant_name', NZ_WEEK.start, NZ_WEEK.end, excludedIds))]
      .map(([label, v]) => ({ label, ...v }))
      .sort(bySpend)
      .map((m) => ({ merchant: m.label, spendCents: m.spend, count: m.count }))
    expect(a.topMerchants).toStrictEqual(oracle.slice(0, 5))
    // Uncapped, so the Sunday 23:59 and Unknown merchant rows are compared too.
    const ledger = excludeTransfers(await loadLedger('personal', '2026-10-17', '2026-10-27'))
    expect(topMerchants(ledger, WEEK, 50)).toStrictEqual(oracle)
    // The fixture is what the oracle says it is.
    expect(a.topMerchants.map((m) => m.spendCents)).toEqual([66666, 7700, 6000, 2500, 1250])
  })

  it('week over week equals the oracle to the cent, per category and in total', async () => {
    const excludedIds = await seedWithDrawings()
    const a = await collectAggregates('personal', WEEK)
    const now = await oracleBy('category', NZ_WEEK.start, NZ_WEEK.end, excludedIds)
    const then = await oracleBy('category', NZ_LAST_WEEK.start, NZ_LAST_WEEK.end, excludedIds)
    const categories = [...new Set([...now.keys(), ...then.keys()])]
    const expected = categories
      .map((category) => {
        const thisCents = now.get(category)?.spend ?? 0
        const lastCents = then.get(category)?.spend ?? 0
        return { category, thisCents, lastCents, changeCents: thisCents - lastCents }
      })
      .sort(
        (x, y) =>
          Math.abs(y.changeCents) - Math.abs(x.changeCents) ||
          (x.category < y.category ? -1 : x.category > y.category ? 1 : 0),
      )
    const thisWeek = [...now.values()].reduce((s, v) => s + v.spend, 0)
    const lastWeek = [...then.values()].reduce((s, v) => s + v.spend, 0)

    expect(a.wow.byCategory).toStrictEqual(expected)
    expect(a.wow.thisWeekCents).toBe(thisWeek)
    expect(a.wow.lastWeekCents).toBe(lastWeek)
    expect(a.wow.changeCents).toBe(thisWeek - lastWeek)
    expect([thisWeek, lastWeek]).toEqual([86026, 6999])
  })

  it('monthly spend per category equals the oracle to the cent, over NZ months', async () => {
    const excludedIds = await seedWithDrawings()
    const a = await collectAggregates('personal', WEEK)
    const expected: { month: string; category: string; spendCents: number }[] = []
    for (const [month, from, to] of NZ_MONTHS) {
      const cells = [...(await oracleBy('category', from, to, excludedIds))]
        .map(([label, v]) => ({ label, spend: v.spend }))
        .sort(bySpend)
      for (const c of cells) expected.push({ month, category: c.label, spendCents: c.spend })
    }
    expect(a.months).toEqual(NZ_MONTHS.map(([m]) => m))
    expect(a.monthly).toStrictEqual(expected)
    // 1111 is 1 May in NZ; 2222 is 30 April and outside; 4321 is 1 October.
    const books = a.monthly.filter((c) => c.category === 'Books')
    expect(books).toContainEqual({ month: '2026-05', category: 'Books', spendCents: 1111 })
    expect(a.monthly).toContainEqual({ month: '2026-09', category: 'Hardware', spendCents: 1234 })
  })

  it('the unusual spend is the merchant well above its median, and the counts and dates are the week’s', async () => {
    await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    expect(a.unusual).toStrictEqual([
      { date: '2026-10-23', merchant: 'Sample Fuel', category: 'Fuel', amountCents: 6000, typicalCents: 1600 },
    ])
    expect(Object.keys(a).sort()).toEqual(
      ['asOf', 'ledgerRowCount', 'monthly', 'months', 'topMerchants', 'unusual', 'week', 'wow'].sort(),
    )
    expect(a.week).toBe(WEEK)
    expect(a.asOf).toBe('2026-10-25')
  })

  it('ledgerRowCount is every row read for the window, transfers and inflows included', async () => {
    await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    const [{ n }] = await connection('transactions as t')
      .join('accounts as a', 't.account_id', 'a.akahu_id')
      .where({ 'a.scope': 'personal', 'a.source': 'akahu', 't.source': 'akahu', 't.status': 'settled' })
      .whereNotNull('t.amount_cents')
      .whereBetween('t.date', ['2026-04-30T12:00:00.000Z', NZ_WEEK.end])
      .count({ n: '*' })
    expect(a.ledgerRowCount).toBe(Number(n))
  })

  it('a transfer leg posted after the Sunday still pairs, because the ledger is read wider', async () => {
    await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    expect(a.topMerchants.map((m) => m.merchant)).not.toContain('Invented Transfer')
    // Read for the week alone, the same outflow has no partner.
    const narrow = excludeTransfers(await loadLedger('personal', '2026-10-19', '2026-10-25'))
    expect(topMerchants(narrow, WEEK, 50).map((m) => m.merchant)).toContain('Invented Transfer')
  })

  it('a strawb inflow of equal cents does not cancel a personal outflow', async () => {
    await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    expect(a.topMerchants).toContainEqual({ merchant: 'Placeholder Cafe', spendCents: 2500, count: 1 })
  })
})

describe('drawings (prd-02 Ruling 15)', () => {
  // Every SQL statement run while `fn` runs, with its bindings.
  async function queriesDuring(fn: () => Promise<unknown>): Promise<{ sql: string; bindings: unknown[] }[]> {
    const seen: { sql: string; bindings: unknown[] }[] = []
    const listener = (q: { sql: string; bindings?: unknown[] }) => seen.push({ sql: q.sql, bindings: q.bindings ?? [] })
    connection.on('query', listener)
    try {
      await fn()
    } finally {
      connection.removeListener('query', listener)
    }
    return seen
  }

  it('strawb top merchants, week over week and monthly equal the oracle with drawings left out, to the cent', async () => {
    const excludedIds = await seedWithDrawings()
    const a = await collectAggregates('strawb', WEEK)

    const merchants = [...(await oracleBy('merchant_name', NZ_WEEK.start, NZ_WEEK.end, excludedIds, 'strawb'))]
      .map(([label, v]) => ({ label, ...v }))
      .sort(bySpend)
      .map((m) => ({ merchant: m.label, spendCents: m.spend, count: m.count }))
    expect(a.topMerchants).toStrictEqual(merchants)
    expect(a.topMerchants).toStrictEqual([
      { merchant: STRAWB_SENTINEL.merchant, spendCents: STRAWB_SENTINEL.cents, count: 1 },
      { merchant: 'Hand Sorted Fixture', spendCents: 35000, count: 1 },
    ])

    const now = await oracleBy('category', NZ_WEEK.start, NZ_WEEK.end, excludedIds, 'strawb')
    const then = await oracleBy('category', NZ_LAST_WEEK.start, NZ_LAST_WEEK.end, excludedIds, 'strawb')
    const sum = (m: Map<string, { spend: number }>) => [...m.values()].reduce((t, v) => t + v.spend, 0)
    expect([a.wow.thisWeekCents, a.wow.lastWeekCents]).toEqual([sum(now), sum(then)])
    expect([a.wow.thisWeekCents, a.wow.lastWeekCents]).toEqual([90555, 40000])

    const monthly: { month: string; category: string; spendCents: number }[] = []
    for (const [month, from, to] of NZ_MONTHS) {
      const cells = [...(await oracleBy('category', from, to, excludedIds, 'strawb'))]
        .map(([label, v]) => ({ label, spend: v.spend }))
        .sort(bySpend)
      for (const c of cells) monthly.push({ month, category: c.label, spendCents: c.spend })
    }
    expect(a.monthly).toStrictEqual(monthly)
  })

  it('a strawb outflow matched by a personal inflow of equal cents is not strawb spend, nor unusual', async () => {
    await seedWithDrawings()
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants.map((m) => m.merchant)).not.toContain('Owner Pay Fixture')
    // Transfers this week are only drawings; last week's is the unmatched 40000.
    expect(a.wow.byCategory).toContainEqual({ category: 'Transfers', thisCents: 0, lastCents: 40000, changeCents: -40000 })
    expect(a.monthly).toContainEqual({ month: '2026-10', category: 'Transfers', spendCents: 40000 })
    // Owner Pay Fixture has three 1000 outflows of history: the 30000 drawing
    // would be flagged if it were spend.
    expect(a.unusual).toEqual([])
  })

  it('an in half further from the out half than the drawing window allows leaves the outflow as spend', async () => {
    await seedWithDrawings()
    const a = await collectAggregates('strawb', '2026-W42')
    expect(a.topMerchants).toContainEqual({ merchant: 'Owner Pay Fixture', spendCents: 40000, count: 1 })
  })

  it('a drawing half Hannah categorised by hand counts, under her category', async () => {
    await seedWithDrawings()
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants).toContainEqual({ merchant: 'Hand Sorted Fixture', spendCents: 35000, count: 1 })
    expect(a.wow.byCategory).toContainEqual({ category: 'Equipment', thisCents: 35000, lastCents: 0, changeCents: 35000 })
  })

  it('a pending in half still makes a drawing, as the matcher reads pending rows', async () => {
    await seedWithDrawings()
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants.map((m) => m.merchant)).not.toContain('Pending Partner Fixture')
  })

  it('an in half past the ledger read window still makes a drawing: the candidates are all-time', async () => {
    await seedWithDrawings()
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants.map((m) => m.merchant)).not.toContain('Edge Partner Fixture')
  })

  it('a row categorised Drawings by hand is never spend, in either scope', async () => {
    await seedWithDrawings()
    const personal = await collectAggregates('personal', WEEK)
    const strawb = await collectAggregates('strawb', WEEK)
    expect(personal.topMerchants.map((m) => m.merchant)).not.toContain('Hand Drawings Fixture')
    expect(strawb.topMerchants.map((m) => m.merchant)).not.toContain('Hand Drawings Strawb')
    const ledger = await loadLedger('personal', '2026-10-19', '2026-10-25')
    expect(ledger.map((r) => r.merchant)).not.toContain('Hand Drawings Fixture')
    expect(ledger.map((r) => r.category)).not.toContain('Drawings')
  })

  it('only a raw category of exactly Drawings is one: the check runs before cleaning', async () => {
    await seedAccounts()
    // Cleaned, both read "Drawings"; neither is, as shared/drawings.ts reads them.
    await tx({ at: day('2026-10-20'), cents: -2100, merchant: 'Near Drawings Colon', category: 'Drawings:' })
    await tx({ at: day('2026-10-20'), cents: -2200, merchant: 'Near Drawings Space', category: ' Drawings', categorySource: 'user' })
    const ledger = await loadLedger('personal', '2026-10-19', '2026-10-25')
    expect(ledger.map((r) => [r.merchant, r.category])).toEqual([
      ['Near Drawings Space', 'Drawings'],
      ['Near Drawings Colon', 'Drawings'],
    ])
  })

  it('a drawing is dropped before transfers pair, so it never takes a same-scope leg', async () => {
    await seedWithDrawings()
    // A second strawb account, and an inflow on it equal to the drawing's out
    // half the same day: had the out half reached the pairing, both would go.
    await connection('accounts').insert({
      akahu_id: 'acc_s2',
      source: 'akahu',
      scope: 'strawb',
      name: 'Invented account',
      created_at: STAMP,
      updated_at: STAMP,
    })
    await tx({ account: 'acc_s2', at: day('2026-10-20'), cents: 30000, merchant: 'Strawb Refund Fixture', category: 'Sales' })
    const rows = excludeTransfers(await loadLedger('strawb', '2026-10-19', '2026-10-25'))
    expect(rows.map((r) => r.amountCents)).toContain(30000)
    expect(rows.map((r) => r.amountCents)).not.toContain(-30000)
  })

  it('ledgerRowCount counts drawing rows, as it counts transfer legs', async () => {
    await seedWithDrawings()
    for (const scope of ['personal', 'strawb'] as const) {
      const a = await collectAggregates(scope, WEEK)
      const [{ n }] = await connection('transactions as t')
        .join('accounts as a', 't.account_id', 'a.akahu_id')
        .where({ 'a.scope': scope, 'a.source': 'akahu', 't.source': 'akahu', 't.status': 'settled' })
        .whereNotNull('t.amount_cents')
        .whereBetween('t.date', ['2026-04-30T12:00:00.000Z', NZ_WEEK.end])
        .count({ n: '*' })
      expect(a.ledgerRowCount, scope).toBe(Number(n))
    }
  })

  it('a personal run makes no read that names strawb, and no drawings candidate read', async () => {
    await seedWithDrawings()
    const seen = await queriesDuring(() => collectAggregates('personal', WEEK))
    expect(seen.length).toBeGreaterThan(0)
    for (const q of seen) {
      expect(q.bindings, q.sql).not.toContain('strawb')
      expect(q.sql).not.toContain('strawb')
      expect(q.bindings, q.sql).toContain('personal')
    }
  })

  it('a strawb run reads personal rows only for id, scope, date and amount', async () => {
    await seedWithDrawings()
    const seen = await queriesDuring(() => collectAggregates('strawb', WEEK))
    const personal = seen.filter((q) => q.bindings.includes('personal'))
    expect(personal).toHaveLength(1)
    const [{ sql }] = personal
    const selected = sql.slice(sql.indexOf('select') + 'select'.length, sql.indexOf(' from ')).trim()
    expect(selected).toBe('`t`.`id`, `a`.`scope`, `t`.`date`, `t`.`amount_cents`')
  })
})

describe('loadLedger', () => {
  it('a personal read holds no strawb row', async () => {
    await seedLedger()
    const rows = await loadLedger('personal', '2026-05-01', '2026-10-25')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => r.merchant)).not.toContain(STRAWB_SENTINEL.merchant)
    expect(rows.map((r) => r.merchant)).not.toContain('Strawb Customer')
    expect(rows.map((r) => r.amountCents)).not.toContain(-STRAWB_SENTINEL.cents)
    expect(new Set(rows.map((r) => r.accountId))).toEqual(new Set(['acc_p1', 'acc_p2']))
  })

  it('a strawb read holds only strawb rows', async () => {
    await seedLedger()
    const rows = await loadLedger('strawb', '2026-05-01', '2026-10-25')
    expect(rows.map((r) => r.merchant).sort()).toEqual([STRAWB_SENTINEL.merchant, 'Strawb Customer'].sort())
    expect(rows.map((r) => r.amountCents)).not.toContain(-PERSONAL_SENTINEL.cents)
  })

  it('leaves out pending, xero, unstored-account, xero-account, undated and amountless rows', async () => {
    await seedLedger()
    const rows = await loadLedger('personal', '2026-10-01', '2026-10-31')
    const merchants = rows.map((r) => r.merchant)
    for (const left of [
      'Excluded Pending',
      'Excluded Xero',
      'Excluded Unstored',
      'Excluded Xero Account',
      'Excluded Undated',
      'Excluded Null Amount',
    ]) {
      expect(merchants, left).not.toContain(left)
    }
  })

  it('keeps only the NZ days asked for, read from UTC instants', async () => {
    await seedLedger()
    const rows = await loadLedger('personal', '2026-10-19', '2026-10-25')
    const cents = rows.map((r) => r.amountCents)
    expect(cents).toContain(-777) // Monday 00:00 NZ
    expect(cents).toContain(-333) // Sunday 23:59 NZ
    expect(cents).not.toContain(-999) // the Sunday before
    expect(cents).not.toContain(-444) // the Monday after
    expect(rows.find((r) => r.amountCents === -777)?.date).toBe('2026-10-19')
  })

  it('a missing merchant is Unknown merchant and a missing category Uncategorised, never the description', async () => {
    await seedAccounts()
    await tx({ at: day('2026-10-20'), cents: -800, merchant: null, category: null })
    await tx({ at: day('2026-10-20'), cents: -900, merchant: '   ', category: ' ' })
    const rows = await loadLedger('personal', '2026-10-19', '2026-10-25')
    expect(rows.map((r) => [r.merchant, r.category])).toEqual([
      ['Unknown merchant', 'Uncategorised'],
      ['Unknown merchant', 'Uncategorised'],
    ])
    expect(Object.keys(rows[0]).sort()).toEqual(['accountId', 'amountCents', 'category', 'date', 'merchant'])
    expect(JSON.stringify(rows)).not.toContain('SENTINEL')
  })

  it('cleans merchant and category text at load', async () => {
    await seedAccounts()
    await tx({ at: day('2026-10-20'), cents: -800, merchant: '<b>Invented: Shop</b>', category: 'Cat/Sub' })
    const [row] = await loadLedger('personal', '2026-10-19', '2026-10-25')
    expect([row.merchant, row.category]).toEqual(['b Invented Shop b', 'Cat Sub'])
  })

  it('refuses an unknown scope, naming the field', async () => {
    await expect(loadLedger('everyone' as 'personal', '2026-10-19', '2026-10-25')).rejects.toThrow(
      'scope must be personal or strawb',
    )
  })
})

// ---- Pure folds ----

const row = (date: string, accountId: string, amountCents: number, merchant = 'Invented Shop', category = 'Shops'): LedgerRow => ({
  date,
  accountId,
  amountCents,
  merchant,
  category,
})

describe('excludeTransfers', () => {
  it('drops an equal and opposite pair on different accounts, and keeps an unequal one', () => {
    const out = row('2026-10-20', 'acc_p1', -20000)
    const back = row('2026-10-20', 'acc_p2', 20000)
    expect(excludeTransfers([out, back])).toEqual([])
    const near = row('2026-10-20', 'acc_p2', 19999)
    expect(excludeTransfers([out, near])).toEqual([out, near])
  })

  it('pairs legs up to two days apart and no further', () => {
    const out = row('2026-10-20', 'acc_p1', -5000)
    expect(excludeTransfers([out, row('2026-10-22', 'acc_p2', 5000)])).toEqual([])
    expect(excludeTransfers([out, row('2026-10-18', 'acc_p2', 5000)])).toEqual([])
    const far = row('2026-10-23', 'acc_p2', 5000)
    expect(excludeTransfers([out, far])).toEqual([out, far])
  })

  it('pairs across a month end by calendar days', () => {
    const out = row('2026-10-31', 'acc_p1', -5000)
    expect(excludeTransfers([out, row('2026-11-02', 'acc_p2', 5000)])).toEqual([])
  })

  it('does not pair two legs on the same account (a refund)', () => {
    const spend = row('2026-10-20', 'acc_p1', -500)
    const refund = row('2026-10-21', 'acc_p1', 500)
    expect(excludeTransfers([spend, refund])).toEqual([spend, refund])
  })

  it('pairs one to one: two outflows and one inflow leave one outflow', () => {
    const a = row('2026-10-20', 'acc_p1', -1000, 'A')
    const b = row('2026-10-20', 'acc_p1', -1000, 'B')
    const back = row('2026-10-20', 'acc_p2', 1000)
    expect(excludeTransfers([a, b, back])).toEqual([b])
  })

  it('takes the nearest inflow, and the earlier of two equally near', () => {
    const out = row('2026-10-20', 'acc_p1', -1000)
    const nearest = row('2026-10-20', 'acc_p2', 1000)
    const before = row('2026-10-19', 'acc_p2', 1000)
    const after = row('2026-10-21', 'acc_p2', 1000)
    expect(excludeTransfers([after, before, nearest, out])).toEqual([after, before])
    expect(excludeTransfers([after, before, out])).toEqual([after])
  })

  it('pairs the same outflow whatever order the rows arrive in, when two differ only by category', () => {
    const first = row('2026-10-20', 'acc_p1', -5000, 'M', 'B')
    const second = row('2026-10-20', 'acc_p1', -5000, 'M', 'A')
    const back = row('2026-10-20', 'acc_p2', 5000, 'M', 'Transfers')
    expect(excludeTransfers([first, second, back])).toEqual([first])
    expect(excludeTransfers([second, first, back])).toEqual([first])
  })
})

describe('the folds', () => {
  it('spend is outflows only: an inflow is not netted against it', () => {
    const rows = [row('2026-10-20', 'acc_p1', -1000), row('2026-10-21', 'acc_p1', 400)]
    expect(topMerchants(rows, WEEK)).toStrictEqual([{ merchant: 'Invented Shop', spendCents: 1000, count: 1 }])
    expect(weekOverWeek(rows, WEEK).thisWeekCents).toBe(1000)
    expect(spendByCategoryPerMonth(rows, ['2026-10'])).toStrictEqual([
      { month: '2026-10', category: 'Shops', spendCents: 1000 },
    ])
  })

  it('top merchants are capped, by spend then merchant name', () => {
    const rows = ['E', 'D', 'C', 'B', 'A', 'F'].map((m) => row('2026-10-20', 'acc_p1', -1000, m))
    rows.push(row('2026-10-21', 'acc_p1', -500, 'F'))
    expect(topMerchants(rows, WEEK).map((m) => [m.merchant, m.spendCents, m.count])).toEqual([
      ['F', 1500, 2],
      ['A', 1000, 1],
      ['B', 1000, 1],
      ['C', 1000, 1],
      ['D', 1000, 1],
    ])
  })

  it('changePct is null when last week had no spend, and a rounded whole percent otherwise', () => {
    const thisWeekOnly = [row('2026-10-20', 'acc_p1', -1500)]
    expect(weekOverWeek(thisWeekOnly, WEEK)).toMatchObject({ lastWeekCents: 0, changeCents: 1500, changePct: null })
    const both = [row('2026-10-20', 'acc_p1', -1001), row('2026-10-13', 'acc_p1', -3000)]
    expect(weekOverWeek(both, WEEK)).toMatchObject({ thisWeekCents: 1001, lastWeekCents: 3000, changeCents: -1999, changePct: -67 })
  })

  it('week over week lists categories by size of change, a fall as large as a rise', () => {
    const rows = [
      row('2026-10-20', 'acc_p1', -1000, 'M', 'Rise'),
      row('2026-10-13', 'acc_p1', -3000, 'M', 'Fall'),
      row('2026-10-20', 'acc_p1', -500, 'M', 'Same'),
      row('2026-10-13', 'acc_p1', -500, 'M', 'Same'),
    ]
    expect(weekOverWeek(rows, WEEK).byCategory.map((c) => [c.category, c.changeCents])).toEqual([
      ['Fall', -3000],
      ['Rise', 1000],
      ['Same', 0],
    ])
  })

  it('the monthly fold names the top categories over the window and sums the rest into Other', () => {
    const rows: LedgerRow[] = []
    // Eight categories in October; G is small in October but large in
    // September, so it is shown by name in both months.
    for (const [category, cents] of [
      ['A', 900], ['B', 800], ['C', 700], ['D', 600], ['E', 500], ['F', 400], ['G', 10], ['H', 300],
    ] as const) {
      rows.push(row('2026-10-05', 'acc_p1', -cents, 'M', category))
    }
    rows.push(row('2026-09-05', 'acc_p1', -5000, 'M', 'G'))
    // A real category already called "Other categories", large enough to
    // rank: it still joins the sum rather than showing twice.
    rows.push(row('2026-10-06', 'acc_p1', -650, 'M', OTHER_CATEGORIES))
    const cells = spendByCategoryPerMonth(rows, ['2026-09', '2026-10'])
    expect(cells).toStrictEqual([
      { month: '2026-09', category: 'G', spendCents: 5000 },
      { month: '2026-10', category: 'A', spendCents: 900 },
      { month: '2026-10', category: 'B', spendCents: 800 },
      { month: '2026-10', category: 'C', spendCents: 700 },
      { month: '2026-10', category: 'D', spendCents: 600 },
      { month: '2026-10', category: 'E', spendCents: 500 },
      { month: '2026-10', category: 'G', spendCents: 10 },
      // F 400 + H 300 + the real "Other categories" 650.
      { month: '2026-10', category: OTHER_CATEGORIES, spendCents: 1350 },
    ])
  })

  it('the monthly fold ignores months it was not asked for, in the cells and in the ranking', () => {
    // April's large X would take the one named slot if April were ranked.
    const rows = [
      row('2026-04-30', 'acc_p1', -5000, 'M', 'X'),
      row('2026-05-01', 'acc_p1', -200, 'M', 'Y'),
      row('2026-05-02', 'acc_p1', -100, 'M', 'Z'),
    ]
    expect(spendByCategoryPerMonth(rows, ['2026-05'], 1)).toStrictEqual([
      { month: '2026-05', category: 'Y', spendCents: 200 },
      { month: '2026-05', category: OTHER_CATEGORIES, spendCents: 100 },
    ])
  })
})

describe('unusualSpends', () => {
  // History before 2026-W43 (lookback 2026-08-24 to 2026-10-18).
  const history = (merchant: string, cents: number[], dates = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']) =>
    cents.map((c, i) => row(dates[i], 'acc_p1', -c, merchant))

  it('flags exactly three times the median, not one cent under', () => {
    const rows = [...history('M', [2000, 2000, 2000]), row('2026-10-20', 'acc_p1', -6000, 'M')]
    expect(unusualSpends(rows, WEEK)).toStrictEqual([
      { date: '2026-10-20', merchant: 'M', category: 'Shops', amountCents: 6000, typicalCents: 2000 },
    ])
    const under = [...history('M', [2000, 2000, 2000]), row('2026-10-20', 'acc_p1', -5999, 'M')]
    expect(unusualSpends(under, WEEK)).toEqual([])
  })

  it('flags nothing under the floor, however large against the median', () => {
    const at = [...history('M', [1000, 1000, 1000]), row('2026-10-20', 'acc_p1', -5000, 'M')]
    expect(unusualSpends(at, WEEK).map((u) => u.amountCents)).toEqual([5000])
    const under = [...history('M', [1000, 1000, 1000]), row('2026-10-20', 'acc_p1', -4999, 'M')]
    expect(unusualSpends(under, WEEK)).toEqual([])
  })

  it('flags nothing for a merchant with fewer than three earlier outflows, the week’s own not counted', () => {
    const rows = [
      ...history('M', [1000, 1000]),
      row('2026-10-19', 'acc_p1', -1000, 'M'),
      row('2026-10-19', 'acc_p1', -1000, 'M'),
      row('2026-10-20', 'acc_p1', -9000, 'M'),
    ]
    expect(unusualSpends(rows, WEEK)).toEqual([])
  })

  it('takes the lower middle of an even count as the median', () => {
    // Lower middle 2000: 6000 qualifies. The upper middle (3000) or the mean
    // (2500) would not.
    const rows = [...history('M', [4000, 1000, 3000, 2000]), row('2026-10-20', 'acc_p1', -6000, 'M')]
    expect(unusualSpends(rows, WEEK).map((u) => u.typicalCents)).toEqual([2000])
  })

  it('counts history from eight weeks before the Monday, and not a day earlier', () => {
    const inside = [...history('M', [1000, 1000], ['2026-09-01', '2026-09-08']), row('2026-08-24', 'acc_p1', -1000, 'M')]
    const spend = row('2026-10-20', 'acc_p1', -9000, 'M')
    expect(unusualSpends([...inside, spend], WEEK)).toHaveLength(1)
    const outside = [...history('M', [1000, 1000], ['2026-09-01', '2026-09-08']), row('2026-08-23', 'acc_p1', -1000, 'M')]
    expect(unusualSpends([...outside, spend], WEEK)).toEqual([])
  })

  it('a transfer is not flagged once transfers are excluded', () => {
    const rows = [
      ...history('M', [1000, 1000, 1000]),
      row('2026-10-20', 'acc_p1', -10000, 'M'),
      row('2026-10-21', 'acc_p2', 10000, 'M'),
    ]
    expect(unusualSpends(rows, WEEK)).toHaveLength(1)
    expect(unusualSpends(excludeTransfers(rows), WEEK)).toEqual([])
  })

  it('is capped, by amount then merchant then date', () => {
    const rows: LedgerRow[] = []
    for (const m of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      rows.push(...history(m, [1000, 1000, 1000]))
      rows.push(row('2026-10-21', 'acc_p1', -(m === 'G' ? 20000 : 9000), m))
    }
    rows.push(row('2026-10-20', 'acc_p1', -9000, 'B'))
    expect(unusualSpends(rows, WEEK).map((u) => [u.merchant, u.date])).toEqual([
      ['G', '2026-10-21'],
      ['A', '2026-10-21'],
      ['B', '2026-10-20'],
      ['B', '2026-10-21'],
      ['C', '2026-10-21'],
    ])
  })
})

// ---- Dates ----

describe('dates', () => {
  it.each([
    ['2024-12-30', '2025-W01'],
    ['2026-01-01', '2026-W01'],
    ['2026-12-31', '2026-W53'],
    ['2021-01-03', '2020-W53'],
    ['2024-02-29', '2024-W09'],
    ['2026-10-19', '2026-W43'],
    ['2026-10-25', '2026-W43'],
    ['2026-10-26', '2026-W44'],
  ])('isoWeekOf(%s) is %s', (date, week) => {
    expect(isoWeekOf(date)).toBe(week)
  })

  it.each([
    ['2026-W43', '2026-10-19', '2026-10-25'],
    ['2026-W01', '2025-12-29', '2026-01-04'],
    ['2025-W01', '2024-12-30', '2025-01-05'],
    ['2026-W53', '2026-12-28', '2027-01-03'],
    ['2020-W53', '2020-12-28', '2021-01-03'],
  ])('weekRange(%s) is %s to %s and round-trips', (label, start, end) => {
    expect(weekRange(label)).toStrictEqual({ label, start, end })
    expect(isoWeekOf(start)).toBe(label)
    expect(isoWeekOf(end)).toBe(label)
  })

  it.each(['2025-W53', '2026-W54', '2026-W00', '2026-W4', '2026-43', 'W43', '', '2026-W43 ', '2026-w43'])(
    'weekRange refuses %j, naming the field and not the value',
    (label) => {
      let message = ''
      try {
        weekRange(label)
      } catch (err) {
        message = err instanceof Error ? err.message : ''
      }
      expect(message).toBe('period must be an ISO week label (YYYY-Www)')
    },
  )

  it.each([
    ['2026-10-25T10:59:00.000Z', '2026-10-25'],
    ['2026-10-25T11:00:00.000Z', '2026-10-26'],
    // DST ended at 03:00 on 5 April 2026: that evening is UTC+12.
    ['2026-04-05T11:30:00.000Z', '2026-04-05'],
    ['2026-04-05T12:00:00.000Z', '2026-04-06'],
  ])('nzCalendarDate(%s) is %s', (at, date) => {
    expect(nzCalendarDate(new Date(at))).toBe(date)
  })

  it('nzCalendarDate refuses an invalid instant', () => {
    expect(() => nzCalendarDate(new Date('not a date'))).toThrow('date is not a valid instant')
  })

  it.each([
    ['2026-10-27T00:00:00.000Z', '2026-W43'], // Tuesday in NZ
    ['2026-10-25T10:59:00.000Z', '2026-W42'], // Sunday 23:59 in NZ: W43 is not over
    ['2026-10-25T11:00:00.000Z', '2026-W43'], // Monday 00:00 in NZ
  ])('lastCompleteWeek(%s) is %s', (now, week) => {
    expect(lastCompleteWeek(new Date(now))).toBe(week)
  })

  it('monthsEnding counts back across a year end, ascending', () => {
    expect(monthsEnding('2026-10-25')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    expect(monthsEnding('2026-02-03', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
  })
})

// ---- Labels ----

describe('cleanLabel', () => {
  const FALLBACK = 'Unknown merchant'
  const surrogate = '\u{20000}' // a CJK letter outside the BMP: two UTF-16 units

  it.each([
    ['http://evil.example/x', 'http evil.example x'],
    ['PAYMENT: X', 'PAYMENT X'],
    ['News: x', 'News x'],
    ['javascript:alert(1)', 'javascript alert(1)'],
    ['<script>alert(1)</script>', 'script alert(1) script'],
    ['https\uFF1A//x', 'https x'],
    // NFKC first: full-width letters and the ideographic space fold to ASCII.
    ['\uFF26\uFF35\uFF2C\uFF2C\u3000\uFF57\uFF49\uFF44\uFF54\uFF48', 'FULL width'],
    // A full-width ampersand is a kept `&` only if NFKC runs before the filter.
    ['A\uFF06B', 'A&B'],
    ['Bad\u202Eevil\u200Bname\u2066', 'Bad evil name'],
    ['a'.repeat(500), 'a'.repeat(40)],
    ['www.evil.com', 'www.evil.com'],
    ['[x](http://y)', 'x (http y)'],
    ['', FALLBACK],
    [' \t\n ', FALLBACK],
    ['/', FALLBACK],
    ['a`b', 'a b'],
    ['back\\slash', 'back slash'],
    ['a*b|c~d!e', 'a b c d e'],
    ['a'.repeat(39) + surrogate + surrogate, 'a'.repeat(39) + surrogate],
  ])('%j becomes %j', (input, output) => {
    expect(cleanLabel(input, FALLBACK)).toBe(output)
  })

  it('a null is the fallback', () => {
    expect(cleanLabel(null, FALLBACK)).toBe(FALLBACK)
  })

  it('cuts by code point and never splits a surrogate pair', () => {
    const out = cleanLabel('a'.repeat(39) + surrogate + surrogate, FALLBACK)
    expect(Array.from(out)).toHaveLength(40)
    expect(out.endsWith(surrogate)).toBe(true)
  })

  it.each([
    'http://evil.example/x',
    'PAYMENT: X',
    'News: x',
    'javascript:alert(1)',
    '<script>alert(1)</script>',
    'https\uFF1A//x',
    'Bad\u202Eevil\u200Bname',
    'a'.repeat(500),
    'www.evil.com',
    '[x](http://y)',
    '\\\\evil\\share',
    'data:text/html,x',
    'Metadata: x',
    '`',
  ])('the cleaned %j holds none of : < / \\ ` and passes the chart validator as a value', (input) => {
    const out = cleanLabel(input, FALLBACK)
    for (const banned of [':', '<', '/', '\\', '`']) expect(out).not.toContain(banned)
    expect(passesAsValue(out)).toBe(true)
  })

  // Only a bounded prefix is read, before NFKC, so a huge feed string costs
  // bounded work.
  it('reads only the first 400 UTF-16 units: text after them is never seen', () => {
    expect(cleanLabel(' '.repeat(400) + 'Shop', FALLBACK)).toBe(FALLBACK)
    expect(cleanLabel(' '.repeat(399) + 'Shop', FALLBACK)).toBe('S')
    expect(cleanLabel('Shop' + 'x'.repeat(10_000_000), FALLBACK)).toBe('Shop' + 'x'.repeat(36))
  })

  it('cuts the prefix before NFKC, not after: a ligature at the edge folds whole', () => {
    // U+FB01 is one unit that NFKC folds to "fi". Cut after folding, only
    // the "f" would be inside the first 400 units.
    expect(cleanLabel(' '.repeat(399) + 'ﬁZ', FALLBACK)).toBe('fi')
  })

  it('never splits a surrogate pair at the prefix edge', () => {
    // Unobservable through the output (a lone surrogate is dropped as any
    // disallowed character is); held so the pair at the edge is whole or gone.
    expect(cleanLabel('a'.repeat(399) + surrogate, FALLBACK)).toBe('a'.repeat(40))
    expect(cleanLabel(' '.repeat(398) + surrogate + 'Z', FALLBACK)).toBe(surrogate)
  })

  it.each([
    ['12-3456-0123456-00', '####'],
    ['4111 1111 1111 1111', '####'],
    ['BNZ 12-3456-0123456-00 Transfer', 'BNZ #### Transfer'],
    ['12345678', '####'],
    // NFKC first: full-width digits are digits.
    ['４１１１ １１１１', '####'],
    // A slash or an invisible character between groups is counted through.
    ['4111​1111/1111-1111', '####'],
    // Masked before the 40 code point cut, so no prefix of the number shows.
    ['a'.repeat(35) + ' 4111111111111111', 'a'.repeat(35) + ' ####'],
  ])('a long digit run in %j is masked: %j', (input, output) => {
    const out = cleanLabel(input, FALLBACK)
    expect(out).toBe(output)
    expect(passesAsValue(out)).toBe(true)
  })

  it.each([
    ['7 Eleven', '7 Eleven'],
    ['Store 123', 'Store 123'],
    ['2026', '2026'],
    ['1234567', '1234567'],
    ['Flight NZ 123 4567', 'Flight NZ 123 4567'],
    ['1,234,567.89', '1,234,567.89'],
  ])('a short number in %j is kept: %j', (input, output) => {
    expect(cleanLabel(input, FALLBACK)).toBe(output)
  })

  // The coupling between cleanLabel and the chart validator, pinned for every
  // BMP code point (lone surrogates skipped), alone, flanked and repeated.
  // Every output is checked for the banned characters; distinct outputs are
  // each run through the validator once.
  it('every BMP code point, cleaned, holds no banned character and passes the chart validator', () => {
    const banned = /[:<>/\\`[\]*|~!\n\r]/
    const outputs = new Set<string>()
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const c = String.fromCharCode(code)
      for (const input of [c, `a${c}b`, `${c}${c}${c}`]) {
        const out = cleanLabel(input, FALLBACK)
        if (banned.test(out)) expect.fail(`U+${code.toString(16)} in ${JSON.stringify(input)} leaves ${JSON.stringify(out)}`)
        outputs.add(out)
      }
    }
    for (const out of outputs) {
      if (!passesAsValue(out)) expect.fail(`${JSON.stringify(out)} is refused by the chart validator`)
    }
  })
})

// A label as a chart data value, as prompt.ts writes it.
function passesAsValue(label: string): boolean {
  return validateChartSpec({
    data: { values: [{ merchant: label, spend_cents: 100 }] },
    mark: 'bar',
    encoding: { x: { field: 'merchant', type: 'nominal' }, y: { field: 'spend_cents', type: 'quantitative' } },
  }).ok
}

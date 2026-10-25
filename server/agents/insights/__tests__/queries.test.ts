import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { validateChartSpec } from '../../../../models/insights.ts'
import {
  OTHER_CATEGORIES,
  cleanLabel,
  collectAggregates,
  excludeOwnAccountTransfers,
  isoWeekOf,
  lastCompleteWeek,
  loadLedger,
  monthsEnding,
  spendByCategoryPerMonth,
  topMerchants,
  unusualSpends,
  weekOverWeek,
  weekRange,
  type LedgerRow,
} from '../queries.ts'
import { nzCalendarDate } from '../../../../shared/nz-dates.ts'

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
    const ledger = excludeOwnAccountTransfers(await loadLedger('personal', '2026-10-17', '2026-10-27'))
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
    const narrow = excludeOwnAccountTransfers(await loadLedger('personal', '2026-10-19', '2026-10-25'))
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
    const rows = excludeOwnAccountTransfers(await loadLedger('strawb', '2026-10-19', '2026-10-25'))
    expect(rows.map((r) => r.amountCents)).toContain(30000)
    expect(rows.map((r) => r.amountCents)).not.toContain(-30000)
  })

  // The candidate read's source filters. A row they let through would be a
  // candidate; its only way to show is by taking a personal in half from a
  // real drawing, which then counts as strawb spend. Each fake out half
  // posts the same day as the in half (a gap of 0), so the matcher would
  // take it before the real out half the day before (a gap of 1).
  it.each([
    ['a Xero-sourced strawb outflow', 'acc_s1', 'xero'],
    ['a strawb outflow on a non-Akahu account', 'acc_sx', 'akahu'],
  ] as const)('%s is not a drawing candidate, so it takes no in half from a real one', async (_why, account, source) => {
    await seedAccounts()
    await connection('accounts').insert({
      akahu_id: 'acc_sx',
      source: 'xero',
      scope: 'strawb',
      name: 'Invented account',
      created_at: STAMP,
      updated_at: STAMP,
    })
    await tx({ account: 'acc_s1', at: day('2026-10-20'), cents: -27100, merchant: 'Real Drawing Fixture', category: 'Transfers' })
    await tx({ account, at: day('2026-10-21'), cents: -27100, merchant: 'Fake Half Fixture', category: 'Transfers', source })
    await tx({ at: day('2026-10-21'), cents: 27100, merchant: 'Owner In Fixture' })
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants).toStrictEqual([])
    expect(a.wow.thisWeekCents).toBe(0)
  })

  it('a strawb candidate whose amount is not whole cents is skipped, not thrown on', async () => {
    await seedAccounts()
    await tx({ account: 'acc_s1', at: day('2026-10-20'), cents: -12.5, merchant: 'Fractional Fixture', category: 'Supplies' })
    await tx({ account: 'acc_s1', at: day('2026-10-20'), cents: -27100, merchant: 'Real Drawing Fixture', category: 'Transfers' })
    await tx({ at: day('2026-10-21'), cents: 27100, merchant: 'Owner In Fixture' })
    // Stored as a REAL: SQLite keeps 12.5 rather than rounding it.
    const stored = await connection('transactions').where({ merchant_name: 'Fractional Fixture' }).first()
    expect(stored.amount_cents).toBe(-12.5)
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants).toStrictEqual([])
  })

  // The other rows the matcher cannot place, beside a real drawing: the run
  // still resolves, and the real drawing is still dropped. Both dates sort
  // outside the ledger's SQL bounds, so only the candidate read meets them.
  it.each([
    ['a personal inflow whose date is not an instant', 'acc_p1', 'not a date', 31000],
    ['a strawb outflow whose NZ year is past 9999', 'acc_s1', '+275760-09-13T00:00:00.000Z', -31000],
  ] as const)('%s is skipped, not thrown on', async (_why, account, at, cents) => {
    await seedAccounts()
    await tx({ account, at, cents, merchant: 'Unplaceable Fixture', category: 'Transfers' })
    await tx({ account: 'acc_s1', at: day('2026-10-20'), cents: -27100, merchant: 'Real Drawing Fixture', category: 'Transfers' })
    await tx({ at: day('2026-10-21'), cents: 27100, merchant: 'Owner In Fixture' })
    const a = await collectAggregates('strawb', WEEK)
    expect(a.topMerchants).toStrictEqual([])
    expect(a.wow.thisWeekCents).toBe(0)
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

  it('leaves out a row whose amount is not whole cents', async () => {
    await seedAccounts()
    await tx({ at: day('2026-10-20'), cents: -12.5, merchant: 'Fractional Fixture', category: 'Shops' })
    await tx({ at: day('2026-10-20'), cents: -1250, merchant: 'Whole Fixture', category: 'Shops' })
    // Stored as a REAL: SQLite keeps 12.5 rather than rounding it.
    const stored = await connection('transactions').where({ merchant_name: 'Fractional Fixture' }).first()
    expect(stored.amount_cents).toBe(-12.5)
    const rows = await loadLedger('personal', '2026-10-19', '2026-10-25')
    expect(rows.map((r) => [r.merchant, r.amountCents])).toStrictEqual([['Whole Fixture', -1250]])
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

  // Rolled over, month 13 would read as January 2027 and the read would
  // return nothing rather than refuse.
  it('refuses a from that names no calendar date with a RangeError', async () => {
    await expect(loadLedger('personal', '2026-13-01', '2026-10-25')).rejects.toThrow(RangeError)
  })

  it('refuses a to that names no calendar date with a RangeError', async () => {
    await expect(loadLedger('personal', '2026-10-01', '2026-13-01')).rejects.toThrow(RangeError)
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

describe('excludeOwnAccountTransfers', () => {
  it('drops an equal and opposite pair on different accounts, and keeps an unequal one', () => {
    const out = row('2026-10-20', 'acc_p1', -20000)
    const back = row('2026-10-20', 'acc_p2', 20000)
    expect(excludeOwnAccountTransfers([out, back])).toEqual([])
    const near = row('2026-10-20', 'acc_p2', 19999)
    expect(excludeOwnAccountTransfers([out, near])).toEqual([out, near])
  })

  it('pairs legs up to two days apart and no further', () => {
    const out = row('2026-10-20', 'acc_p1', -5000)
    expect(excludeOwnAccountTransfers([out, row('2026-10-22', 'acc_p2', 5000)])).toEqual([])
    expect(excludeOwnAccountTransfers([out, row('2026-10-18', 'acc_p2', 5000)])).toEqual([])
    const far = row('2026-10-23', 'acc_p2', 5000)
    expect(excludeOwnAccountTransfers([out, far])).toEqual([out, far])
  })

  it('pairs across a month end by calendar days', () => {
    const out = row('2026-10-31', 'acc_p1', -5000)
    expect(excludeOwnAccountTransfers([out, row('2026-11-02', 'acc_p2', 5000)])).toEqual([])
  })

  it('does not pair two legs on the same account (a refund)', () => {
    const spend = row('2026-10-20', 'acc_p1', -500)
    const refund = row('2026-10-21', 'acc_p1', 500)
    expect(excludeOwnAccountTransfers([spend, refund])).toEqual([spend, refund])
  })

  it('pairs one to one: two outflows and one inflow leave one outflow', () => {
    const a = row('2026-10-20', 'acc_p1', -1000, 'A')
    const b = row('2026-10-20', 'acc_p1', -1000, 'B')
    const back = row('2026-10-20', 'acc_p2', 1000)
    expect(excludeOwnAccountTransfers([a, b, back])).toEqual([b])
  })

  it('takes the nearest inflow, and the earlier of two equally near', () => {
    const out = row('2026-10-20', 'acc_p1', -1000)
    const nearest = row('2026-10-20', 'acc_p2', 1000)
    const before = row('2026-10-19', 'acc_p2', 1000)
    const after = row('2026-10-21', 'acc_p2', 1000)
    expect(excludeOwnAccountTransfers([after, before, nearest, out])).toEqual([after, before])
    expect(excludeOwnAccountTransfers([after, before, out])).toEqual([after])
  })

  it('pairs the same outflow whatever order the rows arrive in, when two differ only by category', () => {
    const first = row('2026-10-20', 'acc_p1', -5000, 'M', 'B')
    const second = row('2026-10-20', 'acc_p1', -5000, 'M', 'A')
    const back = row('2026-10-20', 'acc_p2', 5000, 'M', 'Transfers')
    expect(excludeOwnAccountTransfers([first, second, back])).toEqual([first])
    expect(excludeOwnAccountTransfers([second, first, back])).toEqual([first])
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

  it('week over week breaks a tie in size of change by category, whatever the sign or arrival order', () => {
    // Categories arrive this week's first (Zed, Alpha), then last week's (Fall).
    const rows = [
      row('2026-10-20', 'acc_p1', -1000, 'M', 'Zed'),
      row('2026-10-21', 'acc_p1', -1000, 'M', 'Alpha'),
      row('2026-10-13', 'acc_p1', -1000, 'M', 'Fall'),
    ]
    expect(weekOverWeek(rows, WEEK).byCategory.map((c) => [c.category, c.changeCents])).toEqual([
      ['Alpha', 1000],
      ['Fall', -1000],
      ['Zed', 1000],
    ])
  })

  it('the monthly fold orders equal cells in a month by category, whatever the arrival order', () => {
    const rows = [
      row('2026-10-05', 'acc_p1', -500, 'M', 'Zed'),
      row('2026-10-06', 'acc_p1', -500, 'M', 'Alpha'),
      row('2026-10-07', 'acc_p1', -900, 'M', 'Mid'),
    ]
    expect(spendByCategoryPerMonth(rows, ['2026-10'])).toStrictEqual([
      { month: '2026-10', category: 'Mid', spendCents: 900 },
      { month: '2026-10', category: 'Alpha', spendCents: 500 },
      { month: '2026-10', category: 'Zed', spendCents: 500 },
    ])
  })

  it('the monthly fold names the earlier category of two with equal spend over the window', () => {
    const rows = [row('2026-10-05', 'acc_p1', -500, 'M', 'Zed'), row('2026-10-06', 'acc_p1', -500, 'M', 'Alpha')]
    expect(spendByCategoryPerMonth(rows, ['2026-10'], 1)).toStrictEqual([
      { month: '2026-10', category: 'Alpha', spendCents: 500 },
      { month: '2026-10', category: OTHER_CATEGORIES, spendCents: 500 },
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
    expect(unusualSpends(excludeOwnAccountTransfers(rows), WEEK)).toEqual([])
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

  // The years 0 to 99 are their own years, not 1900 to 1999 (`Date.UTC`'s
  // reading). 0050-01-01 is a Saturday (2050's weekday, 400 years on), so
  // W01 starts Monday 0050-01-03 and W24 on 0050-06-13.
  it('isoWeekOf and weekRange read a two-digit year as itself', () => {
    expect(isoWeekOf('0050-06-15')).toBe('0050-W24')
    expect(isoWeekOf('0050-01-04')).toBe('0050-W01')
    expect(isoWeekOf('0050-01-01')).toBe('0049-W52')
    expect(weekRange('0050-W24')).toStrictEqual({ label: '0050-W24', start: '0050-06-13', end: '0050-06-19' })
    expect(isoWeekOf('0050-06-13')).toBe('0050-W24')
    expect(isoWeekOf('0050-06-19')).toBe('0050-W24')
  })

  // A Friday: its week's Thursday is 9999-12-30, so nothing on the way
  // steps into the year 10000.
  it('isoWeekOf(9999-12-31) is 9999-W52', () => {
    expect(isoWeekOf('9999-12-31')).toBe('9999-W52')
  })

  // The class only: the refusal's text belongs to whichever parser reads the
  // date, so it is not pinned.
  it.each(['2026-02-30', '2026-13-01', 'x'])('isoWeekOf and monthsEnding refuse %j with a RangeError', (date) => {
    expect(() => isoWeekOf(date)).toThrow(RangeError)
    expect(() => monthsEnding(date)).toThrow(RangeError)
  })

  // A Saturday: its week's Thursday is in the year -1, which no YYYY-MM-DD names.
  it('isoWeekOf(0000-01-01) is a RangeError', () => {
    expect(() => isoWeekOf('0000-01-01')).toThrow(RangeError)
  })

  // 9999-W52's Sunday is 10000-01-02, which no YYYY-MM-DD names, and a later
  // week has no day in 9999 at all, so a date helper throws its own
  // RangeError. weekRange turns it into its own refusal, so the range is
  // never returned with a five-digit year and the caller gets the period text.
  it.each(['9999-W52', '9999-W53', '9999-W54'])(
    'weekRange(%s) refuses with the period message, not a date helper message',
    (label) => {
      let caught: unknown
      try {
        weekRange(label)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RangeError)
      expect((caught as Error).message).toBe('period must be an ISO week label (YYYY-Www)')
    },
  )

  // 0000-W01 (Monday 0000-01-03 to Sunday 0000-01-09) and 0000-W25 are real
  // weeks, but their analysis window starts before 0000-01-01: W01's monthly
  // months, W25's read padding (its months start at 0000-01 exactly). A date
  // helper or monthsEnding throws its own text; weekRange refuses with the
  // period text instead (#349).
  it.each(['0000-W01', '0000-W25'])(
    'weekRange(%s) refuses a week whose analysis window leaves the year 0000, with the period message',
    (label) => {
      let caught: unknown
      try {
        weekRange(label)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RangeError)
      expect((caught as Error).message).toBe('period must be an ISO week label (YYYY-Www)')
    },
  )

  it('weekRange(0000-W26) is returned: its analysis window fits after 0000-01-01', () => {
    expect(weekRange('0000-W26')).toStrictEqual({ label: '0000-W26', start: '0000-06-26', end: '0000-07-02' })
  })

  // The other end is unchanged: 9999-W51's padded read ends on 9999-12-30.
  it('weekRange(9999-W51) is returned', () => {
    expect(weekRange('9999-W51')).toStrictEqual({ label: '9999-W51', start: '9999-12-20', end: '9999-12-26' })
  })

  // The first week the window math accepts, found by sweeping the year 0000
  // rather than written down, so a change to MONTHLY_MONTHS,
  // UNUSUAL_LOOKBACK_WEEKS or TRANSFER_WINDOW_DAYS shows as a diff here.
  // The year 0000 has no week 53, so its last accepted week is W52.
  it('sweeping the year 0000, weekRange accepts exactly 0000-W26 to 0000-W52', () => {
    const labels = Array.from({ length: 53 }, (_, i) => `0000-W${String(i + 1).padStart(2, '0')}`)
    const accepted = labels.filter((label) => {
      try {
        weekRange(label)
        return true
      } catch {
        return false
      }
    })
    expect(accepted[0]).toBe('0000-W26')
    expect(accepted.at(-1)).toBe('0000-W52')
    expect(accepted).toStrictEqual(labels.slice(labels.indexOf('0000-W26'), labels.indexOf('0000-W52') + 1))
  })

  // weekOverWeek refuses a refused week with the period text, before its
  // step back to the previous week can throw a date helper's text.
  it('weekOverWeek([], 0000-W01) refuses with the period message', () => {
    let caught: unknown
    try {
      weekOverWeek([], '0000-W01')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RangeError)
    expect((caught as Error).message).toBe('period must be an ISO week label (YYYY-Www)')
  })

  // The previous week, 0000-W25, is itself one weekRange refuses, so this
  // returns only because weekOverWeek reads the previous week's days without
  // the analysis-window check; the 0000-06-20 row shows those days are W25's.
  it('weekOverWeek over 0000-W26 returns, counting 0000-W25 as last week', () => {
    const row = (date: string, amountCents: number) => ({
      date,
      accountId: 'acc_one',
      amountCents,
      category: 'Groceries',
      merchant: 'Corner Shop',
    })
    expect(weekOverWeek([row('0000-06-20', -1000), row('0000-06-27', -3000)], '0000-W26')).toStrictEqual({
      thisWeekCents: 3000,
      lastWeekCents: 1000,
      changeCents: 2000,
      changePct: 200,
      byCategory: [{ category: 'Groceries', thisCents: 3000, lastCents: 1000, changeCents: 2000 }],
    })
  })

  // A window that would start before 0000-01 has no label for its earliest
  // months, so it is refused with a fixed text that names `end` and echoes no
  // value. The boundary cases are the window that starts at 0000-01 exactly
  // (kept below) and the one that starts one month earlier (refused here).
  it.each([
    ['0000-01-01', 3],
    ['0000-01-01', 2],
    ['0000-02-01', 3],
  ])('monthsEnding(%s, %i) refuses a window that starts before 0000-01, naming the field and not the value', (end, n) => {
    let caught: unknown
    try {
      monthsEnding(end, n)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RangeError)
    expect((caught as Error).message).toBe(
      'end leaves no room for the months asked: the window would start before 0000-01',
    )
  })

  it('monthsEnding keeps a window that starts exactly at 0000-01', () => {
    expect(monthsEnding('0000-03-15', 3)).toStrictEqual(['0000-01', '0000-02', '0000-03'])
    expect(monthsEnding('0000-02-01', 2)).toStrictEqual(['0000-01', '0000-02'])
    expect(monthsEnding('0000-01-01', 1)).toStrictEqual(['0000-01'])
  })

  it('lastCompleteWeek refuses an invalid instant', () => {
    expect(() => lastCompleteWeek(new Date('not a date'))).toThrow('date is not a valid instant')
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

  // #304: combining marks are kept on a base (a letter or number), at most
  // three on one base; a mark past the cap or with no base is dropped, not
  // turned into a space. NFKC runs first, so marks are counted on its output.
  it('#304: a Devanagari vowel sign and virama are kept, so the word reads whole', () => {
    expect(cleanLabel('\u0939\u093F\u0928\u094D\u0926\u0940 Store', FALLBACK)).toBe(
      '\u0939\u093F\u0928\u094D\u0926\u0940 Store',
    )
  })

  it('#304: three marks on one base are kept (Hindi zindagi: a nukta, a vowel sign and an anusvara on ja)', () => {
    // U+095B (ja with nukta) is a composition exclusion, so NFKC splits it
    // into ja and a nukta: the input below is already in that form.
    expect(cleanLabel('\u091C\u093C\u093F\u0902\u0926\u0917\u0940', FALLBACK)).toBe(
      '\u091C\u093C\u093F\u0902\u0926\u0917\u0940',
    )
  })

  it('#304: a hostile stack keeps only the first three marks on its base, and the word is not split', () => {
    // NFKC composes Z and the acute into U+0179 first; three of the four
    // marks left survive.
    expect(cleanLabel('Z\u0301\u0302\u0303\u0304\u0305oo', FALLBACK)).toBe('\u0179\u0302\u0303\u0304oo')
  })

  it('#304: a mark with no base, at the start, is dropped', () => {
    expect(cleanLabel('\u0301Shop', FALLBACK)).toBe('Shop')
    expect(cleanLabel('\u0301\u0302\u0303', FALLBACK)).toBe(FALLBACK)
  })

  it('#304: a mark after a space is dropped', () => {
    expect(cleanLabel('a \u0301b', FALLBACK)).toBe('a b')
  })

  it('#304: a mark after kept punctuation or a dropped character has no base and leaves no space', () => {
    expect(cleanLabel('A.\u0301B', FALLBACK)).toBe('A.B')
    expect(cleanLabel('A&\u0301\u0302B', FALLBACK)).toBe('A&B')
    expect(cleanLabel('a:\u0301b', FALLBACK)).toBe('a b')
  })

  it('#304: a mark after a default-ignorable letter has no base', () => {
    // U+115F, a Hangul filler, is a letter that draws nothing. It becomes a
    // space (#312), so the mark after it has no base and is dropped.
    expect(cleanLabel('\u115F\u0301x', FALLBACK)).toBe('x')
    expect(cleanLabel('a\u115F\u0301x', FALLBACK)).toBe('a x')
  })

  it('#304: a digit is a base, so its marks are kept, up to the cap, outside a long digit run', () => {
    expect(cleanLabel('Zone 2\u0301', FALLBACK)).toBe('Zone 2\u0301')
    expect(cleanLabel('Zone 2\u0301\u0302\u0303\u0304', FALLBACK)).toBe('Zone 2\u0301\u0302\u0303')
    // Seven digits are short of LONG_DIGIT_RUN, so they stay, marks and all.
    const seven = '1\u03012\u03013\u03014\u03015\u03016\u03017\u0301'
    expect(cleanLabel(seven, FALLBACK)).toBe(seven)
  })

  it('#304: NFKC composes before marks are counted, so a composed mark frees a place under the cap', () => {
    expect(cleanLabel('a\u0301\u0302\u0303\u0304', FALLBACK)).toBe('\u00E1\u0302\u0303\u0304')
  })

  it('#304: a decomposed Kāpiti is composed by NFKC and keeps no mark', () => {
    expect(cleanLabel('Ka\u0304piti', FALLBACK)).toBe('K\u0101piti')
  })

  it('#304: a decomposed Vietnamese name composes whole', () => {
    expect(cleanLabel('Pho\u031B\u0309 Ha\u0300 No\u0323\u0302i', FALLBACK)).toBe('Ph\u1EDF H\u00E0 N\u1ED9i')
  })

  it.each([
    ['the combining grapheme joiner', '\u034F'],
    ['a variation selector', '\uFE0F'],
    ['a supplementary variation selector', '\u{E0100}'],
    ['a Mongolian free variation selector', '\u180B'],
    ['an invisible Khmer vowel', '\u17B4'],
    ['an enclosing circle', '\u20DD'],
    ['an enclosing Cyrillic sign', '\u0488'],
  ])('#304: %s is not an allowed mark and becomes a space', (_name, mark) => {
    expect(cleanLabel(`a${mark}b`, FALLBACK)).toBe('a b')
  })

  it('#304: marks count toward the 40 code point cut, which keeps a base with its first marks', () => {
    expect(cleanLabel('a'.repeat(38) + 'b\u0301\u0302\u0303', FALLBACK)).toBe('a'.repeat(38) + 'b\u0301')
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
    ['Bank 12-3456-0123456-00 Transfer', 'Bank #### Transfer'],
    ['12345678', '####'],
    // NFKC first: full-width digits are digits.
    ['４１１１ １１１１', '####'],
    // A slash or an invisible character between groups is counted through.
    ['4111\u200B1111/1111-1111', '####'],
    // Masked before the 40 code point cut, so no prefix of the number shows.
    ['a'.repeat(35) + ' 4111111111111111', 'a'.repeat(35) + ' ####'],
    // #304: a combining mark on every digit is counted through, and masked
    // with the digits, so it cannot break the run.
    ['4\u03011\u03011\u03011\u0301 1\u03011\u03011\u03011\u0301 1\u03011\u03011\u03011\u0301 1\u03011\u03011\u03011\u0301', '####'],
    ['Pay 4\u0301\u0302\u03031\u03011\u03011\u03011\u03011\u03011\u03011\u0301 now', 'Pay #### now'],
    // Devanagari digits, each with a candrabindu.
    ['\u096A\u0901\u0967\u0901\u0967\u0901\u0967\u0901\u0967\u0901\u0967\u0901\u0967\u0901\u0967\u0901', '####'],
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
  // BMP code point (lone surrogates skipped), alone, flanked and repeated,
  // and for every combining mark in the whole code space stacked deep on a
  // base and placed with no base, plus a Zalgo string (#304), and for every
  // BMP code point and every default-ignorable one in the whole code space
  // between the groups of a 16-digit number (#312). Every output is checked
  // for the banned characters, against the mark rule and for a digit run a
  // reader would see; distinct outputs are each run through the validator once.
  it('every BMP code point and every stacked mark, cleaned, holds no banned character, keeps the mark rule, shows no long digit run and passes the chart validator', () => {
    const banned = /[:<>/\\`[\]*|~!\n\r]/
    const inputs: string[] = []
    const between = (c: string) => ['5550', '0123', '4567', '8901'].join(c)
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const c = String.fromCharCode(code)
      inputs.push(c, `a${c}b`, `${c}${c}${c}`, between(c))
    }
    const marks: string[] = []
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const c = String.fromCodePoint(code)
      if (/\p{M}/u.test(c)) marks.push(c)
      if (code > 0xffff && /\p{DI}/u.test(c)) inputs.push(between(c))
    }
    // On a letter and a digit (bases); at the start, after a space, after kept
    // punctuation and after a Hangul filler, which becomes a space (no base).
    for (const m of marks) {
      inputs.push(`a${m.repeat(20)}b`, `1${m.repeat(20)}`, `${m.repeat(20)}a`, ` ${m}${m}`, `a.${m}b`, `\u3164${m}a`)
    }
    inputs.push(`Z${marks.slice(0, 30).join('')}algo`, `Z${marks.slice(-30).join('')}algo`)
    const outputs = new Set<string>()
    for (const input of inputs) {
      const out = cleanLabel(input, FALLBACK)
      if (banned.test(out)) expect.fail(`${JSON.stringify(input)} leaves ${JSON.stringify(out)}`)
      const broken = markRuleBreak(out)
      if (broken !== null) expect.fail(`${JSON.stringify(input)} leaves ${JSON.stringify(out)}: ${broken}`)
      const run = visibleDigitRun(out)
      if (run !== null) expect.fail(`${JSON.stringify(input)} leaves ${JSON.stringify(out)}, which shows ${run}`)
      outputs.add(out)
    }
    for (const out of outputs) {
      if (!passesAsValue(out)) expect.fail(`${JSON.stringify(out)} is refused by the chart validator`)
    }
  })

  // #312: the Hangul fillers are letters that draw nothing and are
  // default-ignorable, so each becomes a space, as any other invisible
  // character does. NFKC folds U+3164 and U+FFA0 to U+1160 before the filter,
  // so a rule naming only the code points in the input would miss them. The
  // digits are invented (not Luhn-valid, not a known test card).
  const FILLERS: [string, string][] = [
    ['U+115F', '\u115F'],
    ['U+1160', '\u1160'],
    ['U+3164', '\u3164'],
    ['U+FFA0', '\uFFA0'],
  ]
  const GROUPS = ['5550', '0123', '4567', '8901']

  it.each(FILLERS)('#312: a 16-digit number split by %s is masked, as one split by spaces is', (_name, filler) => {
    expect(cleanLabel(GROUPS.join(filler), FALLBACK)).toBe('####')
    expect(cleanLabel(`Pay ${GROUPS.join(filler)} now`, FALLBACK)).toBe('Pay #### now')
    expect(cleanLabel(GROUPS.join(' '), FALLBACK)).toBe('####')
  })

  it.each(FILLERS)('#312: a label of only %s, once or repeated, is the fallback', (_name, filler) => {
    expect(cleanLabel(filler, FALLBACK)).toBe(FALLBACK)
    expect(cleanLabel(filler.repeat(3), FALLBACK)).toBe(FALLBACK)
    expect(cleanLabel(` ${filler} `, FALLBACK)).toBe(FALLBACK)
  })

  it.each(FILLERS)('#312: "Shop" with %s before or after it cleans to "Shop"', (_name, filler) => {
    expect(cleanLabel(`Shop${filler}`, FALLBACK)).toBe(cleanLabel('Shop', FALLBACK))
    expect(cleanLabel(`${filler}Shop${filler}${filler}`, FALLBACK)).toBe('Shop')
  })

  it.each(FILLERS)('#312: %s inside a word becomes a space, as any disallowed character does', (_name, filler) => {
    expect(cleanLabel(`Sh${filler}op`, FALLBACK)).toBe('Sh op')
  })

  // The sweep's digit-escape check, held to what it must see and must not.
  // U+FFF9 is a format character that is not default-ignorable, and the
  // Arabic-Indic digits are decimal digits outside ASCII, so each case pins a
  // part of the helper no other case reaches.
  it('visibleDigitRun sees eight digits in any script through what draws nothing, marks, spaces and hyphens, and not through a dot or a comma', () => {
    for (const label of [
      '55500123',
      '\u0665\u0665\u0665\u0660\u0660\u0661\u0662\u0663',
      '5550\u11600123\u11604567\u11608901',
      '5550\u31640123',
      '5550\u200B0123',
      '5550\uFFF90123',
      '5550 0123 4567 8901',
      '5550-0123-4567-8901',
      '5\u03015\u03015\u03010\u03010\u03011\u03012\u03013\u0301',
    ]) {
      expect(visibleDigitRun(label), JSON.stringify(label)).not.toBeNull()
    }
    for (const label of ['1,234,567.89', '5550.0123.4567.8901', '1234567', 'Flight NZ 123 4567', 'Pay #### now']) {
      expect(visibleDigitRun(label), JSON.stringify(label)).toBeNull()
    }
  })
})

// Why a cleaned label breaks #304's mark rule, or null: every run of marks
// follows a letter or number that is not default-ignorable and holds at most
// three, and no mark is an enclosing or default-ignorable one.
function markRuleBreak(label: string): string | null {
  const chars = Array.from(label)
  let run = 0
  for (let i = 0; i < chars.length; i += 1) {
    if (!/\p{M}/u.test(chars[i])) {
      run = 0
      continue
    }
    if (/[\p{Me}\p{DI}]/u.test(chars[i])) return 'an enclosing or default-ignorable mark'
    if (run === 0 && (i === 0 || !/^(?!\p{DI})[\p{L}\p{N}]$/u.test(chars[i - 1]))) return 'a mark with no base'
    run += 1
    if (run > 3) return 'more than three marks on one base'
  }
  return null
}

// Eight decimal digits a reader would see as one run in a cleaned label, or
// null (#312). Written apart from cleanLabel, and sharing none of its
// patterns, so a gap in the mask cannot hide in both: it removes what draws
// nothing or only decorates a digit (default-ignorable and format characters,
// marks) and the separators the mask counts through (whitespace and dashes),
// then looks for eight digits in a row. A dot or a comma is left in, so
// "1,234,567.89" ends its runs there, as the mask intends.
function visibleDigitRun(label: string): string | null {
  const seen = label.replace(/[\p{DI}\p{M}\p{Cf}\p{White_Space}\p{Pd}]/gu, '')
  return /\p{Nd}{8}/u.exec(seen)?.[0] ?? null
}

// A label as a chart data value, as prompt.ts writes it.
function passesAsValue(label: string): boolean {
  return validateChartSpec({
    data: { values: [{ merchant: label, spend_cents: 100 }] },
    mark: 'bar',
    encoding: { x: { field: 'merchant', type: 'nominal' }, y: { field: 'spend_cents', type: 'quantitative' } },
  }).ok
}

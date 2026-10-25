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

function personalSpend(from: string, to: string, transferIds: number[]) {
  return connection('transactions as t')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'a.scope': 'personal', 'a.source': 'akahu', 't.source': 'akahu', 't.status': 'settled' })
    .where('t.amount_cents', '<', 0)
    .whereBetween('t.date', [from, to])
    .whereNotIn('t.id', transferIds)
}

async function oracleBy(
  column: 'merchant_name' | 'category',
  from: string,
  to: string,
  transferIds: number[],
): Promise<Map<string, { spend: number; count: number }>> {
  const rows: { label: string | null; total: number; n: number }[] = await personalSpend(from, to, transferIds)
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
    const transferIds = await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    const oracle = [...(await oracleBy('merchant_name', NZ_WEEK.start, NZ_WEEK.end, transferIds))]
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
    const transferIds = await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    const now = await oracleBy('category', NZ_WEEK.start, NZ_WEEK.end, transferIds)
    const then = await oracleBy('category', NZ_LAST_WEEK.start, NZ_LAST_WEEK.end, transferIds)
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
    const transferIds = await seedLedger()
    const a = await collectAggregates('personal', WEEK)
    const expected: { month: string; category: string; spendCents: number }[] = []
    for (const [month, from, to] of NZ_MONTHS) {
      const cells = [...(await oracleBy('category', from, to, transferIds))]
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
    const checked = validateChartSpec({
      data: { values: [{ merchant: out, spend_cents: 100 }] },
      mark: 'bar',
      encoding: { x: { field: 'merchant', type: 'nominal' }, y: { field: 'spend_cents', type: 'quantitative' } },
    })
    expect(checked.ok).toBe(true)
  })
})

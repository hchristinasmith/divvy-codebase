import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import * as shared from '../../../shared/safe-to-spend.ts'
import type { SafeToSpendInput } from '../../../shared/safe-to-spend.ts'
import {
  OverviewDataError,
  RECENT_ACTIVITY_LIMIT,
  billOccurrencesThrough,
  dismissAlert,
  nzCalendarDate,
  readOverview,
} from '../overview.ts'

// The overview's data module (prd-02, issue #44). Every value below is
// invented.

// The real safe-to-spend, behind a spy, so a test can see what it was
// handed or make it return sentinels.
vi.mock('../../../shared/safe-to-spend.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../shared/safe-to-spend.ts')>()
  return { ...real, safeToSpend: vi.fn(real.safeToSpend) }
})

describe('nzCalendarDate', () => {
  it('reads the date in Pacific/Auckland, not UTC', () => {
    // 23:30 UTC on the 27th is 12:30 NZDT on the 28th.
    expect(nzCalendarDate(new Date('2026-10-27T23:30:00Z'))).toBe('2026-10-28')
    // NZST in winter (UTC+12): 12:30 UTC on 30 June is 00:30 on 1 July.
    expect(nzCalendarDate(new Date('2026-06-30T12:30:00Z'))).toBe('2026-07-01')
    // Just before NZ midnight stays on the NZ day.
    expect(nzCalendarDate(new Date('2026-10-26T10:59:00Z'))).toBe('2026-10-26')
    expect(nzCalendarDate(new Date('2026-10-26T11:00:00Z'))).toBe('2026-10-27')
  })

  it('refuses an invalid Date with a fixed text', () => {
    const run = () => nzCalendarDate(new Date('not a date'))
    expect(run).toThrow(OverviewDataError)
    expect(run).toThrow('a transaction is incomplete')
  })
})

describe('billOccurrencesThrough', () => {
  const bill = (
    repeat: 'none' | 'weekly' | 'monthly' | 'yearly',
    first: string,
  ) => ({
    repeat,
    first_due_date: first,
  })

  it('weekly: every seventh day from the anchor, through the date given', () => {
    expect(
      billOccurrencesThrough(bill('weekly', '2026-10-07'), '2026-11-03'),
    ).toStrictEqual(['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28'])
  })

  it('weekly: an occurrence on `through` is included, one the day after is not', () => {
    expect(
      billOccurrencesThrough(bill('weekly', '2026-10-14'), '2026-10-28'),
    ).toStrictEqual(['2026-10-14', '2026-10-21', '2026-10-28'])
    expect(
      billOccurrencesThrough(bill('weekly', '2026-10-14'), '2026-10-27'),
    ).toStrictEqual(['2026-10-14', '2026-10-21'])
  })

  it.each(['none', 'weekly', 'monthly', 'yearly'] as const)(
    '%s: an anchor on `through` is the only occurrence; one after it gives none',
    (repeat) => {
      expect(
        billOccurrencesThrough(bill(repeat, '2026-10-30'), '2026-10-30'),
      ).toStrictEqual(['2026-10-30'])
      expect(
        billOccurrencesThrough(bill(repeat, '2026-10-31'), '2026-10-30'),
      ).toStrictEqual([])
    },
  )

  it('monthly on the 31st clamps to each shorter month and returns to the 31st (no drift)', () => {
    expect(
      billOccurrencesThrough(bill('monthly', '2026-01-31'), '2026-05-31'),
    ).toStrictEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ])
  })

  it('monthly on the 31st falls on 29 February in a leap year', () => {
    expect(
      billOccurrencesThrough(bill('monthly', '2028-01-31'), '2028-03-01'),
    ).toStrictEqual(['2028-01-31', '2028-02-29'])
  })

  it('monthly crosses the year end', () => {
    expect(
      billOccurrencesThrough(bill('monthly', '2026-11-15'), '2027-02-15'),
    ).toStrictEqual(['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15'])
  })

  it('yearly on 29 February falls on 28 February outside leap years', () => {
    expect(
      billOccurrencesThrough(bill('yearly', '2028-02-29'), '2032-03-01'),
    ).toStrictEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ])
  })

  it('none: the anchor alone, however far `through` reaches', () => {
    expect(
      billOccurrencesThrough(bill('none', '2026-10-20'), '2027-10-20'),
    ).toStrictEqual(['2026-10-20'])
  })

  it('a far-reaching expansion stays ascending and has no repeats', () => {
    for (const repeat of ['weekly', 'monthly', 'yearly'] as const) {
      const dates = billOccurrencesThrough(
        bill(repeat, '2024-01-31'),
        '2030-12-31',
      )
      expect(new Set(dates).size, repeat).toBe(dates.length)
      expect([...dates].sort(), repeat).toStrictEqual(dates)
      for (const d of dates) expect(d, repeat).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('years 0 to 99 are not read as 1900 to 1999', () => {
    expect(
      billOccurrencesThrough(bill('weekly', '0050-12-28'), '0051-01-04'),
    ).toStrictEqual(['0050-12-28', '0051-01-04'])
  })
})

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  vi.mocked(shared.safeToSpend).mockClear()
})

afterAll(async () => {
  await connection.destroy()
})

// 23:30 UTC on Tuesday 27 October is 12:30 NZDT on Wednesday the 28th. With
// payday on Tuesdays (the default) the last payday is 10-27, the next is
// 11-03 and there are 6 days to go.
const NOW = new Date('2026-10-27T23:30:00Z')
const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

// Row builders: a copy of the account/transaction builders in
// server/db/__tests__/synced.test.ts and
// server/routes/__tests__/accounts.test.ts (and this file's fixture is
// copied again in server/routes/__tests__/overview.test.ts).
function account(fields: Row): Row {
  return {
    source: 'akahu',
    name: 'Invented account',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

// A settled Akahu row on `accountId` (an akahu_id), dated `date` (UTC).
function tx(
  accountId: string | null,
  date: string | null,
  amountCents: number | null,
  fields: Row = {},
): Row {
  return {
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: 'Invented purchase',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

function setting(
  id: string,
  key: string,
  value: string | null,
  updatedAt = STAMP,
): Row {
  return { id, user_id: 1, key, value, updated_at: updatedAt }
}

async function insertUser() {
  await connection('users').insert({
    id: 1,
    email: 'invented@example.invalid',
    password: 'x',
  })
}

// Sentinels that must never reach an overview payload.
const SECRET_TOKENS = [
  'acc_sentinel_',
  '00-SENT-',
  'Sentinel Bank 91c2',
  'conn_sentinel_',
]

const AKAHU = {
  everyday: 'acc_sentinel_everyday',
  savings: 'acc_sentinel_savings',
  personalPot: 'acc_sentinel_ppot',
  visa: 'acc_sentinel_visa',
  spare: 'acc_sentinel_spare',
  trading: 'acc_sentinel_trading',
  strawbPot: 'acc_sentinel_spot',
}

/** The plan's main fixture. Figures it must produce are in the tests. */
async function seedMain() {
  await insertUser()
  await connection('settings').insert([
    setting('s-profit', 'profit_cents', '1000000'),
    setting('s-ptax', 'personal_tax_owed_cents', '120000'),
  ])
  const sentinel = (n: number, akahuId: string) => ({
    akahu_id: akahuId,
    formatted_account: `00-SENT-000000${n}-00`,
    connection_id: `conn_sentinel_${n}`,
    connection_name: 'Sentinel Bank 91c2',
  })
  await connection('accounts').insert([
    account({
      id: 1,
      ...sentinel(1, AKAHU.everyday),
      name: 'Everyday',
      scope: 'personal',
      balance_cents: 250000,
    }),
    account({
      id: 2,
      ...sentinel(2, AKAHU.savings),
      name: 'Savings',
      scope: 'personal',
      balance_cents: 800000,
    }),
    account({
      id: 3,
      ...sentinel(3, AKAHU.personalPot),
      name: 'Personal tax pot',
      scope: 'personal',
      balance_cents: 30000,
    }),
    account({
      id: 4,
      ...sentinel(4, AKAHU.visa),
      name: 'Visa',
      scope: 'personal',
      balance_cents: -45000,
    }),
    account({
      id: 5,
      ...sentinel(5, AKAHU.spare),
      name: 'Spare',
      scope: 'personal',
      balance_cents: 12300,
    }),
    account({
      id: 6,
      ...sentinel(6, AKAHU.trading),
      name: 'Trading',
      scope: 'strawb',
      balance_cents: 600000,
    }),
    account({
      id: 7,
      ...sentinel(7, AKAHU.strawbPot),
      name: 'Strawb tax pot',
      scope: 'strawb',
      balance_cents: 50000,
    }),
    account({
      id: 8,
      akahu_id: null,
      source: 'xero',
      name: 'Xero ledger',
      scope: 'strawb',
      balance_cents: 777700,
    }),
  ])
  await connection('account_settings').insert(
    (
      [
        [1, 'current'],
        [2, 'savings'],
        [3, 'tax_pot'],
        [4, 'credit_card'],
        [6, 'current'],
        [7, 'tax_pot'],
        [8, 'current'],
      ] as const
    ).map(([account_id, role]) => ({ account_id, role, updated_at: STAMP })),
  )
  await connection('budgets').insert([
    {
      id: 1,
      scope: 'personal',
      category: 'Groceries',
      limit_cents: 20000,
      created_at: STAMP,
      updated_at: STAMP,
    },
    {
      id: 2,
      scope: 'personal',
      category: 'Eating out',
      limit_cents: 5000,
      created_at: STAMP,
      updated_at: STAMP,
    },
    {
      id: 3,
      scope: 'strawb',
      category: 'Software',
      limit_cents: 10000,
      created_at: STAMP,
      updated_at: STAMP,
    },
  ])
  const bill = (
    id: number,
    scope: string,
    name: string,
    repeat: string,
    amount: number,
    first: string,
  ) => ({
    id,
    scope,
    name,
    repeat,
    amount_cents: amount,
    first_due_date: first,
    created_at: STAMP,
    updated_at: STAMP,
  })
  await connection('bills').insert([
    bill(1, 'personal', 'Flat rent', 'weekly', 20000, '2026-10-07'),
    bill(2, 'personal', 'Internet', 'monthly', 8000, '2026-08-31'),
    bill(3, 'personal', 'Dentist', 'none', 9000, '2026-10-20'),
    bill(4, 'personal', 'Rego', 'none', 15000, '2026-11-10'),
    bill(5, 'strawb', 'Hosting', 'monthly', 12000, '2026-10-30'),
  ])
  await connection('bill_payments').insert([
    { bill_id: 1, due_date: '2026-10-07', amount_cents: 20000, paid_at: STAMP },
    { bill_id: 2, due_date: '2026-08-31', amount_cents: 8000, paid_at: STAMP },
    { bill_id: 3, due_date: '2026-10-20', amount_cents: 9000, paid_at: STAMP },
  ])
  await connection('transactions').insert([
    // 12:00 UTC on the 26th is 01:00 NZ on the 27th, payday: it counts.
    tx(AKAHU.everyday, '2026-10-26T12:00:00.000Z', -8000, {
      id: 1,
      category: 'Groceries',
      description: 'Groceries run',
    }),
    tx(AKAHU.everyday, '2026-10-27T05:00:00.000Z', -1500, {
      id: 2,
      category: 'Groceries',
      category_source: 'user',
      akahu_category_name: 'Eating out',
      description: 'Recategorised',
    }),
    tx(AKAHU.everyday, '2026-10-27T01:00:00.000Z', 4000, {
      id: 3,
      category: 'Groceries',
      description: 'Refund',
    }),
    // 10:59 UTC on the 26th is 23:59 NZ on the 26th, before payday.
    tx(AKAHU.everyday, '2026-10-26T10:59:00.000Z', -9999, {
      id: 4,
      category: 'Groceries',
      description: 'Old groceries',
    }),
    tx(AKAHU.everyday, '2026-10-27T23:00:00.000Z', -3000, {
      id: 5,
      status: 'pending',
      description: 'Pending tap',
    }),
    tx(AKAHU.visa, '2026-10-27T20:00:00.000Z', -7000, {
      id: 6,
      category: 'Eating out',
      description: 'Dinner',
    }),
    tx(AKAHU.trading, '2026-10-27T18:00:00.000Z', -2500, {
      id: 7,
      category: 'Software',
      description: 'Licence',
    }),
    tx(AKAHU.trading, '2026-10-27T16:00:00.000Z', -6000, {
      id: 8,
      category: 'Groceries',
      description: 'Studio snacks',
    }),
    // Distractors: an account that is not stored, and a Xero row.
    tx('acc_nobody', '2026-10-27T10:00:00.000Z', -5000, {
      id: 9,
      category: 'Groceries',
      description: 'Orphan',
    }),
    tx(AKAHU.trading, '2026-10-27T11:00:00.000Z', -4000, {
      id: 10,
      category: 'Software',
      source: 'xero',
      description: 'Xero spend',
    }),
  ])
}

function lastInput(): SafeToSpendInput {
  const calls = vi.mocked(shared.safeToSpend).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0]
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

async function snapshotTables(): Promise<Record<string, Row[]>> {
  const tables: { name: string }[] = await connection('sqlite_master')
    .select('name')
    .where({ type: 'table' })
    .whereNot('name', 'like', 'knex_%')
    .whereNot('name', 'like', 'sqlite_%')
    .orderBy('name')
  const out: Record<string, Row[]> = {}
  for (const { name } of tables) {
    out[name] = await connection(name).select().orderByRaw('rowid')
  }
  return out
}

describe('readOverview: safe-to-spend is computed once, by the shared module', () => {
  it('calls safeToSpend once and sends its result untouched', async () => {
    await seedMain()
    vi.mocked(shared.safeToSpend).mockImplementationOnce((input) => {
      const real = vi.mocked(shared.safeToSpend).getMockImplementation()
      expect(real).toBeDefined()
      const result = (real as typeof shared.safeToSpend)(input)
      return {
        ...result,
        safeCents: 123456789,
        budgets: result.budgets.map((b, i) =>
          i === 0 ? { ...b, overCents: 777 } : b,
        ),
      }
    })

    const body = await readOverview('personal', NOW, connection)

    expect(vi.mocked(shared.safeToSpend)).toHaveBeenCalledTimes(1)
    expect(body.safeToSpend.safeCents).toBe(123456789)
    expect(body.safeToSpend.budgets[0].overCents).toBe(777)
    // The over-budget amount is read off the result, not recomputed.
    const groceries = body.alerts.find(
      (a) => a.id === 'over_budget:1:2026-10-27',
    )
    expect(groceries?.amountCents).toBe(777)
  })

  it('hands it every stored Akahu account, unpaid occurrence and window row, and nothing else', async () => {
    await seedMain()
    // A row well before the window.
    await connection('transactions').insert(
      tx(AKAHU.everyday, '2026-10-20T00:00:00.000Z', -1111, {
        category: 'Groceries',
      }),
    )

    await readOverview('strawb', NOW, connection)
    const input = lastInput()

    expect(input.scope).toBe('strawb')
    expect(input.today).toBe('2026-10-28')
    expect(input.accounts.map((a) => a.id)).toStrictEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ])
    expect(input.accounts.find((a) => a.id === '5')?.role).toBeNull()
    const billIds = input.bills.map((b) => b.id)
    expect(new Set(billIds).size).toBe(billIds.length)
    for (const id of billIds) expect(id).toMatch(/^[1-9]\d*:\d{4}-\d{2}-\d{2}$/)
    expect([...billIds].sort()).toStrictEqual(
      [
        '1:2026-10-14',
        '1:2026-10-21',
        '1:2026-10-28',
        '2:2026-09-30',
        '2:2026-10-31',
        '5:2026-10-30',
      ].sort(),
    )
    expect(input.bills.every((b) => b.paid === false)).toBe(true)

    const known = new Set(input.accounts.map((a) => a.id))
    for (const t of input.transactions) {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(known.has(t.accountId)).toBe(true)
    }
    const amounts = input.transactions
      .map((t) => t.amountCents)
      .sort((a, b) => a - b)
    // Not the orphan (-5000), the Xero row (-4000) or the pre-window -1111.
    expect(amounts).toStrictEqual([
      -9999, -8000, -7000, -6000, -3000, -2500, -1500, 4000,
    ])
  })
})

describe('readOverview: the figures, by hand', () => {
  // Spent this week: Groceries 8000 + 1500 = 9500 (the refund is money in,
  // the 10-26 row predates payday, the pending row has no category, and the
  // Trading row is Strawb's); Eating out 7000, 2000 over; Software 2500.
  it.each([
    [
      'personal',
      {
        liquidCents: 250000,
        // Flat rent 10-14, 10-21 and 10-28 (#151: every unpaid week) +
        // Internet 09-30 and 10-31.
        unpaidBillsCents: 76000,
        remainingBudgetCents: 10500,
        strawbTaxOwedCents: 0,
        strawbTaxPotCents: 0,
        strawbBillsBufferCents: 0,
        strawbTaxHoldCents: 0,
        personalTaxOwedCents: 120000,
        personalTaxPotCents: 30000,
        personalTaxHoldCents: 90000,
        taxHoldCents: 90000,
        cardDebtCents: 45000,
        safeCents: 28500,
        shortByCents: 0,
        daysToPayday: 6,
        perDayCents: 4750,
      },
    ],
    [
      'strawb',
      {
        liquidCents: 600000,
        unpaidBillsCents: 0,
        remainingBudgetCents: 7500,
        strawbTaxOwedCents: 250000,
        strawbTaxPotCents: 50000,
        strawbBillsBufferCents: 12000,
        strawbTaxHoldCents: 212000,
        personalTaxOwedCents: 0,
        personalTaxPotCents: 0,
        personalTaxHoldCents: 0,
        taxHoldCents: 212000,
        cardDebtCents: 0,
        safeCents: 380500,
        shortByCents: 0,
        daysToPayday: 6,
        perDayCents: 63416,
      },
    ],
    [
      'all',
      {
        liquidCents: 850000,
        unpaidBillsCents: 76000,
        remainingBudgetCents: 18000,
        strawbTaxOwedCents: 250000,
        strawbTaxPotCents: 50000,
        strawbBillsBufferCents: 12000,
        strawbTaxHoldCents: 212000,
        personalTaxOwedCents: 120000,
        personalTaxPotCents: 30000,
        personalTaxHoldCents: 90000,
        taxHoldCents: 302000,
        cardDebtCents: 45000,
        safeCents: 409000,
        shortByCents: 0,
        daysToPayday: 6,
        perDayCents: 68166,
      },
    ],
  ] as const)('%s', async (scope, figures) => {
    await seedMain()

    const { safeToSpend: result } = await readOverview(scope, NOW, connection)

    expect(result).toMatchObject({
      scope,
      today: '2026-10-28',
      lastPayday: '2026-10-27',
      nextPayday: '2026-11-03',
      ...figures,
    })
  })

  it('budget lines carry spent, remaining and over per scope', async () => {
    await seedMain()

    const { safeToSpend: result } = await readOverview('all', NOW, connection)

    expect(result.budgets).toStrictEqual([
      {
        id: '1',
        scope: 'personal',
        category: 'Groceries',
        limitCents: 20000,
        spentCents: 9500,
        remainingCents: 10500,
        overCents: 0,
      },
      {
        id: '2',
        scope: 'personal',
        category: 'Eating out',
        limitCents: 5000,
        spentCents: 7000,
        remainingCents: 0,
        overCents: 2000,
      },
      {
        id: '3',
        scope: 'strawb',
        category: 'Software',
        limitCents: 10000,
        spentCents: 2500,
        remainingCents: 7500,
        overCents: 0,
      },
    ])
  })
})

describe('readOverview: dates are Pacific/Auckland', () => {
  it('today is the NZ date, and a row is counted on its NZ date', async () => {
    await seedMain()

    await readOverview('personal', NOW, connection)
    const input = lastInput()

    expect(input.today).toBe('2026-10-28')
    const dated = (amount: number) =>
      input.transactions.find((t) => t.amountCents === amount)?.date
    // 2026-10-26T12:00Z is NZ 10-27 (payday): inside the week.
    expect(dated(-8000)).toBe('2026-10-27')
    // 2026-10-26T10:59Z is NZ 10-26: before it.
    expect(dated(-9999)).toBe('2026-10-26')
  })
})

describe('readOverview: settings', () => {
  beforeEach(async () => {
    await seedMain()
    await connection('settings').del()
  })

  it('takes every default when no setting is stored', async () => {
    await readOverview('all', NOW, connection)
    const input = lastInput()

    expect({
      taxRateBasisPoints: input.taxRateBasisPoints,
      profitCents: input.profitCents,
      paydayWeekday: input.paydayWeekday,
      personalTaxOwedCents: input.personalTaxOwedCents,
    }).toStrictEqual({
      taxRateBasisPoints: 2500,
      profitCents: 0,
      paydayWeekday: 2,
      personalTaxOwedCents: 0,
    })
  })

  it('uses stored values', async () => {
    await connection('settings').insert([
      setting('a', 'tax_rate_bp', '1050'),
      setting('b', 'profit_cents', '-300'),
      setting('c', 'payday_weekday', '5'),
      setting('d', 'personal_tax_owed_cents', '4321'),
    ])

    await readOverview('all', NOW, connection)
    const input = lastInput()

    expect(input.taxRateBasisPoints).toBe(1050)
    expect(input.profitCents).toBe(-300)
    expect(input.paydayWeekday).toBe(5)
    expect(input.personalTaxOwedCents).toBe(4321)
  })

  it('with several rows for one key, the newest updated_at wins, then the higher id', async () => {
    await connection('settings').insert([
      setting('p-1', 'profit_cents', '111', '2026-10-01T00:00:00.000Z'),
      setting('p-2', 'profit_cents', '222', '2026-10-20T00:00:00.000Z'),
      setting('p-0', 'profit_cents', '333', '2026-10-05T00:00:00.000Z'),
      setting(
        't-1',
        'personal_tax_owed_cents',
        '10',
        '2026-10-20T00:00:00.000Z',
      ),
      setting(
        't-2',
        'personal_tax_owed_cents',
        '20',
        '2026-10-20T00:00:00.000Z',
      ),
    ])

    await readOverview('all', NOW, connection)
    const input = lastInput()

    expect(input.profitCents).toBe(222)
    expect(input.personalTaxOwedCents).toBe(20)
  })

  it.each([
    ['not a number', 'sentinel-bad-1234'],
    ['NULL', null],
    ['a decimal', '12.5'],
    ['beyond a safe integer', '9007199254740993'],
    ['blank', ''],
  ])(
    'a stored value that is %s is refused, never defaulted',
    async (_why, value) => {
      await connection('settings').insert(setting('x', 'profit_cents', value))

      const err = await errorOf(() => readOverview('all', NOW, connection))

      expect(err).toBeInstanceOf(OverviewDataError)
      expect((err as Error).message).toBe('a stored setting is not valid')
      expect(vi.mocked(shared.safeToSpend)).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['payday_weekday', '9'],
    ['tax_rate_bp', '20000'],
    ['personal_tax_owed_cents', '-5'],
  ])(
    '%s=%s is a whole number the shared module refuses',
    async (key, value) => {
      await connection('settings').insert(setting('x', key, value))

      const err = await errorOf(() => readOverview('all', NOW, connection))

      expect(err).toBeInstanceOf(OverviewDataError)
      expect((err as Error).message).toBe('safe-to-spend input invalid')
      expect((err as Error).message).not.toContain(value)
    },
  )
})

describe('readOverview: rows it refuses', () => {
  it('an Akahu account with no balance', async () => {
    await seedMain()
    await connection('accounts')
      .where({ id: 5 })
      .update({ balance_cents: null })

    const err = await errorOf(() => readOverview('strawb', NOW, connection))

    expect(err).toBeInstanceOf(OverviewDataError)
    expect((err as Error).message).toBe('an account has no balance')
  })

  it('a Xero account with no balance is never read', async () => {
    await seedMain()
    await connection('accounts')
      .where({ id: 8 })
      .update({ balance_cents: null })

    await expect(readOverview('strawb', NOW, connection)).resolves.toBeDefined()
  })
})

describe('#151: every unpaid occurrence through the next payday counts', () => {
  it('a weekly bill two cycles overdue is three occurrences, and the paid one is none', async () => {
    await seedMain()

    const body = await readOverview('personal', NOW, connection)
    const rent = lastInput().bills.filter((b) => b.id.startsWith('1:'))

    expect(rent).toStrictEqual([
      {
        id: '1:2026-10-14',
        scope: 'personal',
        amountCents: 20000,
        dueDate: '2026-10-14',
        paid: false,
      },
      {
        id: '1:2026-10-21',
        scope: 'personal',
        amountCents: 20000,
        dueDate: '2026-10-21',
        paid: false,
      },
      {
        id: '1:2026-10-28',
        scope: 'personal',
        amountCents: 20000,
        dueDate: '2026-10-28',
        paid: false,
      },
    ])
    const rentAlerts = body.alerts
      .filter((a) => a.subject === 'Flat rent')
      .map((a) => a.id)
    expect(rentAlerts).toStrictEqual([
      'bill_overdue:1:2026-10-14',
      'bill_overdue:1:2026-10-21',
      'bill_due_soon:1:2026-10-28',
    ])
  })

  async function weeklyBillFrom(firstDue: string) {
    await connection('accounts').insert(
      account({
        id: 1,
        akahu_id: 'acc_a',
        scope: 'personal',
        balance_cents: 100,
      }),
    )
    await connection('bills').insert({
      id: 1,
      scope: 'personal',
      name: 'Backdated',
      repeat: 'weekly',
      amount_cents: 100,
      first_due_date: firstDue,
      created_at: STAMP,
      updated_at: STAMP,
    })
  }
  // The next payday is 2026-11-03; a weekly bill anchored 999 weeks before
  // it has exactly 1000 occurrences through it.
  const weeksBefore = (weeks: number) => {
    const d = new Date('2026-11-03T00:00:00Z')
    d.setUTCDate(d.getUTCDate() - 7 * weeks)
    return d.toISOString().slice(0, 10)
  }

  it('a bill with 1000 unpaid occurrences is read', async () => {
    await weeklyBillFrom(weeksBefore(999))

    await readOverview('personal', NOW, connection)

    expect(lastInput().bills).toHaveLength(1000)
  })

  it('a bill with more than 1000 unpaid occurrences is refused, not truncated', async () => {
    await weeklyBillFrom(weeksBefore(1000))

    const err = await errorOf(() => readOverview('personal', NOW, connection))

    expect(err).toBeInstanceOf(OverviewDataError)
    expect((err as Error).message).toBe(
      'a bill has too many unpaid occurrences',
    )
  })
})

describe('readOverview: alerts', () => {
  const PERSONAL_ALERTS = [
    {
      id: 'over_budget:2:2026-10-27',
      kind: 'over_budget',
      scope: 'personal',
      subject: 'Eating out',
      amountCents: 2000,
      dueDate: null,
    },
    {
      id: 'bill_overdue:2:2026-09-30',
      kind: 'bill_overdue',
      scope: 'personal',
      subject: 'Internet',
      amountCents: 8000,
      dueDate: '2026-09-30',
    },
    {
      id: 'bill_overdue:1:2026-10-14',
      kind: 'bill_overdue',
      scope: 'personal',
      subject: 'Flat rent',
      amountCents: 20000,
      dueDate: '2026-10-14',
    },
    {
      id: 'bill_overdue:1:2026-10-21',
      kind: 'bill_overdue',
      scope: 'personal',
      subject: 'Flat rent',
      amountCents: 20000,
      dueDate: '2026-10-21',
    },
    {
      id: 'bill_due_soon:1:2026-10-28',
      kind: 'bill_due_soon',
      scope: 'personal',
      subject: 'Flat rent',
      amountCents: 20000,
      dueDate: '2026-10-28',
    },
    {
      id: 'bill_due_soon:2:2026-10-31',
      kind: 'bill_due_soon',
      scope: 'personal',
      subject: 'Internet',
      amountCents: 8000,
      dueDate: '2026-10-31',
    },
  ]
  const HOSTING = {
    id: 'bill_due_soon:5:2026-10-30',
    kind: 'bill_due_soon',
    scope: 'strawb',
    subject: 'Hosting',
    amountCents: 12000,
    dueDate: '2026-10-30',
  }

  it('personal, strawb and all, exactly and in order', async () => {
    await seedMain()

    const personal = await readOverview('personal', NOW, connection)
    const strawb = await readOverview('strawb', NOW, connection)
    const all = await readOverview('all', NOW, connection)

    expect(personal.alerts).toStrictEqual(PERSONAL_ALERTS)
    expect(strawb.alerts).toStrictEqual([HOSTING])
    expect(all.alerts).toStrictEqual([
      ...PERSONAL_ALERTS.slice(0, 5),
      HOSTING,
      PERSONAL_ALERTS[5],
    ])
    for (const alert of all.alerts) {
      expect(Object.keys(alert).sort()).toStrictEqual([
        'amountCents',
        'dueDate',
        'id',
        'kind',
        'scope',
        'subject',
      ])
    }
  })

  it('a budget spent exactly to its limit is not over', async () => {
    await seedMain()
    await connection('budgets').where({ id: 2 }).update({ limit_cents: 7000 })

    const body = await readOverview('personal', NOW, connection)

    expect(body.alerts.filter((a) => a.kind === 'over_budget')).toStrictEqual(
      [],
    )
  })

  it('due yesterday is overdue, due today and due on the next payday are due soon, the day after is neither', async () => {
    await seedMain()
    const oneOff = (id: number, due: string) => ({
      id,
      scope: 'personal',
      name: `One-off ${id}`,
      repeat: 'none',
      amount_cents: 100,
      first_due_date: due,
      created_at: STAMP,
      updated_at: STAMP,
    })
    await connection('bills').insert([
      oneOff(11, '2026-10-27'),
      oneOff(12, '2026-10-28'),
      oneOff(13, '2026-11-03'),
      oneOff(14, '2026-11-04'),
    ])

    const body = await readOverview('personal', NOW, connection)
    const kinds = Object.fromEntries(
      body.alerts
        .filter((a) => a.subject.startsWith('One-off'))
        .map((a) => [a.subject, a.kind]),
    )

    expect(kinds).toStrictEqual({
      'One-off 11': 'bill_overdue',
      'One-off 12': 'bill_due_soon',
      'One-off 13': 'bill_due_soon',
    })
  })

  it('a dismissed alert is left out; the rest stay', async () => {
    await seedMain()
    await connection('alert_dismissals').insert({
      alert_id: 'bill_overdue:1:2026-10-14',
      dismissed_at: STAMP,
    })

    const body = await readOverview('personal', NOW, connection)

    expect(body.alerts.map((a) => a.id)).toStrictEqual(
      PERSONAL_ALERTS.map((a) => a.id).filter(
        (id) => id !== 'bill_overdue:1:2026-10-14',
      ),
    )
  })

  it('an over-budget dismissal lasts a week: a new week over budget is a new alert', async () => {
    await seedMain()
    await connection('alert_dismissals').insert({
      alert_id: 'over_budget:2:2026-10-27',
      dismissed_at: STAMP,
    })
    // NZ Wednesday 11-04: the week from payday 11-03, over by 1000 again.
    const nextWeek = new Date('2026-11-03T22:00:00Z')
    await connection('transactions').insert(
      tx(AKAHU.visa, '2026-11-03T21:00:00.000Z', -6000, {
        category: 'Eating out',
      }),
    )

    const before = await readOverview('personal', NOW, connection)
    const after = await readOverview('personal', nextWeek, connection)

    expect(before.alerts.some((a) => a.kind === 'over_budget')).toBe(false)
    expect(after.alerts.filter((a) => a.kind === 'over_budget')).toStrictEqual([
      {
        id: 'over_budget:2:2026-11-03',
        kind: 'over_budget',
        scope: 'personal',
        subject: 'Eating out',
        amountCents: 1000,
        dueDate: null,
      },
    ])
  })
})

describe('dismissAlert', () => {
  it('stores a derived alert and answers its id and time', async () => {
    await seedMain()

    const res = await dismissAlert(
      'bill_due_soon:5:2026-10-30',
      NOW,
      connection,
    )

    expect(res).toStrictEqual({
      id: 'bill_due_soon:5:2026-10-30',
      dismissedAt: '2026-10-27T23:30:00.000Z',
    })
    expect(await connection('alert_dismissals').select()).toStrictEqual([
      {
        alert_id: 'bill_due_soon:5:2026-10-30',
        dismissed_at: '2026-10-27T23:30:00.000Z',
      },
    ])
  })

  it('dismissing again keeps the first time and one row', async () => {
    await seedMain()
    await dismissAlert('bill_overdue:1:2026-10-21', NOW, connection)

    const again = await dismissAlert(
      'bill_overdue:1:2026-10-21',
      new Date('2026-10-28T01:00:00Z'),
      connection,
    )

    expect(again).toStrictEqual({
      id: 'bill_overdue:1:2026-10-21',
      dismissedAt: '2026-10-27T23:30:00.000Z',
    })
    expect(
      await connection('alert_dismissals').count({ n: '*' }),
    ).toStrictEqual([{ n: 1 }])
  })

  it.each([
    ['a paid occurrence', 'bill_overdue:1:2026-10-07'],
    ['an occurrence beyond the next payday', 'bill_due_soon:4:2026-11-10'],
    ['a date that is not an occurrence', 'bill_due_soon:5:2026-10-31'],
    ['the wrong kind for its date', 'bill_overdue:1:2026-10-28'],
    ['a budget that is not over', 'over_budget:1:2026-10-27'],
    ['an over budget from another week', 'over_budget:2:2026-10-20'],
    ['a bill that does not exist', 'bill_due_soon:99:2026-10-30'],
  ])('answers null for %s and stores nothing', async (_why, id) => {
    await seedMain()

    expect(await dismissAlert(id, NOW, connection)).toBeNull()
    expect(await connection('alert_dismissals').select()).toStrictEqual([])
  })
})

describe('readOverview: account cards', () => {
  it('carry only the card fields, in id order, scoped', async () => {
    await seedMain()

    const all = await readOverview('all', NOW, connection)
    const personal = await readOverview('personal', NOW, connection)
    const strawb = await readOverview('strawb', NOW, connection)

    for (const card of all.accounts) {
      expect(Object.keys(card).sort()).toStrictEqual([
        'balanceCents',
        'id',
        'name',
        'role',
        'scope',
      ])
    }
    expect(all.accounts.map((a) => a.id)).toStrictEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ])
    expect(personal.accounts.map((a) => a.id)).toStrictEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    expect(strawb.accounts.map((a) => a.id)).toStrictEqual(['6', '7'])
    expect(all.accounts[3]).toStrictEqual({
      id: '4',
      name: 'Visa',
      scope: 'personal',
      role: 'credit_card',
      balanceCents: -45000,
    })
    expect(all.accounts[4]).toStrictEqual({
      id: '5',
      name: 'Spare',
      scope: 'personal',
      role: null,
      balanceCents: 12300,
    })
    const text = JSON.stringify(all)
    for (const token of SECRET_TOKENS) expect(text).not.toContain(token)
  })
})

describe('readOverview: recent activity', () => {
  it('in the main fixture: newest first, scoped, pending and user rows as stored', async () => {
    await seedMain()

    const personal = await readOverview('personal', NOW, connection)
    const strawb = await readOverview('strawb', NOW, connection)
    const all = await readOverview('all', NOW, connection)

    expect(personal.recentActivity.map((r) => r.id)).toStrictEqual([
      '5',
      '6',
      '2',
      '3',
      '1',
      '4',
    ])
    expect(strawb.recentActivity.map((r) => r.id)).toStrictEqual(['7', '8'])
    expect(all.recentActivity.map((r) => r.id)).toStrictEqual([
      '5',
      '6',
      '7',
      '8',
      '2',
      '3',
      '1',
      '4',
    ])
    expect(personal.recentActivity[0]).toStrictEqual({
      id: '5',
      date: '2026-10-28',
      description: 'Pending tap',
      amountCents: -3000,
      scope: 'personal',
      accountName: 'Everyday',
      status: 'pending',
      category: null,
      categorySource: 'akahu',
    })
    expect(personal.recentActivity[2]).toMatchObject({
      id: '2',
      category: 'Groceries',
      categorySource: 'user',
    })
    expect(strawb.recentActivity[0]).toMatchObject({
      scope: 'strawb',
      accountName: 'Trading',
    })
  })

  it(`is at most ${RECENT_ACTIVITY_LIMIT} rows, newest first, ties by id descending`, async () => {
    await connection('accounts').insert(
      account({
        id: 1,
        akahu_id: 'acc_a',
        name: 'Everyday',
        balance_cents: 100,
      }),
    )
    await connection('transactions').insert(
      Array.from({ length: 12 }, (_, i) =>
        tx(
          'acc_a',
          i < 4
            ? '2026-10-27T03:00:00.000Z'
            : `2026-10-1${i - 4}T03:00:00.000Z`,
          -(i + 1),
          { id: i + 1 },
        ),
      ),
    )

    const body = await readOverview('all', NOW, connection)

    expect(body.recentActivity.map((r) => r.id)).toStrictEqual([
      '4',
      '3',
      '2',
      '1',
      '12',
      '11',
      '10',
      '9',
      '8',
      '7',
    ])
    expect(body.recentActivity).toHaveLength(RECENT_ACTIVITY_LIMIT)
    expect(Object.keys(body.recentActivity[0]).sort()).toStrictEqual(
      [
        'accountName',
        'amountCents',
        'category',
        'categorySource',
        'date',
        'description',
        'id',
        'scope',
        'status',
      ].sort(),
    )
  })

  it('a missing description is an empty string', async () => {
    await connection('accounts').insert(
      account({ id: 1, akahu_id: 'acc_a', balance_cents: 100 }),
    )
    await connection('transactions').insert(
      tx('acc_a', '2026-10-27T03:00:00.000Z', -1, { description: null }),
    )

    const body = await readOverview('all', NOW, connection)

    expect(body.recentActivity[0].description).toBe('')
  })

  it.each([
    ['no date, in the window query', { date: null }],
    ['no amount, inside the window', { amount_cents: null }],
    [
      'no amount, before the window (activity only)',
      { amount_cents: null, date: '2026-09-01T00:00:00.000Z' },
    ],
    ['a date that is not a date', { date: 'garbage-date-sentinel' }],
  ])('a row with %s is refused', async (_why, fields) => {
    await connection('accounts').insert(
      account({ id: 1, akahu_id: 'acc_a', balance_cents: 100 }),
    )
    await connection('transactions').insert(
      tx('acc_a', '2026-10-27T03:00:00.000Z', -1, fields),
    )

    const err = await errorOf(() => readOverview('all', NOW, connection))

    expect(err).toBeInstanceOf(OverviewDataError)
    expect((err as Error).message).toBe('a transaction is incomplete')
  })

  // The activity list refuses an incomplete row too, but only one among its
  // newest rows. Here newer complete rows push it out of that list, so only
  // the window query can refuse it.
  it.each([
    ['no date', { date: null }],
    [
      'no amount, oldest in the window',
      { amount_cents: null, date: '2026-10-26T12:00:00.000Z' },
    ],
  ])(
    'a row with %s is refused by the window even outside the activity list',
    async (_why, fields) => {
      await connection('accounts').insert(
        account({ id: 1, akahu_id: 'acc_a', balance_cents: 100 }),
      )
      await connection('transactions').insert([
        tx('acc_a', '2026-10-27T03:00:00.000Z', -1, fields),
        ...Array.from({ length: RECENT_ACTIVITY_LIMIT }, () =>
          tx('acc_a', '2026-10-27T03:00:00.000Z', -1),
        ),
      ])

      const err = await errorOf(() => readOverview('all', NOW, connection))

      expect(err).toBeInstanceOf(OverviewDataError)
      expect((err as Error).message).toBe('a transaction is incomplete')
    },
  )

  it('an incomplete row on an account that is not stored is ignored', async () => {
    await connection('accounts').insert(
      account({ id: 1, akahu_id: 'acc_a', balance_cents: 100 }),
    )
    await connection('transactions').insert(tx('acc_nobody', null, null))

    await expect(readOverview('all', NOW, connection)).resolves.toBeDefined()
  })
})

describe('readOverview: pending spend', () => {
  it('a pending row with a category counts toward its budget', async () => {
    await seedMain()
    await connection('transactions').insert(
      tx(AKAHU.everyday, '2026-10-27T22:00:00.000Z', -500, {
        status: 'pending',
        category: 'Groceries',
        category_source: 'user',
      }),
    )

    const { safeToSpend: result } = await readOverview(
      'personal',
      NOW,
      connection,
    )

    expect(result.budgets[0]).toMatchObject({
      id: '1',
      spentCents: 10000,
      remainingCents: 10000,
    })
  })
})

describe('readOverview: dataAsOf', () => {
  const run = (
    id: number,
    started: string,
    finished: string | null,
    outcome: string,
  ) => ({
    id,
    started_at: started,
    finished_at: finished,
    outcome,
    error_message: outcome === 'failed' ? 'invented failure' : null,
  })

  it('is null with no successful sync', async () => {
    await connection('sync_runs').insert(
      run(1, '2026-10-27T01:00:00.000Z', '2026-10-27T01:01:00.000Z', 'failed'),
    )

    expect((await readOverview('all', NOW, connection)).dataAsOf).toBeNull()
  })

  it('is the finish time of the success that started last, in ISO form', async () => {
    await connection('sync_runs').insert([
      run(1, '2026-10-27T01:00:00.000Z', '2026-10-27T01:01:00.000Z', 'success'),
      run(2, '2026-10-27T03:00:00.000Z', '2026-10-27T03:02:00.000Z', 'success'),
      run(3, '2026-10-27T05:00:00.000Z', '2026-10-27T05:01:00.000Z', 'failed'),
      // Sorts after every ISO time as text, but is not in toISOString form.
      run(4, 'not-a-timestamp', '2026-10-27T09:00:00.000Z', 'success'),
      // julianday() reads this one as later than every row above, so only
      // the toISOString-form filter keeps it out; run 4 alone would pass
      // without that filter, because julianday() of junk is NULL and ranks
      // last.
      run(5, '2026-10-27 09:00:00', '2026-10-27T09:30:00.000Z', 'success'),
    ])

    expect((await readOverview('all', NOW, connection)).dataAsOf).toBe(
      '2026-10-27T03:02:00.000Z',
    )
  })
})

describe('readOverview writes nothing', () => {
  it('every table is the same, row for row, after reading every scope', async () => {
    await seedMain()
    await connection('alert_dismissals').insert({
      alert_id: 'bill_overdue:1:2026-10-14',
      dismissed_at: STAMP,
    })
    const before = await snapshotTables()

    for (const scope of ['all', 'personal', 'strawb'] as const) {
      await readOverview(scope, NOW, connection)
    }

    expect(await snapshotTables()).toStrictEqual(before)
    expect(Object.keys(before)).toContain('alert_dismissals')
  })
})

import type { Express } from 'express'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import connection from '../../db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import type {
  DismissAlertResponse,
  OverviewResponse,
} from '../../../shared/contracts.ts'

// /api/v1/overview (prd-02, issue #44): the Overview screen's read and its
// alert dismissal, over HTTP against the real app and a fresh in-memory
// database. The clock is fixed at 23:30 UTC on Tuesday 27 October 2026,
// which is 12:30 NZDT on Wednesday the 28th: with payday on Tuesdays (the
// default) the last payday is 10-27, the next is 11-03, 6 days away. Every
// value below is invented.

let app: Express
let served: LoopbackApi | undefined
let api: LoopbackApi['api']

const NOW_ISO = '2026-10-27T23:30:00.000Z'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_ISO)
  app = await freshApp()
  served = await serveOnLoopback(app)
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(closeDb)

const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

// The fixture is a copy of the one in server/db/__tests__/overview.test.ts
// (copy 4 of the account/transaction builders; the others are there, in
// server/db/__tests__/synced.test.ts and in
// server/routes/__tests__/accounts.test.ts).
function account(fields: Row): Row {
  return {
    source: 'akahu',
    name: 'Invented account',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

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

function setting(id: string, key: string, value: string | null): Row {
  return { id, user_id: 1, key, value, updated_at: STAMP }
}

async function insertUser() {
  await connection('users').insert({
    id: 1,
    email: 'invented@example.invalid',
    password: 'x',
  })
}

function bill(
  id: number,
  scope: string,
  name: string,
  repeat: string,
  amount: number,
  first: string,
): Row {
  return {
    id,
    scope,
    name,
    repeat,
    amount_cents: amount,
    first_due_date: first,
    created_at: STAMP,
    updated_at: STAMP,
  }
}

// Account numbers, Akahu ids and connection names: never in a payload.
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
    tx('acc_nobody', '2026-10-27T10:00:00.000Z', -5000, {
      id: 9,
      category: 'Groceries',
      description: 'Orphan row',
    }),
    tx(AKAHU.trading, '2026-10-27T11:00:00.000Z', -4000, {
      id: 10,
      category: 'Software',
      source: 'xero',
      description: 'Xero spend',
    }),
  ])
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

const dismissals = () => connection('alert_dismissals').select()

const getOverview = (scope: string) =>
  api.get(`/api/v1/overview?scope=${scope}`)
const dismiss = (id: string) =>
  api.post(`/api/v1/overview/alerts/${encodeURIComponent(id)}/dismiss`)

const sortedKeys = (o: object) => Object.keys(o).sort()

const TOP_KEYS = [
  'safeToSpend',
  'accounts',
  'alerts',
  'recentActivity',
  'dataAsOf',
]
const SAFE_TO_SPEND_KEYS = [
  'scope',
  'today',
  'lastPayday',
  'nextPayday',
  'liquidCents',
  'unpaidBillsCents',
  'remainingBudgetCents',
  'strawbTaxOwedCents',
  'strawbTaxPotCents',
  'strawbBillsBufferCents',
  'strawbTaxHoldCents',
  'personalTaxOwedCents',
  'personalTaxPotCents',
  'personalTaxHoldCents',
  'taxHoldCents',
  'cardDebtCents',
  'safeCents',
  'shortByCents',
  'daysToPayday',
  'perDayCents',
  'budgets',
]
const BUDGET_LINE_KEYS = [
  'id',
  'scope',
  'category',
  'limitCents',
  'spentCents',
  'remainingCents',
  'overCents',
]
const ACCOUNT_KEYS = ['id', 'name', 'scope', 'role', 'balanceCents']
const ALERT_KEYS = ['id', 'kind', 'scope', 'subject', 'amountCents', 'dueDate']
const ACTIVITY_KEYS = [
  'id',
  'date',
  'description',
  'amountCents',
  'scope',
  'accountName',
  'status',
  'category',
  'categorySource',
]

describe('D1: the response is the contract', () => {
  it.each(['all', 'personal', 'strawb'])(
    'scope=%s: every key set is pinned',
    async (scope) => {
      await seedMain()

      const res = await getOverview(scope)

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      const body: OverviewResponse = res.body
      expect(sortedKeys(body)).toStrictEqual([...TOP_KEYS].sort())
      expect(sortedKeys(body.safeToSpend)).toStrictEqual(
        [...SAFE_TO_SPEND_KEYS].sort(),
      )
      expect(body.safeToSpend.budgets.length).toBeGreaterThan(0)
      for (const line of body.safeToSpend.budgets) {
        expect(sortedKeys(line)).toStrictEqual([...BUDGET_LINE_KEYS].sort())
      }
      expect(body.accounts.length).toBeGreaterThan(0)
      for (const card of body.accounts)
        expect(sortedKeys(card)).toStrictEqual([...ACCOUNT_KEYS].sort())
      expect(body.alerts.length).toBeGreaterThan(0)
      for (const alert of body.alerts)
        expect(sortedKeys(alert)).toStrictEqual([...ALERT_KEYS].sort())
      expect(body.recentActivity.length).toBeGreaterThan(0)
      for (const row of body.recentActivity) {
        expect(sortedKeys(row)).toStrictEqual([...ACTIVITY_KEYS].sort())
      }
      expect(body.dataAsOf).toBeNull()
    },
  )
})

describe('D2: safe-to-spend, by hand', () => {
  it.each([
    ['personal', 28500, 4750],
    ['strawb', 380500, 63416],
    ['all', 409000, 68166],
  ])(
    'scope=%s: safeCents %i, perDayCents %i',
    async (scope, safeCents, perDayCents) => {
      await seedMain()

      const body: OverviewResponse = (await getOverview(scope)).body

      expect(body.safeToSpend.safeCents).toBe(safeCents)
      expect(body.safeToSpend.perDayCents).toBe(perDayCents)
      expect(body.safeToSpend).toMatchObject({
        scope,
        today: '2026-10-28',
        lastPayday: '2026-10-27',
        nextPayday: '2026-11-03',
        daysToPayday: 6,
        shortByCents: 0,
      })
    },
  )

  it('personal: every ledger figure and budget line', async () => {
    await seedMain()

    const body: OverviewResponse = (await getOverview('personal')).body

    expect(body.safeToSpend).toMatchObject({
      liquidCents: 250000,
      // #151: Flat rent 10-14 and 10-21 (overdue) and 10-28 all count,
      // 60000, plus Internet 09-30 and 10-31, 16000. Not the paid 10-07.
      unpaidBillsCents: 76000,
      remainingBudgetCents: 10500,
      personalTaxOwedCents: 120000,
      personalTaxPotCents: 30000,
      personalTaxHoldCents: 90000,
      strawbTaxOwedCents: 0,
      strawbTaxHoldCents: 0,
      taxHoldCents: 90000,
      cardDebtCents: 45000,
    })
    const ids = body.alerts.map((a) => a.id)
    expect(ids).toContain('bill_overdue:1:2026-10-14')
    expect(ids).toContain('bill_overdue:1:2026-10-21')
    expect(body.safeToSpend.budgets).toStrictEqual([
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
    ])
  })

  it('strawb and all: the tax and bills figures', async () => {
    await seedMain()

    const strawb: OverviewResponse = (await getOverview('strawb')).body
    const all: OverviewResponse = (await getOverview('all')).body

    expect(strawb.safeToSpend).toMatchObject({
      liquidCents: 600000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 7500,
      strawbTaxOwedCents: 250000,
      strawbTaxPotCents: 50000,
      strawbBillsBufferCents: 12000,
      strawbTaxHoldCents: 212000,
      personalTaxHoldCents: 0,
      taxHoldCents: 212000,
      cardDebtCents: 0,
    })
    expect(strawb.safeToSpend.budgets).toStrictEqual([
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
    expect(all.safeToSpend).toMatchObject({
      liquidCents: 850000,
      unpaidBillsCents: 76000,
      remainingBudgetCents: 18000,
      taxHoldCents: 302000,
      cardDebtCents: 45000,
    })
    expect(all.safeToSpend.budgets.map((b) => b.id)).toStrictEqual([
      '1',
      '2',
      '3',
    ])
  })
})

describe('#151', () => {
  it('#151: a weekly bill two cycles overdue holds back every unpaid occurrence, not just the latest, and not the paid one', async () => {
    await connection('accounts').insert(
      account({
        id: 1,
        akahu_id: 'acc_rent',
        name: 'Everyday',
        scope: 'personal',
        balance_cents: 100000,
      }),
    )
    await connection('account_settings').insert({
      account_id: 1,
      role: 'current',
      updated_at: STAMP,
    })
    await connection('bills').insert(
      bill(1, 'personal', 'Flat rent', 'weekly', 20000, '2026-10-07'),
    )
    await connection('bill_payments').insert({
      bill_id: 1,
      due_date: '2026-10-07',
      amount_cents: 20000,
      paid_at: STAMP,
    })

    const personal: OverviewResponse = (await getOverview('personal')).body
    const all: OverviewResponse = (await getOverview('all')).body
    const strawb: OverviewResponse = (await getOverview('strawb')).body

    // 10-14, 10-21 and 10-28; counting only the latest would give 20000,
    // ignoring the payment 80000, stopping at today 40000.
    expect(personal.safeToSpend.unpaidBillsCents).toBe(60000)
    expect(personal.safeToSpend.safeCents).toBe(40000)
    expect(personal.safeToSpend.perDayCents).toBe(6666)
    expect(personal.alerts).toStrictEqual([
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
    ])
    expect(personal.alerts.some((a) => a.dueDate === '2026-10-07')).toBe(false)
    expect(all.safeToSpend.unpaidBillsCents).toBe(60000)
    expect(all.safeToSpend.safeCents).toBe(40000)
    expect(all.alerts).toStrictEqual(personal.alerts)
    expect(strawb.safeToSpend.unpaidBillsCents).toBe(0)
    expect(strawb.alerts).toStrictEqual([])
  })
})

describe('D3: one scope never shows the other', () => {
  const PERSONAL_TOKENS = [
    'Everyday',
    'Savings',
    'Visa',
    'Spare',
    'Personal tax pot',
    'Flat rent',
    'Internet',
    'Eating out',
    'Dentist',
    'Rego',
  ]
  const STRAWB_TOKENS = [
    'Trading',
    'Strawb tax pot',
    'Hosting',
    'Software',
    'Studio snacks',
    'Licence',
  ]
  const DISTRACTOR_TOKENS = ['Orphan row', 'Xero spend', 'Xero ledger']

  it('strawb has no personal account, bill, budget or activity', async () => {
    await seedMain()

    const res = await getOverview('strawb')
    const body: OverviewResponse = res.body

    expect(body.accounts.map((a) => a.id)).toStrictEqual(['6', '7'])
    for (const card of body.accounts) expect(card.scope).toBe('strawb')
    for (const alert of body.alerts) expect(alert.scope).toBe('strawb')
    for (const line of body.safeToSpend.budgets)
      expect(line.scope).toBe('strawb')
    // A Strawb row may carry the category name "Groceries"; the personal
    // Groceries budget is what must not appear.
    expect(body.safeToSpend.budgets.map((b) => b.category)).toStrictEqual([
      'Software',
    ])
    expect(
      body.recentActivity.map((r) => [r.id, r.scope, r.accountName]),
    ).toStrictEqual([
      ['7', 'strawb', 'Trading'],
      ['8', 'strawb', 'Trading'],
    ])
    for (const token of [...PERSONAL_TOKENS, ...DISTRACTOR_TOKENS])
      expect(res.text).not.toContain(token)
  })

  it('personal has no strawb account, bill, budget or activity', async () => {
    await seedMain()

    const res = await getOverview('personal')
    const body: OverviewResponse = res.body

    expect(body.accounts.map((a) => a.id)).toStrictEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    for (const card of body.accounts) expect(card.scope).toBe('personal')
    for (const alert of body.alerts) expect(alert.scope).toBe('personal')
    for (const line of body.safeToSpend.budgets)
      expect(line.scope).toBe('personal')
    for (const row of body.recentActivity) expect(row.scope).toBe('personal')
    for (const token of [...STRAWB_TOKENS, ...DISTRACTOR_TOKENS])
      expect(res.text).not.toContain(token)
  })
})

// Every key anywhere in the payload, at any depth.
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, into)
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k)
      allKeys(v, into)
    }
  }
  return into
}

describe('D4: nothing from Xero, nothing secret', () => {
  const ALLOWED_KEYS = new Set([
    ...TOP_KEYS,
    ...SAFE_TO_SPEND_KEYS,
    ...BUDGET_LINE_KEYS,
    ...ACCOUNT_KEYS,
    ...ALERT_KEYS,
    ...ACTIVITY_KEYS,
  ])

  it.each(['all', 'strawb', 'personal'])('scope=%s', async (scope) => {
    await seedMain()

    const res = await getOverview(scope)
    const body: OverviewResponse = res.body

    expect(body.accounts.some((a) => a.id === '8')).toBe(false)
    expect(res.text).not.toContain('Xero')
    expect(res.text).not.toContain('777700')
    expect(res.text).not.toContain('-4000')
    for (const key of allKeys(body))
      expect(ALLOWED_KEYS.has(key), key).toBe(true)
    for (const token of SECRET_TOKENS) expect(res.text).not.toContain(token)
  })
})

// `over_budget:1000…0:2026-10-27`, padded with zeros in the row id to
// `length` characters: it matches the alert id's shape at any length.
function idOfLength(length: number): string {
  const fixed = 'over_budget:1:2026-10-27'.length
  return `over_budget:1${'0'.repeat(length - fixed)}:2026-10-27`
}

describe('D5: alerts and dismissal', () => {
  const PERSONAL_IDS = [
    'over_budget:2:2026-10-27',
    'bill_overdue:2:2026-09-30',
    'bill_overdue:1:2026-10-14',
    'bill_overdue:1:2026-10-21',
    'bill_due_soon:1:2026-10-28',
    'bill_due_soon:2:2026-10-31',
  ]
  const HOSTING = 'bill_due_soon:5:2026-10-30'
  const alertIds = async (scope: string) =>
    ((await getOverview(scope)).body as OverviewResponse).alerts.map(
      (a) => a.id,
    )

  it('lists six personal, one strawb and seven in all', async () => {
    await seedMain()

    expect(await alertIds('personal')).toStrictEqual(PERSONAL_IDS)
    expect(await alertIds('strawb')).toStrictEqual([HOSTING])
    expect(await alertIds('all')).toStrictEqual([
      ...PERSONAL_IDS.slice(0, 5),
      HOSTING,
      PERSONAL_IDS[5],
    ])
  })

  it('dismissing stores it, answers its id and time, and GET stops listing it', async () => {
    await seedMain()

    const res = await dismiss('bill_overdue:1:2026-10-14')

    expect(res.status).toBe(200)
    expect(sortedKeys(res.body)).toStrictEqual(['dismissedAt', 'id'])
    const body: DismissAlertResponse = res.body
    expect(body).toStrictEqual({
      id: 'bill_overdue:1:2026-10-14',
      dismissedAt: NOW_ISO,
    })
    expect(await dismissals()).toStrictEqual([
      { alert_id: 'bill_overdue:1:2026-10-14', dismissed_at: NOW_ISO },
    ])
    expect(await alertIds('personal')).toStrictEqual(
      PERSONAL_IDS.filter((id) => id !== 'bill_overdue:1:2026-10-14'),
    )
  })

  it('dismissing the strawb alert leaves every personal one, and all loses exactly it', async () => {
    await seedMain()

    expect((await dismiss(HOSTING)).status).toBe(200)

    expect(await alertIds('strawb')).toStrictEqual([])
    expect(await alertIds('personal')).toStrictEqual(PERSONAL_IDS)
    expect(await alertIds('all')).toStrictEqual(PERSONAL_IDS)
  })

  it('dismissing a personal alert leaves strawb’s, and all loses exactly it', async () => {
    await seedMain()

    expect((await dismiss('bill_due_soon:2:2026-10-31')).status).toBe(200)

    expect(await alertIds('strawb')).toStrictEqual([HOSTING])
    expect(await alertIds('all')).toStrictEqual([
      ...PERSONAL_IDS.slice(0, 5),
      HOSTING,
    ])
  })

  it('a budget and a bill with the same row id never collide', async () => {
    await seedMain()
    // Budget 1 (Groceries) over by 500; bill 1 is Flat rent.
    await connection('budgets').where({ id: 1 }).update({ limit_cents: 9000 })

    expect((await dismiss('over_budget:1:2026-10-27')).status).toBe(200)

    const ids = await alertIds('personal')
    expect(ids).not.toContain('over_budget:1:2026-10-27')
    expect(ids).toContain('bill_overdue:1:2026-10-14')
    expect(ids).toContain('bill_overdue:1:2026-10-21')
    expect(ids).toContain('bill_due_soon:1:2026-10-28')
  })

  it('a dismissal outlives the server: it is in the database, not in memory', async () => {
    await seedMain()
    expect((await dismiss('bill_overdue:2:2026-09-30')).status).toBe(200)

    // A new server on the same app and database, without re-migrating. A
    // real process restart cannot be tested on :memory:; this proves the
    // dismissal is read back from the table with no module cache in between.
    await served?.close()
    served = await serveOnLoopback(app)
    api = served.api

    expect(await alertIds('personal')).not.toContain(
      'bill_overdue:2:2026-09-30',
    )
    expect(await dismissals()).toHaveLength(1)
  })

  it('dismissing again keeps the first time, after the clock moves', async () => {
    await seedMain()
    await dismiss(HOSTING)
    vi.setSystemTime('2026-10-28T02:00:00.000Z')

    const res = await dismiss(HOSTING)

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ id: HOSTING, dismissedAt: NOW_ISO })
    expect(await dismissals()).toHaveLength(1)
  })

  it.each([
    ['a paid occurrence', 'bill_overdue:1:2026-10-07'],
    ['an occurrence beyond the next payday', 'bill_due_soon:4:2026-11-10'],
    ['a bill that does not exist', 'bill_due_soon:99:2026-10-30'],
    ['a budget that is not over', 'over_budget:1:2026-10-27'],
  ])(
    'an alert that is not derived (%s) is a 404, and nothing is stored',
    async (_why, id) => {
      await seedMain()

      const res = await dismiss(id)

      expect(res.status).toBe(404)
      expect(res.body).toStrictEqual({ error: 'Alert not found' })
      expect(await dismissals()).toStrictEqual([])
    },
  )

  it.each([
    ['a bare word', 'x'],
    ['a kind and id with no date', 'over_budget:1'],
    ['a non-numeric id', 'bill_due_soon:abc:2026-10-30'],
    ['a zero id', 'bill_due_soon:0:2026-10-30'],
    ['SQL', "x' OR 1=1 --"],
    // The right shape, 256 characters long: only the length cap refuses it.
    ['the right shape but 256 characters', idOfLength(256)],
    ['an unknown kind', 'goal_met:1:2026-10-27'],
  ])(
    'a malformed id (%s) is a 400 that does not echo it, and nothing is stored',
    async (_why, id) => {
      await seedMain()

      const res = await dismiss(id)

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'Invalid alert id' })
      expect(res.text).not.toContain(id)
      expect(await dismissals()).toStrictEqual([])
    },
  )

  it('a malformed id is refused before anything is read', async () => {
    await seedMain()
    // With settings unreadable, any read would be a 500.
    await connection.schema.renameTable('settings', 'settings_away')
    try {
      const res = await dismiss('bill_due_soon:abc:2026-10-30')

      expect(res.status).toBe(400)
    } finally {
      await connection.schema.renameTable('settings_away', 'settings')
    }
  })

  it('the right shape at exactly 255 characters passes the length cap (and is not derived)', async () => {
    await seedMain()

    const res = await dismiss(idOfLength(255))

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Alert not found' })
  })

  it('a %3A-encoded id is the same id', async () => {
    await seedMain()

    const res = await api.post(
      '/api/v1/overview/alerts/bill_due_soon%3A5%3A2026-10-30/dismiss',
    )

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(HOSTING)
  })

  it('?scope on the POST is ignored: an alert of either scope can be dismissed', async () => {
    await seedMain()

    const res = await api.post(
      `/api/v1/overview/alerts/${encodeURIComponent(HOSTING)}/dismiss?scope=personal`,
    )

    expect(res.status).toBe(200)
    expect(await dismissals()).toHaveLength(1)
  })

  describe('only this site may dismiss (as POST /api/v1/sync/run)', () => {
    const url = `/api/v1/overview/alerts/${encodeURIComponent(HOSTING)}/dismiss`
    const ownOrigin = () => `http://127.0.0.1:${served?.address.port}`

    it.each(['cross-site', 'same-site'])(
      'Sec-Fetch-Site %s is refused even with this host’s own Origin',
      async (site) => {
        await seedMain()

        const res = await api
          .post(url)
          .set('Sec-Fetch-Site', site)
          .set('Origin', ownOrigin())

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await dismissals()).toStrictEqual([])
      },
    )

    it.each(['http://evil.example', 'null', 'not a url'])(
      'without Sec-Fetch-Site, Origin %s is refused',
      async (origin) => {
        await seedMain()

        const res = await api.post(url).set('Origin', origin)

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await dismissals()).toStrictEqual([])
      },
    )

    it.each([
      [
        'Sec-Fetch-Site same-origin, behind the dev proxy',
        { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' },
      ],
      ['Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
      ['this host’s own Origin', 'own'],
      ['no headers (curl)', {}],
    ] as const)('%s passes', async (_why, headers) => {
      await seedMain()

      const res = await api
        .post(url)
        .set(headers === 'own' ? { Origin: ownOrigin() } : headers)

      expect(res.status).toBe(200)
      expect(await dismissals()).toHaveLength(1)
    })
  })

  it.each([
    [
      'DELETE',
      () =>
        api.delete(
          `/api/v1/overview/alerts/${encodeURIComponent(HOSTING)}/dismiss`,
        ),
    ],
    [
      'PUT',
      () =>
        api.put(
          `/api/v1/overview/alerts/${encodeURIComponent(HOSTING)}/dismiss`,
        ),
    ],
    ['POST /api/v1/overview', () => api.post('/api/v1/overview')],
    ['GET a sub-path', () => api.get('/api/v1/overview/alerts')],
  ])('%s is the app’s JSON 404', async (_why, send) => {
    await seedMain()

    const res = await send()

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
    expect(await dismissals()).toStrictEqual([])
  })
})

describe('D6: recent activity', () => {
  it('personal: newest first, pending and recategorised rows as stored', async () => {
    await seedMain()

    const body: OverviewResponse = (await getOverview('personal')).body

    expect(body.recentActivity.map((r) => r.description)).toStrictEqual([
      'Pending tap',
      'Dinner',
      'Recategorised',
      'Refund',
      'Groceries run',
      'Old groceries',
    ])
    const [pending, dinner, recategorised] = body.recentActivity
    expect(pending).toStrictEqual({
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
    expect(pending.id).toMatch(/^\d+$/)
    expect(dinner).toMatchObject({
      accountName: 'Visa',
      scope: 'personal',
      status: 'settled',
    })
    expect(recategorised).toMatchObject({
      category: 'Groceries',
      categorySource: 'user',
      accountName: 'Everyday',
    })
  })

  it('all: both scopes, newest first, no distractor', async () => {
    await seedMain()

    const body: OverviewResponse = (await getOverview('all')).body

    expect(
      body.recentActivity.map((r) => [r.id, r.scope, r.accountName]),
    ).toStrictEqual([
      ['5', 'personal', 'Everyday'],
      ['6', 'personal', 'Visa'],
      ['7', 'strawb', 'Trading'],
      ['8', 'strawb', 'Trading'],
      ['2', 'personal', 'Everyday'],
      ['3', 'personal', 'Everyday'],
      ['1', 'personal', 'Everyday'],
      ['4', 'personal', 'Everyday'],
    ])
  })
})

describe('D7: GET reads, POST writes only a dismissal', () => {
  it('GET in every scope leaves every table as it was', async () => {
    await seedMain()
    const before = await snapshotTables()

    for (const scope of ['all', 'personal', 'strawb']) {
      expect((await getOverview(scope)).status).toBe(200)
    }

    expect(await snapshotTables()).toStrictEqual(before)
  })

  it('POST adds one alert_dismissals row and changes nothing else', async () => {
    await seedMain()
    const before = await snapshotTables()

    expect((await dismiss('bill_due_soon:5:2026-10-30')).status).toBe(200)

    const after = await snapshotTables()
    expect(after.alert_dismissals).toHaveLength(
      before.alert_dismissals.length + 1,
    )
    expect({ ...after, alert_dismissals: [] }).toStrictEqual({
      ...before,
      alert_dismissals: [],
    })
  })
})

describe('D8: errors are fixed text', () => {
  it.each([
    ['missing', ''],
    ['empty', '?scope='],
    ['upper case', '?scope=ALL'],
    ['unknown', '?scope=business'],
    ['a sentinel', '?scope=sentinel-scope-4411'],
    ['repeated', '?scope=all&scope=all'],
    ['an object', '?scope[x]=y'],
  ])('a scope that is %s is a 400', async (_why, query) => {
    const res = await api.get(`/api/v1/overview${query}`)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
    expect(res.text).not.toContain('sentinel')
    expect(res.text).not.toContain('business')
  })

  it.each([
    ['profit_cents', 'sentinel-bad-1234', 'a stored setting is not valid'],
    ['tax_rate_bp', '20000', 'safe-to-spend input invalid'],
    ['payday_weekday', '9', 'safe-to-spend input invalid'],
  ])(
    'a stored %s of %s is a 500 naming the problem, never the value',
    async (key, value, message) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await seedMain()
      await connection('settings').where({ key }).del()
      await connection('settings').insert(setting('bad', key, value))

      const res = await getOverview('all')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: message })
      expect(res.text).not.toContain(value)
      expect(error.mock.calls).toStrictEqual([
        ['overview: could not read overview', 'OverviewDataError'],
      ])
      expect(JSON.stringify(error.mock.calls)).not.toContain(value)
    },
  )

  it('a stored setting that is bad also stops a dismissal, with the same text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedMain()
    await connection('settings').where({ key: 'profit_cents' }).del()
    await connection('settings').insert(
      setting('bad', 'profit_cents', 'sentinel-bad-1234'),
    )

    const res = await dismiss('bill_due_soon:5:2026-10-30')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a stored setting is not valid' })
    expect(error.mock.calls).toStrictEqual([
      ['overview: could not dismiss alert', 'OverviewDataError'],
    ])
    expect(await dismissals()).toStrictEqual([])
  })

  it('an Akahu account with no balance is a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedMain()
    await connection('accounts')
      .where({ id: 2 })
      .update({ balance_cents: null })

    const res = await getOverview('personal')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'an account has no balance' })
  })

  it('a transaction with a garbage date is a 500 that does not echo it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedMain()
    await connection('transactions').insert(
      tx(AKAHU.everyday, 'garbage-date-sentinel', -100),
    )

    const res = await getOverview('personal')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
    expect(res.text).not.toContain('garbage')
  })

  it('an unreadable table is a 500 with a generic text, no SQL, table name or stack', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedMain()
    // Renamed and restored, never dropped.
    await connection.schema.renameTable(
      'alert_dismissals',
      'alert_dismissals_away',
    )
    try {
      const res = await getOverview('all')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not read overview' })
      for (const leak of ['SQLITE', 'alert_dismissals', 'select', ' at ']) {
        expect(res.text).not.toContain(leak)
      }
      expect(error.mock.calls).toStrictEqual([
        ['overview: could not read overview', 'Error'],
      ])
    } finally {
      await connection.schema.renameTable(
        'alert_dismissals_away',
        'alert_dismissals',
      )
    }
  })
})

describe('dataAsOf', () => {
  it('is null before any successful sync, then the newest success’s finish time', async () => {
    await seedMain()

    expect((await getOverview('all')).body.dataAsOf).toBeNull()

    await connection('sync_runs').insert([
      {
        started_at: '2026-10-27T01:00:00.000Z',
        finished_at: '2026-10-27T01:01:00.000Z',
        outcome: 'success',
      },
      {
        started_at: '2026-10-27T03:00:00.000Z',
        finished_at: '2026-10-27T03:02:00.000Z',
        outcome: 'success',
      },
      {
        started_at: '2026-10-27T05:00:00.000Z',
        finished_at: '2026-10-27T05:01:00.000Z',
        outcome: 'failed',
        error_message: 'invented failure',
      },
    ])

    expect((await getOverview('personal')).body.dataAsOf).toBe(
      '2026-10-27T03:02:00.000Z',
    )
  })
})

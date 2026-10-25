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
import { loadDrawingIds } from '../../db/drawings.ts'
import { TRANSACTION_COLUMNS } from '../../db/__tests__/transactionColumns.ts'
import { replacePending, upsertSettled } from '../../sync/upsert.ts'
import type {
  PendingTransaction,
  SettledTransaction,
} from '../../sync/types.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import type {
  ActivityRow,
  OverviewResponse,
  Scope,
  SubscriptionsResponse,
} from '../../../shared/contracts.ts'

// Drawings end to end (prd-02 Ruling 15, issue #264): over HTTP against the
// real app and a fresh in-memory database. The clock is fixed at 23:30 UTC
// on Tuesday 27 October 2026, 12:30 NZDT on Wednesday the 28th; payday is
// Tuesday (the default), so the safe-to-spend window is NZ 27th to 28th.
// Every account, amount and description below is invented.
//
// Each describe names the issue's Done-when bullet it proves (DW1 to DW6;
// DW7 is the shared tests plus this file, DW8 is the PRD text).

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

const NOW_ISO = '2026-10-27T23:30:00.000Z'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_ISO)
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.useRealTimers()
})

afterAll(closeDb)

const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

const EVERYDAY = 'acc_fixture_everyday'
const TRADING = 'acc_fixture_trading'

// Budgeted categories, all from data/cats.js.
const GROCER = 'Supermarkets and grocery stores'
const FX = 'Foreign exchange and money transfer services'
const PRO = 'Professional services (not elsewhere classified)'

async function insertAll(table: string, rows: Row[]) {
  // One insert per row: a multi-row insert binds NULL for a key a row
  // leaves out, which would skip the column defaults.
  for (const row of rows) await connection(table).insert(row)
}

function tx(
  id: number,
  accountId: string,
  date: string,
  amountCents: number,
  fields: Row = {},
): Row {
  return {
    id,
    akahu_id: `trans_fixture_${id}`,
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: `EXAMPLE ROW ${id}`,
    type: 'TRANSFER',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

/**
 * Two current accounts, four budgets and one ordinary spend on each side.
 * In the window: Groceries 5000 of 20000, FX 0 of 50000, Professional 2000
 * of 40000, Drawings 0 of 10000.
 */
async function seedBase() {
  await insertAll('accounts', [
    {
      id: 1,
      akahu_id: EVERYDAY,
      source: 'akahu',
      scope: 'personal',
      name: 'Invented Everyday',
      balance_cents: 250000,
      created_at: STAMP,
      updated_at: STAMP,
    },
    {
      id: 2,
      akahu_id: TRADING,
      source: 'akahu',
      scope: 'strawb',
      name: 'Invented Trading',
      balance_cents: 600000,
      created_at: STAMP,
      updated_at: STAMP,
    },
  ])
  await insertAll('account_settings', [
    { account_id: 1, role: 'current', updated_at: STAMP },
    { account_id: 2, role: 'current', updated_at: STAMP },
  ])
  const budget = (
    id: number,
    scope: string,
    category: string,
    limit: number,
  ) => ({
    id,
    scope,
    category,
    limit_cents: limit,
    created_at: STAMP,
    updated_at: STAMP,
  })
  await insertAll('budgets', [
    budget(1, 'personal', GROCER, 20000),
    budget(2, 'strawb', FX, 50000),
    budget(3, 'strawb', PRO, 40000),
    budget(4, 'strawb', 'Drawings', 10000),
  ])
  await insertAll('transactions', [
    tx(10, EVERYDAY, '2026-10-27T20:00:00.000Z', -5000, { category: GROCER }),
    tx(11, TRADING, '2026-10-27T20:00:00.000Z', -2000, { category: PRO }),
  ])
}

// Hannah's monthly drawing: 30000 out of Trading (Akahu calls it FX), and
// 30000 into Everyday the next NZ day, uncategorised. 01:00 UTC is 13:00 or
// 14:00 in NZ; 22:00 UTC is 10:00 or 11:00 the next NZ day.
const OUT_DATES = [
  '2026-08-27T01:00:00.000Z',
  '2026-09-27T01:00:00.000Z',
  '2026-10-27T01:00:00.000Z',
]
const IN_DATES = [
  '2026-08-27T22:00:00.000Z',
  '2026-09-27T22:00:00.000Z',
  '2026-10-27T22:00:00.000Z',
]
const OUT_IDS = [20, 22, 24]
const IN_IDS = [21, 23, 25]
// The October pair, inside the safe-to-spend window.
const OCT_OUT = 24
const OCT_IN = 25

const outHalves = (cents = 30000): Row[] =>
  OUT_DATES.map((date, i) =>
    tx(OUT_IDS[i], TRADING, date, -cents, {
      category: FX,
      description: 'EXAMPLE OWN TRANSFER OUT',
    }),
  )
const inHalves = (cents = 30000): Row[] =>
  IN_DATES.map((date, i) =>
    tx(IN_IDS[i], EVERYDAY, date, cents, {
      description: 'EXAMPLE OWN TRANSFER IN',
    }),
  )

async function overview(scope: Scope): Promise<OverviewResponse> {
  const res = await api.get('/api/v1/overview').query({ scope })
  expect(res.status).toBe(200)
  return res.body
}

async function subscriptions(scope: Scope): Promise<SubscriptionsResponse> {
  const res = await api.get('/api/v1/subscriptions').query({ scope })
  expect(res.status).toBe(200)
  return res.body
}

function activity(body: OverviewResponse, id: number): ActivityRow | undefined {
  return body.recentActivity.find((r) => r.id === String(id))
}

function spentOf(body: OverviewResponse, budgetId: number): number | undefined {
  return body.safeToSpend.budgets.find((b) => b.id === String(budgetId))
    ?.spentCents
}

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

describe('a strawb outflow and an equal personal inflow a day later are both Drawings (DW1)', () => {
  beforeEach(async () => {
    await seedBase()
    await insertAll('transactions', [...outHalves(), ...inHalves()])
  })

  it('shows both halves as Drawings, set by rule, in the overview activity for every scope', async () => {
    const all = await overview('all')
    for (const id of [OCT_OUT, OCT_IN]) {
      const row = activity(all, id)
      expect(Object.keys(row ?? {}).sort()).toStrictEqual(
        [...ACTIVITY_KEYS].sort(),
      )
      expect(row).toMatchObject({
        category: 'Drawings',
        categorySource: 'rule',
      })
    }
    const strawb = await overview('strawb')
    expect(activity(strawb, OCT_OUT)).toMatchObject({
      scope: 'strawb',
      amountCents: -30000,
      category: 'Drawings',
      categorySource: 'rule',
    })
    expect(activity(strawb, OCT_IN)).toBeUndefined()
    const personal = await overview('personal')
    expect(activity(personal, OCT_IN)).toMatchObject({
      scope: 'personal',
      amountCents: 30000,
      category: 'Drawings',
      categorySource: 'rule',
    })
    expect(activity(personal, OCT_OUT)).toBeUndefined()
    // An ordinary row beside them keeps its own category.
    expect(activity(all, 11)).toMatchObject({
      category: PRO,
      categorySource: 'akahu',
    })
  })

  it('shows every half as Drawings in GET /api/v1/transactions, with the stored key set', async () => {
    const res = await api.get('/api/v1/transactions')
    expect(res.status).toBe(200)
    const rows: Row[] = res.body.txns
    for (const id of [...OUT_IDS, ...IN_IDS]) {
      const row = rows.find((r) => r.id === id)
      expect(Object.keys(row ?? {}).sort()).toStrictEqual(
        [...TRANSACTION_COLUMNS].sort(),
      )
      expect(row).toMatchObject({
        category: 'Drawings',
        category_source: 'rule',
      })
    }
    expect(rows.find((r) => r.id === 10)).toMatchObject({
      category: GROCER,
      category_source: 'akahu',
    })
  })

  it('shows every half as Drawings in GET /api/v1/accounts/transactions, with the same item keys', async () => {
    const res = await api.get('/api/v1/accounts/transactions')
    expect(res.status).toBe(200)
    const items: Row[] = res.body.items
    const out = items.find((i) => i._id === `trans_fixture_${OCT_OUT}`)
    const inItem = items.find((i) => i._id === `trans_fixture_${OCT_IN}`)
    // Drawings is not in data/cats.js, so it carries no group.
    expect(out).toMatchObject({
      category: { name: 'Drawings' },
      category_source: 'rule',
    })
    expect(inItem).toMatchObject({
      category: { name: 'Drawings' },
      category_source: 'rule',
    })
    expect(Object.keys(out?.category ?? {})).toStrictEqual(['name'])
    // The out half's keys are the ones it had before the in half existed.
    await connection('transactions').whereIn('id', IN_IDS).del()
    const before = await api.get('/api/v1/accounts/transactions')
    const alone = (before.body.items as Row[]).find(
      (i) => i._id === `trans_fixture_${OCT_OUT}`,
    )
    expect(alone).toMatchObject({
      category: { name: FX },
      category_source: 'akahu',
    })
    expect(Object.keys(out ?? {}).sort()).toStrictEqual(
      Object.keys(alone ?? {}).sort(),
    )
  })
})

describe('the pair is left out of spending, budgets and subscriptions, and balances still move (DW2)', () => {
  it('changes no budget, total or subscription; only liquid moves, by the balances', async () => {
    await seedBase()
    const scopes: Scope[] = ['all', 'personal', 'strawb']
    const before = new Map<Scope, OverviewResponse>()
    const subsBefore = new Map<Scope, SubscriptionsResponse>()
    for (const scope of scopes) {
      before.set(scope, await overview(scope))
      subsBefore.set(scope, await subscriptions(scope))
    }

    // The transfers land and Akahu's balances move with them.
    await insertAll('transactions', [...outHalves(), ...inHalves()])
    await connection('accounts')
      .where({ id: 1 })
      .update({ balance_cents: 280000 })
    await connection('accounts')
      .where({ id: 2 })
      .update({ balance_cents: 570000 })

    const liquidMoves: Record<Scope, number> = {
      all: 0,
      personal: 30000,
      strawb: -30000,
    }
    for (const scope of scopes) {
      const was = before.get(scope)!.safeToSpend
      const now = (await overview(scope)).safeToSpend
      expect(now.budgets, scope).toStrictEqual(was.budgets)
      expect(now.remainingBudgetCents, scope).toBe(was.remainingBudgetCents)
      expect(now.liquidCents - was.liquidCents, scope).toBe(liquidMoves[scope])
      expect(now.safeCents - was.safeCents, scope).toBe(liquidMoves[scope])
      expect(await subscriptions(scope), scope).toStrictEqual(
        subsBefore.get(scope),
      )
    }

    // Worked by hand: FX 0, Professional 2000, Drawings 0, Groceries 5000.
    const all = await overview('all')
    expect(spentOf(all, 1)).toBe(5000)
    expect(spentOf(all, 2)).toBe(0)
    expect(spentOf(all, 3)).toBe(2000)
    expect(spentOf(all, 4)).toBe(0)
    // Both balances moved: the cards show what Akahu reports.
    expect(all.accounts.map((a) => [a.id, a.balanceCents])).toStrictEqual([
      ['1', 280000],
      ['2', 570000],
    ])
    expect((await subscriptions('strawb')).subscriptions).toStrictEqual([])
  })
})

describe('an unmatched transfer and a 1-cent mismatch are not drawings (DW3)', () => {
  it.each<[string, Row[]]>([
    ['with no personal inflow', []],
    ['with personal inflows 1 cent short', inHalves(29999)],
    ['with personal inflows 1 cent over', inHalves(30001)],
  ])(
    'a strawb outflow %s counts as FX spending and is a subscription',
    async (_why, partners) => {
      await seedBase()
      await insertAll('transactions', [...outHalves(), ...partners])

      const strawb = await overview('strawb')
      // FX: the October outflow, 30000 of 50000.
      expect(spentOf(strawb, 2)).toBe(30000)
      expect(spentOf(strawb, 4)).toBe(0)
      expect(activity(strawb, OCT_OUT)).toMatchObject({
        category: FX,
        categorySource: 'akahu',
      })
      if (partners.length > 0) {
        expect(activity(await overview('personal'), OCT_IN)).toMatchObject({
          category: null,
          categorySource: 'akahu',
        })
      }
      const subs = await subscriptions('strawb')
      expect(
        subs.subscriptions.map((s) => [
          s.name,
          s.chargeCount,
          s.amountCents,
          s.cadence,
        ]),
      ).toStrictEqual([['EXAMPLE OWN TRANSFER OUT', 3, 30000, 'monthly']])
    },
  )
})

describe('a half Hannah categorised by hand keeps her category and counts by it (DW4)', () => {
  it('the strawb half set to Professional counts there; the personal half stays Drawings', async () => {
    await seedBase()
    await insertAll('transactions', [...outHalves(), ...inHalves()])

    const patch = await api
      .patch(`/api/v1/transactions/${OCT_OUT}`)
      .send({ category: PRO })
    expect(patch.status).toBe(200)
    expect(patch.body.transaction).toMatchObject({
      category: PRO,
      category_source: 'user',
    })

    const all = await overview('all')
    // Professional: 2000 + 30000. FX and Drawings: nothing.
    expect(spentOf(all, 3)).toBe(32000)
    expect(spentOf(all, 2)).toBe(0)
    expect(spentOf(all, 4)).toBe(0)
    expect(activity(all, OCT_OUT)).toMatchObject({
      category: PRO,
      categorySource: 'user',
    })
    expect(activity(all, OCT_IN)).toMatchObject({
      category: 'Drawings',
      categorySource: 'rule',
    })

    const rows: Row[] = (await api.get('/api/v1/transactions')).body.txns
    expect(rows.find((r) => r.id === OCT_OUT)).toMatchObject({
      category: PRO,
      category_source: 'user',
    })
    expect(rows.find((r) => r.id === OCT_IN)).toMatchObject({
      category: 'Drawings',
      category_source: 'rule',
    })
  })

  it('Drawings set by hand on an unmatched outflow leaves it out of budgets and subscriptions', async () => {
    await seedBase()
    const consultant = [
      '2026-08-27T03:00:00.000Z',
      '2026-09-27T03:00:00.000Z',
      '2026-10-27T03:00:00.000Z',
    ].map((date, i) =>
      tx(30 + i, TRADING, date, -7000, {
        category: PRO,
        description: 'EXAMPLE CONSULTANT',
      }),
    )
    await insertAll('transactions', consultant)
    // Before: Professional 2000 + 7000, and a monthly subscription.
    expect(spentOf(await overview('strawb'), 3)).toBe(9000)
    expect((await subscriptions('strawb')).subscriptions).toHaveLength(1)

    for (const id of [30, 31, 32]) {
      const res = await api
        .patch(`/api/v1/transactions/${id}`)
        .send({ category: 'Drawings' })
      expect(res.status).toBe(200)
      expect(res.body.transaction).toMatchObject({
        category: 'Drawings',
        category_source: 'user',
      })
    }

    const strawb = await overview('strawb')
    expect(spentOf(strawb, 3)).toBe(2000)
    expect(spentOf(strawb, 4)).toBe(0)
    expect(activity(strawb, 32)).toMatchObject({
      category: 'Drawings',
      categorySource: 'user',
    })
    expect((await subscriptions('strawb')).subscriptions).toStrictEqual([])
  })
})

describe('a personal→strawb transfer is not a drawing (DW5)', () => {
  it('money put in counts as today', async () => {
    await seedBase()
    await insertAll('transactions', [
      tx(40, EVERYDAY, '2026-10-27T01:00:00.000Z', -30000, {
        category: GROCER,
      }),
      tx(41, TRADING, '2026-10-27T22:00:00.000Z', 30000),
    ])
    const all = await overview('all')
    // Groceries: 5000 + 30000.
    expect(spentOf(all, 1)).toBe(35000)
    expect(activity(all, 40)).toMatchObject({
      category: GROCER,
      categorySource: 'akahu',
    })
    expect(activity(all, 41)).toMatchObject({
      category: null,
      categorySource: 'akahu',
    })
    expect(await loadDrawingIds()).toStrictEqual(new Set())
  })
})

describe('running sync again changes no drawing and never writes category (DW6)', () => {
  const settled = (
    id: string,
    accountId: string,
    date: string,
    cents: number,
  ): SettledTransaction => ({
    status: 'settled',
    id,
    account_id: accountId,
    connection_id: 'conn_fixture',
    date,
    posted_date: null,
    created_at: date,
    updated_at: date,
    hash: `hash_${id}`,
    amount_cents: cents,
    balance_cents: null,
    description: `EXAMPLE ${id}`,
    type: 'TRANSFER',
    merchant: null,
    meta: null,
    akahu_category: null,
  })
  const pending = (
    accountId: string,
    date: string,
    cents: number,
    description: string,
  ): PendingTransaction => ({
    status: 'pending',
    account_id: accountId,
    connection_id: 'conn_fixture',
    date,
    updated_at: date,
    amount_cents: cents,
    description,
    type: 'TRANSFER',
    merchant: null,
    meta: null,
    akahu_category: null,
  })
  const SETTLED = [
    settled('trans_sync_out', TRADING, '2026-10-27T01:00:00.000Z', -30000),
    settled('trans_sync_in', EVERYDAY, '2026-10-27T22:00:00.000Z', 30000),
  ]
  const PENDING = [
    pending(TRADING, '2026-10-27T21:00:00.000Z', -45000, 'EXAMPLE PENDING OUT'),
    pending(EVERYDAY, '2026-10-27T23:00:00.000Z', 45000, 'EXAMPLE PENDING IN'),
  ]

  function runSyncWrites() {
    return connection.transaction(async (trx) => {
      const counts = await upsertSettled(trx, SETTLED)
      await replacePending(trx, PENDING)
      return counts
    })
  }

  /** The drawing set by stable identity: pending row ids change on each sync. */
  async function drawingKeys(): Promise<string[]> {
    const ids = [...(await loadDrawingIds())]
    const rows: { akahu_id: string | null; description: string }[] =
      await connection('transactions')
        .whereIn('id', ids)
        .select('akahu_id', 'description')
    return rows.map((r) => r.akahu_id ?? r.description).sort()
  }

  // Pending ids are ephemeral (prd-01 Ruling 1); everything else must match.
  const stable = (body: OverviewResponse) => ({
    ...body,
    recentActivity: body.recentActivity.map((r) =>
      r.status === 'pending' ? { ...r, id: 'pending' } : r,
    ),
  })

  it('finds the same drawings, shows the same overview, and leaves category NULL', async () => {
    await seedBase()
    expect(await runSyncWrites()).toStrictEqual({ inserted: 2, updated: 0 })
    const firstKeys = await drawingKeys()
    expect(firstKeys).toStrictEqual(
      [
        'EXAMPLE PENDING IN',
        'EXAMPLE PENDING OUT',
        'trans_sync_in',
        'trans_sync_out',
      ].sort(),
    )
    const first = await overview('all')
    const synced = first.recentActivity.filter(
      (r) =>
        r.description.includes('PENDING') ||
        r.description.includes('trans_sync'),
    )
    expect(
      synced
        .map((r) => [r.description, r.status, r.category, r.categorySource])
        .sort(),
    ).toStrictEqual([
      ['EXAMPLE PENDING IN', 'pending', 'Drawings', 'rule'],
      ['EXAMPLE PENDING OUT', 'pending', 'Drawings', 'rule'],
      ['EXAMPLE trans_sync_in', 'settled', 'Drawings', 'rule'],
      ['EXAMPLE trans_sync_out', 'settled', 'Drawings', 'rule'],
    ])

    expect(await runSyncWrites()).toStrictEqual({ inserted: 0, updated: 0 })
    expect(await drawingKeys()).toStrictEqual(firstKeys)
    expect(stable(await overview('all'))).toStrictEqual(stable(first))

    const stored: { category: string | null; category_source: string }[] =
      await connection('transactions')
        .whereIn('description', [
          'EXAMPLE trans_sync_out',
          'EXAMPLE trans_sync_in',
          'EXAMPLE PENDING OUT',
          'EXAMPLE PENDING IN',
        ])
        .select('category', 'category_source')
    expect(stored).toHaveLength(4)
    for (const row of stored) {
      expect(row).toStrictEqual({ category: null, category_source: 'akahu' })
    }
    expect(await connection('category_corrections').select()).toStrictEqual([])
  })
})

describe('a row the matcher cannot place does not break the transaction lists', () => {
  // A fractional amount already fails /accounts/transactions on its own
  // (`centsToDollars` refuses it), so only the date case checks that list.
  it.each([
    ['a date past year 9999', '+275760-09-13T00:00:00.000Z', -30000, true],
    [
      'an amount that is not whole cents',
      '2026-10-27T01:00:00.000Z',
      -1234.5,
      false,
    ],
  ])(
    'the transaction lists still answer 200 beside %s',
    async (_why, date, cents, checkAccounts) => {
      await seedBase()
      await insertAll('transactions', [
        ...outHalves(),
        ...inHalves(),
        tx(90, TRADING, date, cents),
      ])
      const list = await api.get('/api/v1/transactions')
      expect(list.status).toBe(200)
      const byId = new Map<number, Row>(
        (list.body.txns as Row[]).map((r) => [r.id as number, r]),
      )
      expect(byId.get(OCT_OUT)?.category).toBe('Drawings')
      expect(byId.get(90)?.category).toBeNull()
      if (checkAccounts) {
        const accounts = await api.get('/api/v1/accounts/transactions')
        expect(accounts.status).toBe(200)
        const items = accounts.body.items as Row[]
        expect(items.map((i) => i._id)).toContain('trans_fixture_90')
      }
    },
  )

  it('GET /api/v1/transactions logs only the class when the drawings read fails', async () => {
    await seedBase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The rows are read; the drawings read joins accounts, which is away.
    await connection.schema.renameTable('accounts', 'accounts_away')
    try {
      const res = await api.get('/api/v1/transactions')
      expect(res.status).toBe(500)
      expect(res.text).toBe("Couldn't search transactions")
    } finally {
      await connection.schema.renameTable('accounts_away', 'accounts')
    }
    // Never the message, which names SQL (or a matcher's ids and amounts).
    expect(error.mock.calls).toStrictEqual([
      ['Error searching transactions:', 'Error'],
    ])
    error.mockRestore()
  })
})

describe('reads write nothing', () => {
  const TABLES = [
    'transactions',
    'accounts',
    'account_settings',
    'budgets',
    'category_corrections',
    'subscription_marks',
    'alert_dismissals',
  ]
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        TABLES.map(async (t) => [t, await connection(t).select()] as const),
      ),
    )

  it('every read that shows or counts a drawing leaves every table as it was', async () => {
    await seedBase()
    await insertAll('transactions', [...outHalves(), ...inHalves()])
    const before = await snapshot()
    for (const scope of ['all', 'personal', 'strawb'] as const) {
      await overview(scope)
      await subscriptions(scope)
    }
    expect((await api.get('/api/v1/transactions')).status).toBe(200)
    expect((await api.get('/api/v1/accounts/transactions')).status).toBe(200)
    expect(await snapshot()).toStrictEqual(before)
  })
})

describe('Drawings is a category Hannah can pick (prd-02 Ruling 15)', () => {
  it('GET /api/v1/categories ends with the Divvy group holding Drawings', async () => {
    const res = await api.get('/api/v1/categories')
    expect(res.status).toBe(200)
    const items: { name: string; categories: string[] }[] = res.body.items
    expect(items.at(-1)).toStrictEqual({
      name: 'Divvy',
      categories: ['Drawings'],
    })
    expect(
      items.flatMap((g) => g.categories).filter((c) => c === 'Drawings'),
    ).toHaveLength(1)
  })

  it('PATCH sets Drawings as her category and records the correction', async () => {
    await seedBase()
    const res = await api
      .patch('/api/v1/transactions/11')
      .send({ category: 'Drawings' })
    expect(res.status).toBe(200)
    expect(res.body.transaction).toMatchObject({
      id: 11,
      category: 'Drawings',
      category_source: 'user',
    })
    expect(
      await connection('category_corrections').select(
        'transaction_id',
        'from_category',
        'to_category',
      ),
    ).toStrictEqual([
      { transaction_id: 11, from_category: PRO, to_category: 'Drawings' },
    ])
  })

  it.each(['drawings', 'Divvy', 'Drawing'])(
    'PATCH still refuses %j',
    async (category) => {
      await seedBase()
      const res = await api.patch('/api/v1/transactions/11').send({ category })
      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({
        error: 'category must be one of GET /api/v1/categories',
      })
    },
  )
})

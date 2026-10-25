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
  BudgetResponse,
  BudgetsResponse,
  OverviewResponse,
} from '../../../shared/contracts.ts'

// /api/v1/budgets (prd-02, issue #48): the Budgets screen's list and writes,
// over HTTP against the real app and a fresh in-memory database. The clock
// is fixed at 23:30 UTC on Tuesday 27 October 2026, which is 12:30 NZDT on
// Wednesday the 28th: with payday on Tuesdays (the default) the last payday
// is 10-27 and the next is 11-03. Every value below is invented.

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
  vi.restoreAllMocks()
})

afterAll(closeDb)

const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

// `account`, `tx`, `SECRET_TOKENS` and `snapshotTables` are copies of the
// ones in ./overview.test.ts and ./bills.test.ts.
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

// Account numbers, Akahu ids and connection names: never in a payload.
const SECRET_TOKENS = [
  'acc_sentinel_',
  '00-SENT-',
  'Sentinel Bank 91c2',
  'conn_sentinel_',
]

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

// Known NZFCC categories (data/cats.js), since a budget must name one.
const GROCERIES = 'Supermarkets and grocery stores'
const EATING_OUT = 'Cafes and restaurants'
const SOFTWARE = 'Business software and cloud services'
const BAKERIES = 'Bakeries'

const ACCOUNT = { everyday: 1, trading: 2 }
const AKAHU = { everyday: 'acc_sentinel_1', trading: 'acc_sentinel_2' }

async function seedAccounts() {
  const sentinel = (n: number) => ({
    akahu_id: `acc_sentinel_${n}`,
    formatted_account: `00-SENT-000000${n}-00`,
    connection_id: `conn_sentinel_${n}`,
    connection_name: 'Sentinel Bank 91c2',
  })
  await connection('accounts').insert([
    account({
      id: ACCOUNT.everyday,
      ...sentinel(1),
      name: 'Everyday',
      scope: 'personal',
      balance_cents: 250000,
    }),
    account({
      id: ACCOUNT.trading,
      ...sentinel(2),
      name: 'Trading',
      scope: 'strawb',
      balance_cents: 600000,
    }),
  ])
  await connection('account_settings').insert([
    { account_id: ACCOUNT.everyday, role: 'current', updated_at: STAMP },
    { account_id: ACCOUNT.trading, role: 'current', updated_at: STAMP },
  ])
}

// The window runs from the last payday, 10-27 NZ, to today, 10-28 NZ.
async function seedTransactions() {
  await connection('transactions').insert([
    // 10-27 01:00 NZ: in the window.
    tx(AKAHU.everyday, '2026-10-26T12:00:00.000Z', -8000, {
      id: 1,
      category: GROCERIES,
    }),
    // Akahu said eating out; Hannah moved it to groceries.
    tx(AKAHU.everyday, '2026-10-27T05:00:00.000Z', -1500, {
      id: 2,
      category: GROCERIES,
      category_source: 'user',
      akahu_category_name: EATING_OUT,
    }),
    // 10-26 23:59 NZ: the day before the last payday, so not spent.
    tx(AKAHU.everyday, '2026-10-26T10:59:00.000Z', -9999, {
      id: 3,
      category: GROCERIES,
    }),
    // Pending counts like settled.
    tx(AKAHU.everyday, '2026-10-27T23:00:00.000Z', -3000, {
      id: 4,
      category: EATING_OUT,
      status: 'pending',
    }),
    tx(AKAHU.trading, '2026-10-27T18:00:00.000Z', -2500, {
      id: 5,
      category: SOFTWARE,
    }),
    tx(AKAHU.trading, '2026-10-27T16:00:00.000Z', -6000, {
      id: 6,
      category: GROCERIES,
    }),
    // A drawing (prd-02 Ruling 15): out of Strawb, into personal, the same
    // amount on the same NZ day. Its Akahu category is never spent.
    tx(AKAHU.trading, '2026-10-27T19:00:00.000Z', -30000, {
      id: 7,
      category: SOFTWARE,
    }),
    tx(AKAHU.everyday, '2026-10-27T20:00:00.000Z', 30000, { id: 8 }),
  ])
}

const PERSONAL_NOTE = 'Invented personal note'
const STRAWB_NOTE = 'Invented strawb note'

function budget(
  id: number,
  scope: string,
  category: string,
  limit: number,
  note: unknown = null,
): Row {
  return {
    id,
    scope,
    category,
    limit_cents: limit,
    note,
    created_at: STAMP,
    updated_at: STAMP,
  }
}

// The same category in both scopes, so no scope test can pass by name.
async function seedBudgets() {
  await connection('budgets').insert([
    budget(1, 'personal', GROCERIES, 20000, PERSONAL_NOTE),
    budget(2, 'personal', EATING_OUT, 5000),
    budget(3, 'strawb', SOFTWARE, 10000, STRAWB_NOTE),
    budget(4, 'strawb', GROCERIES, 4000),
  ])
}

async function seedAll() {
  await seedAccounts()
  await seedTransactions()
  await seedBudgets()
}

// Worked by hand from the rows above.
const EXPECTED: Record<string, BudgetResponse> = {
  // 8000 + 1500 (recategorised); 9999 is before the window.
  '1': {
    id: '1',
    scope: 'personal',
    category: GROCERIES,
    limitCents: 20000,
    spentCents: 9500,
    remainingCents: 10500,
    overCents: 0,
    note: PERSONAL_NOTE,
  },
  // 3000 pending; the recategorised 1500 is not here.
  '2': {
    id: '2',
    scope: 'personal',
    category: EATING_OUT,
    limitCents: 5000,
    spentCents: 3000,
    remainingCents: 2000,
    overCents: 0,
    note: null,
  },
  // 2500; the 30000 drawing is not spent.
  '3': {
    id: '3',
    scope: 'strawb',
    category: SOFTWARE,
    limitCents: 10000,
    spentCents: 2500,
    remainingCents: 7500,
    overCents: 0,
    note: STRAWB_NOTE,
  },
  '4': {
    id: '4',
    scope: 'strawb',
    category: GROCERIES,
    limitCents: 4000,
    spentCents: 6000,
    remainingCents: 0,
    overCents: 2000,
    note: null,
  },
}

const getBudgets = (scope: string) => api.get(`/api/v1/budgets?scope=${scope}`)
const getOverview = (scope: string) =>
  api.get(`/api/v1/overview?scope=${scope}`)
const postBudget = (body: unknown) =>
  api.post('/api/v1/budgets').send(body as object)
const postRaw = (text: string) =>
  api.post('/api/v1/budgets').type('json').send(text)
const patchBudget = (id: string | number, body: unknown) =>
  api.patch(`/api/v1/budgets/${id}`).send(body as object)
const deleteBudget = (id: string | number) =>
  api.delete(`/api/v1/budgets/${id}`)

const budgetRows = () => connection('budgets').select().orderBy('id')

const sortedKeys = (o: object) => Object.keys(o).sort()

const LIST_KEYS = ['items', 'periodEnd', 'periodStart']
const BUDGET_KEYS = [
  'category',
  'id',
  'limitCents',
  'note',
  'overCents',
  'remainingCents',
  'scope',
  'spentCents',
]

const VALID = {
  scope: 'personal',
  category: BAKERIES,
  limitCents: 3000,
}

function withoutNote(item: BudgetResponse): Partial<BudgetResponse> {
  const line: Partial<BudgetResponse> = { ...item }
  delete line.note
  return line
}

async function overviewOf(scope: string): Promise<OverviewResponse> {
  const res = await getOverview(scope)
  expect(res.status).toBe(200)
  return res.body
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/v1/budgets', () => {
  it.each([
    ['no scope', '/api/v1/budgets'],
    ['an unknown scope', '/api/v1/budgets?scope=bogus'],
    ['a capitalised scope', '/api/v1/budgets?scope=Personal'],
    ['a repeated scope', '/api/v1/budgets?scope=all&scope=all'],
  ])('refuses %s', async (_why, path) => {
    const res = await api.get(path)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
  })

  it('answers no budgets with every key and the overview’s period', async () => {
    const res = await getBudgets('all')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(sortedKeys(res.body)).toStrictEqual(LIST_KEYS)
    expect(res.body).toStrictEqual({
      items: [],
      periodStart: '2026-10-27',
      periodEnd: '2026-11-03',
    })
  })

  it('answers each budget’s spent, remaining and over, worked by hand, in id order', async () => {
    await seedAll()

    const res = await getBudgets('all')

    expect(res.status).toBe(200)
    const body: BudgetsResponse = res.body
    expect(sortedKeys(body)).toStrictEqual(LIST_KEYS)
    for (const item of body.items) {
      expect(sortedKeys(item)).toStrictEqual(BUDGET_KEYS)
    }
    expect(body.items).toStrictEqual([
      EXPECTED['1'],
      EXPECTED['2'],
      EXPECTED['3'],
      EXPECTED['4'],
    ])
    expect(body.periodStart).toBe('2026-10-27')
    expect(body.periodEnd).toBe('2026-11-03')
  })

  it('keeps id order whatever order the rows were inserted in', async () => {
    await seedAccounts()
    await connection('budgets').insert([
      budget(9, 'personal', BAKERIES, 100),
      budget(2, 'strawb', BAKERIES, 100),
      budget(10, 'personal', EATING_OUT, 100),
    ])

    const body: BudgetsResponse = (await getBudgets('all')).body

    expect(body.items.map((i) => i.id)).toEqual(['2', '9', '10'])
  })

  it('writes nothing', async () => {
    await seedAll()
    const before = await snapshotTables()

    expect((await getBudgets('all')).status).toBe(200)
    expect(await snapshotTables()).toStrictEqual(before)
  })

  describe('scopes', () => {
    beforeEach(seedAll)

    it.each([
      ['personal', ['1', '2'], PERSONAL_NOTE, STRAWB_NOTE],
      ['strawb', ['3', '4'], STRAWB_NOTE, PERSONAL_NOTE],
    ])('%s shows only its own budgets', async (scope, ids, own, other) => {
      const res = await getBudgets(scope)

      expect(res.status).toBe(200)
      const body: BudgetsResponse = res.body
      expect(body.items.map((i) => i.id)).toEqual(ids)
      expect(body.items.every((i) => i.scope === scope)).toBe(true)
      expect(res.text).toContain(own)
      expect(res.text).not.toContain(other)
    })

    it('all shows both', async () => {
      const body: BudgetsResponse = (await getBudgets('all')).body

      expect(body.items.map((i) => i.id)).toEqual(['1', '2', '3', '4'])
    })

    it.each(['all', 'personal', 'strawb'])(
      'scope=%s carries no account number, Akahu id or connection name',
      async (scope) => {
        const res = await getBudgets(scope)

        for (const token of SECRET_TOKENS) {
          expect(res.text).not.toContain(token)
        }
      },
    )
  })
})

// ---------------------------------------------------------------------------
// Spent is the overview's
// ---------------------------------------------------------------------------

describe('every budget line is the overview ledger’s', () => {
  beforeEach(seedAll)

  // Red if spent is recomputed by a second query: without the drawing
  // overlay the strawb software line would be 32500, and on Akahu's
  // category the recategorised 1500 would move from groceries.
  it.each(['all', 'personal', 'strawb'])(
    'scope=%s: each item but its note is the overview’s line, and the period is its paydays',
    async (scope) => {
      const budgets: BudgetsResponse = (await getBudgets(scope)).body
      const s = (await overviewOf(scope)).safeToSpend

      expect(budgets.items.map(withoutNote)).toStrictEqual(s.budgets)
      expect(budgets.items.map((i) => i.id)).toEqual(s.budgets.map((l) => l.id))
      expect(budgets.items.reduce((sum, i) => sum + i.remainingCents, 0)).toBe(
        s.remainingBudgetCents,
      )
      expect(budgets.periodStart).toBe(s.lastPayday)
      expect(budgets.periodEnd).toBe(s.nextPayday)
      for (const item of budgets.items) {
        expect(item).toStrictEqual(EXPECTED[item.id])
      }
    },
  )
})

// ---------------------------------------------------------------------------
// Writes reach the overview on the next call
// ---------------------------------------------------------------------------

describe('a write changes the overview’s budgets left on the next call', () => {
  beforeEach(seedAll)

  async function expectAgreement() {
    for (const scope of ['all', 'personal', 'strawb']) {
      const budgets: BudgetsResponse = (await getBudgets(scope)).body
      const s = (await overviewOf(scope)).safeToSpend
      expect(budgets.items.map(withoutNote), scope).toStrictEqual(s.budgets)
    }
  }

  it('raising a limit raises budgets left and lowers safe-to-spend by the same amount', async () => {
    const before = (await overviewOf('personal')).safeToSpend
    expect(before.remainingBudgetCents).toBe(12500)

    const res = await patchBudget(1, { limitCents: 30000 })
    expect(res.status).toBe(200)
    expect(res.body.remainingCents).toBe(20500)

    const after = (await overviewOf('personal')).safeToSpend
    expect(after.remainingBudgetCents).toBe(22500)
    expect(before.safeCents - after.safeCents).toBe(10000)
    expect((await budgetRows())[0].limit_cents).toBe(30000)
    await expectAgreement()
  })

  it('a limit under spent is over, and the overview raises its alert', async () => {
    const alertId = 'over_budget:1:2026-10-27'
    expect(
      (await overviewOf('personal')).alerts.map((a) => a.id),
    ).not.toContain(alertId)

    const res = await patchBudget(1, { limitCents: 9000 })
    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      ...EXPECTED['1'],
      limitCents: 9000,
      remainingCents: 0,
      overCents: 500,
    })

    const overview = await overviewOf('personal')
    expect(overview.safeToSpend.remainingBudgetCents).toBe(2000)
    const alert = overview.alerts.find((a) => a.id === alertId)
    expect(alert).toStrictEqual({
      id: alertId,
      kind: 'over_budget',
      scope: 'personal',
      subject: GROCERIES,
      amountCents: 500,
      dueDate: null,
    })
    await expectAgreement()
  })

  it('creating a budget counts this week’s spend at once; deleting one gives its remaining back', async () => {
    // Budget 3 goes first, so the new one is over spend already made.
    expect((await deleteBudget(3)).status).toBe(204)
    let s = (await overviewOf('strawb')).safeToSpend
    expect(s.remainingBudgetCents).toBe(0)

    const made = await postBudget({
      scope: 'strawb',
      category: SOFTWARE,
      limitCents: 10000,
    })
    expect(made.status).toBe(201)
    expect(made.body).toMatchObject({ spentCents: 2500, remainingCents: 7500 })

    s = (await overviewOf('strawb')).safeToSpend
    expect(s.remainingBudgetCents).toBe(7500)
    await expectAgreement()

    const safeBefore = s.safeCents
    expect((await deleteBudget(made.body.id)).status).toBe(204)
    s = (await overviewOf('strawb')).safeToSpend
    expect(s.remainingBudgetCents).toBe(0)
    expect(s.safeCents - safeBefore).toBe(7500)
    await expectAgreement()
  })
})

// ---------------------------------------------------------------------------
// Only this site may write
// ---------------------------------------------------------------------------

describe('only this site may write (as POST /api/v1/sync/run)', () => {
  const WRITES: [string, () => ReturnType<typeof deleteBudget>][] = [
    ['POST /', () => postBudget(VALID)],
    ['PATCH /1', () => patchBudget(1, { limitCents: 100 })],
    ['DELETE /1', () => deleteBudget(1)],
  ]
  // Headers are built per test: the served port is known only once the
  // server listens. supertest sends `Host: 127.0.0.1:<port>`.
  type Headers = (port: number) => Record<string, string>
  const port = (): number => {
    if (served === undefined) throw new Error('the server is not listening')
    return served.address.port
  }

  const REFUSED: [string, Headers][] = [
    ['Sec-Fetch-Site cross-site', () => ({ 'Sec-Fetch-Site': 'cross-site' })],
    [
      'Sec-Fetch-Site same-site with this host’s own Origin',
      (p) => ({
        'Sec-Fetch-Site': 'same-site',
        Origin: `http://127.0.0.1:${p}`,
      }),
    ],
    ['a foreign Origin', () => ({ Origin: 'http://evil.example' })],
    ['Origin null', () => ({ Origin: 'null' })],
    [
      'an Origin that differs from Host by port only',
      (p) => ({ Origin: `http://127.0.0.1:${p + 1}` }),
    ],
  ]

  describe.each(WRITES)('%s', (_write, send) => {
    it.each(REFUSED)('refuses %s, writing nothing', async (_why, headers) => {
      await seedAll()
      const before = await snapshotTables()

      const res = await send().set(headers(port()))

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
      expect(await snapshotTables()).toStrictEqual(before)
    })
  })

  // The site check runs before the id and the body are read: a cross-site
  // write with a bad id or body is 403, not 400. Each request is first sent
  // without the header to show it really is a 400 on its own.
  it.each([
    ['PATCH /abc', () => patchBudget('abc', { limitCents: 100 })],
    ['DELETE /abc', () => deleteBudget('abc')],
    ['POST / with an invalid body', () => postBudget({})],
    [
      'PATCH /1 with an invalid body',
      () => patchBudget(1, { limitCents: 'x' }),
    ],
  ])(
    'refuses a cross-site %s with 403 before reading the id or body',
    async (_write, send) => {
      await seedAll()
      const before = await snapshotTables()

      expect((await send()).status).toBe(400)

      const res = await send().set('Sec-Fetch-Site', 'cross-site')

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
      expect(await snapshotTables()).toStrictEqual(before)
    },
  )

  it.each([
    ['Sec-Fetch-Site same-origin', () => ({ 'Sec-Fetch-Site': 'same-origin' })],
    ['Sec-Fetch-Site none', () => ({ 'Sec-Fetch-Site': 'none' })],
    ['no headers (curl)', () => ({})],
    [
      'no Sec-Fetch-Site and this host’s own Origin',
      (p) => ({ Origin: `http://127.0.0.1:${p}` }),
    ],
    [
      'no Sec-Fetch-Site, a mixed-case Host and its lowercase Origin',
      (p) => ({ Host: `LocalHost:${p}`, Origin: `http://localhost:${p}` }),
    ],
  ] satisfies [string, Headers][])(
    '%s passes every write',
    async (_why, build) => {
      await seedAccounts()
      const headers = build(port())
      const made = await postBudget(VALID).set(headers)
      expect(made.status).toBe(201)
      expect(
        (await patchBudget(made.body.id, { limitCents: 100 }).set(headers))
          .status,
      ).toBe(200)
      expect((await deleteBudget(made.body.id).set(headers)).status).toBe(204)
    },
  )
})

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe('POST /api/v1/budgets', () => {
  it('creates the budget in integer cents and answers 201 with its line, as the list then shows it', async () => {
    await seedAccounts()
    await seedTransactions()

    const res = await postBudget({
      scope: 'personal',
      category: GROCERIES,
      limitCents: 20000,
      note: '  Invented note  ',
    })

    expect(res.status).toBe(201)
    expect(sortedKeys(res.body)).toStrictEqual(BUDGET_KEYS)
    const rows = await budgetRows()
    expect(rows).toHaveLength(1)
    expect(res.body).toStrictEqual({
      id: String(rows[0].id),
      scope: 'personal',
      category: GROCERIES,
      limitCents: 20000,
      spentCents: 9500,
      remainingCents: 10500,
      overCents: 0,
      note: 'Invented note',
    })
    expect(rows[0]).toMatchObject({
      scope: 'personal',
      category: GROCERIES,
      limit_cents: 20000,
      note: 'Invented note',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    })
    const [{ kind }]: { kind: string }[] = await connection('budgets').select(
      connection.raw('typeof(limit_cents) as kind'),
    )
    expect(kind).toBe('integer')

    const list: BudgetsResponse = (await getBudgets('personal')).body
    expect(list.items).toStrictEqual([res.body])
  })

  it('takes a limit of 0: nothing remaining, all spend over', async () => {
    await seedAccounts()
    await seedTransactions()

    const res = await postBudget({
      scope: 'strawb',
      category: SOFTWARE,
      limitCents: 0,
    })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      limitCents: 0,
      spentCents: 2500,
      remainingCents: 0,
      overCents: 2500,
      note: null,
    })
  })

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['blank', '   '],
  ])('stores a note that is %s as null', async (_why, note) => {
    await seedAccounts()

    const res = await postBudget({ ...VALID, note })

    expect(res.status).toBe(201)
    expect(res.body.note).toBeNull()
    expect((await budgetRows())[0].note).toBeNull()
  })

  it('takes a limit at the cap', async () => {
    await seedAccounts()

    const res = await postBudget({ ...VALID, limitCents: 1_000_000_000 })

    expect(res.status).toBe(201)
    expect(res.body.limitCents).toBe(1_000_000_000)
    expect((await budgetRows())[0].limit_cents).toBe(1_000_000_000)
  })

  it('takes a note of 500 characters', async () => {
    await seedAccounts()
    const note = 'n'.repeat(500)

    const res = await postBudget({ ...VALID, note })

    expect(res.status).toBe(201)
    expect(res.body.note).toBe(note)
  })

  it('refuses a second budget for the same category and scope with 409; the other scope may have one', async () => {
    await seedAccounts()
    expect((await postBudget(VALID)).status).toBe(201)
    const before = await snapshotTables()

    const res = await postBudget({ ...VALID, limitCents: 999 })

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'A budget for that category already exists in this scope',
    })
    expect(await snapshotTables()).toStrictEqual(before)
    expect(await budgetRows()).toHaveLength(1)

    const other = await postBudget({ ...VALID, scope: 'strawb' })
    expect(other.status).toBe(201)
    expect(await budgetRows()).toHaveLength(2)
  })

  it('never reuses a deleted budget’s id', async () => {
    await seedAccounts()
    const first = await postBudget(VALID)
    expect((await deleteBudget(first.body.id)).status).toBe(204)

    const second = await postBudget(VALID)

    expect(second.status).toBe(201)
    expect(Number(second.body.id)).toBeGreaterThan(Number(first.body.id))
  })

  const SENTINEL = 'zz-sentinel-4be7'
  const SCOPE_ERROR = 'scope must be personal or strawb'
  const CATEGORY_ERROR =
    'category must be a known spending category (not Drawings)'
  const LIMIT_ERROR =
    'limitCents must be a whole number of cents from 0 to 1000000000'
  const NOTE_ERROR = 'note must be text of at most 500 characters, or null'

  it.each([
    ['an array body', [], 'Body must be a JSON object'],
    ['an unknown field id', { ...VALID, id: '5' }, 'Unknown field in body'],
    [
      'an unknown field status',
      { ...VALID, status: 'over' },
      'Unknown field in body',
    ],
    [
      'an unknown field spentCents',
      { ...VALID, spentCents: 0 },
      'Unknown field in body',
    ],
    ['no scope', { ...VALID, scope: undefined }, SCOPE_ERROR],
    ['scope all', { ...VALID, scope: 'all' }, SCOPE_ERROR],
    ['a capitalised scope', { ...VALID, scope: 'Personal' }, SCOPE_ERROR],
    ['an unknown scope', { ...VALID, scope: SENTINEL }, SCOPE_ERROR],
    ['a null scope', { ...VALID, scope: null }, SCOPE_ERROR],
    ['no category', { ...VALID, category: undefined }, CATEGORY_ERROR],
    ['an empty category', { ...VALID, category: '' }, CATEGORY_ERROR],
    ['an unknown category', { ...VALID, category: SENTINEL }, CATEGORY_ERROR],
    ['Drawings', { ...VALID, category: 'Drawings' }, CATEGORY_ERROR],
    [
      'a category with a leading space',
      { ...VALID, category: ` ${BAKERIES}` },
      CATEGORY_ERROR,
    ],
    [
      'a category in the wrong case',
      { ...VALID, category: BAKERIES.toLowerCase() },
      CATEGORY_ERROR,
    ],
    ['a numeric category', { ...VALID, category: 7 }, CATEGORY_ERROR],
    ['no limit', { ...VALID, limitCents: undefined }, LIMIT_ERROR],
    ['a negative limit', { ...VALID, limitCents: -1 }, LIMIT_ERROR],
    ['a string limit', { ...VALID, limitCents: '1000' }, LIMIT_ERROR],
    ['a decimal string limit', { ...VALID, limitCents: '10.50' }, LIMIT_ERROR],
    ['a null limit', { ...VALID, limitCents: null }, LIMIT_ERROR],
    ['a boolean limit', { ...VALID, limitCents: true }, LIMIT_ERROR],
    [
      'a limit over the cap',
      { ...VALID, limitCents: 1_000_000_001 },
      LIMIT_ERROR,
    ],
    ['a numeric note', { ...VALID, note: 5 }, NOTE_ERROR],
    ['a 501-character note', { ...VALID, note: 'n'.repeat(501) }, NOTE_ERROR],
    // Field order decides which error, never the body's key order.
    [
      'several bad fields, scope first',
      { note: 5, limitCents: -1, category: SENTINEL, scope: 'all' },
      SCOPE_ERROR,
    ],
    [
      'several bad fields, category next',
      { note: 5, limitCents: -1, category: SENTINEL, scope: 'personal' },
      CATEGORY_ERROR,
    ],
    [
      'several bad fields, limit next',
      { note: 5, limitCents: -1, category: BAKERIES, scope: 'personal' },
      LIMIT_ERROR,
    ],
  ])('refuses %s with 400, writing nothing', async (_why, body, error) => {
    await seedAccounts()
    const before = await snapshotTables()

    const res = await postBudget(body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(res.text).not.toContain(SENTINEL)
    expect(await snapshotTables()).toStrictEqual(before)
  })

  // Sent as raw JSON text, so no client-side serialiser touches the number.
  it.each([
    ['a float limit', '1050.5'],
    ['a limit past the safe integers', '9007199254740993'],
  ])('refuses %s in raw JSON with 400', async (_why, limit) => {
    await seedAccounts()
    const before = await snapshotTables()

    const res = await postRaw(
      `{"scope":"personal","category":"${BAKERIES}","limitCents":${limit}}`,
    )

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: LIMIT_ERROR })
    expect(await snapshotTables()).toStrictEqual(before)
  })

  // express.json() is strict: a top-level null or string never reaches the
  // router, and the app's error handler answers it.
  it.each([
    ['null', 'null'],
    ['a JSON string', '"budget"'],
  ])('refuses a body that is %s with the app’s 400', async (_why, text) => {
    const res = await postRaw(text)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Bad request' })
    expect(await budgetRows()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const BAD_IDS = ['abc', '0', '01', '1e3', '-1', '9007199254740993']

describe('PATCH /api/v1/budgets/:id', () => {
  beforeEach(seedAll)

  it('steps the limit up and back down by $10, persisting each', async () => {
    const up = await patchBudget(1, { limitCents: 21000 })
    expect(up.status).toBe(200)
    expect(sortedKeys(up.body)).toStrictEqual(BUDGET_KEYS)
    expect(up.body).toStrictEqual({
      ...EXPECTED['1'],
      limitCents: 21000,
      remainingCents: 11500,
    })
    expect((await budgetRows())[0].limit_cents).toBe(21000)

    const down = await patchBudget(1, { limitCents: 20000 })
    expect(down.status).toBe(200)
    expect(down.body).toStrictEqual(EXPECTED['1'])
    expect((await budgetRows())[0].limit_cents).toBe(20000)

    const list: BudgetsResponse = (await getBudgets('personal')).body
    expect(list.items[0]).toStrictEqual(down.body)
  })

  it('sets, trims and clears the note', async () => {
    const set = await patchBudget(2, { note: '  Invented reminder  ' })
    expect(set.status).toBe(200)
    expect(set.body.note).toBe('Invented reminder')
    expect((await budgetRows())[1].note).toBe('Invented reminder')

    const cleared = await patchBudget(2, { note: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toStrictEqual(EXPECTED['2'])
    expect((await budgetRows())[1].note).toBeNull()
  })

  it('a change sets updated_at and leaves created_at', async () => {
    const res = await patchBudget(1, { limitCents: 25000 })

    expect(res.status).toBe(200)
    expect((await budgetRows())[0]).toMatchObject({
      created_at: STAMP,
      updated_at: NOW_ISO,
    })
  })

  it.each([
    ['{}', {}],
    ['the same limit', { limitCents: 20000 }],
    ['the same note', { note: PERSONAL_NOTE }],
    ['the same note, padded', { note: `  ${PERSONAL_NOTE} ` }],
  ])(
    'answers %s with the budget unchanged, writing nothing',
    async (_why, body) => {
      vi.setSystemTime('2026-10-28T00:30:00.000Z')
      const before = await snapshotTables()

      const res = await patchBudget(1, body)

      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual(EXPECTED['1'])
      expect(await snapshotTables()).toStrictEqual(before)
    },
  )

  it.each(BAD_IDS)('refuses id %s before reading the body', async (id) => {
    const res = await patchBudget(id, [])

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })

  it('answers 404 for a budget that does not exist', async () => {
    const res = await patchBudget(999, { limitCents: 100 })

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Budget not found' })
  })

  it('refuses a bad body with 400 before looking for the budget', async () => {
    const res = await patchBudget(999, { limitCents: -1 })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'limitCents must be a whole number of cents from 0 to 1000000000',
    })
  })

  it.each([
    [
      'a negative limit',
      { limitCents: -1 },
      'limitCents must be a whole number of cents from 0 to 1000000000',
    ],
    [
      'a float limit',
      { limitCents: 10.5 },
      'limitCents must be a whole number of cents from 0 to 1000000000',
    ],
    [
      'a null limit',
      { limitCents: null },
      'limitCents must be a whole number of cents from 0 to 1000000000',
    ],
    [
      'a numeric note',
      { note: 5 },
      'note must be text of at most 500 characters, or null',
    ],
    ['a scope', { scope: 'strawb' }, 'Unknown field in body'],
    ['a category', { category: BAKERIES }, 'Unknown field in body'],
    ['an id', { id: 1 }, 'Unknown field in body'],
    ['spentCents', { spentCents: 0 }, 'Unknown field in body'],
    ['an array body', [], 'Body must be a JSON object'],
  ])('refuses %s with 400, writing nothing', async (_why, body, error) => {
    const before = await snapshotTables()

    const res = await patchBudget(1, body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(await snapshotTables()).toStrictEqual(before)
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/budgets/:id', () => {
  beforeEach(seedAll)

  it('deletes only that budget: 204 with no body; a second delete is 404', async () => {
    const res = await deleteBudget(2)

    expect(res.status).toBe(204)
    expect(res.text).toBe('')
    expect((await budgetRows()).map((r) => r.id)).toEqual([1, 3, 4])

    const again = await deleteBudget(2)
    expect(again.status).toBe(404)
    expect(again.body).toStrictEqual({ error: 'Budget not found' })
  })

  it('answers 404 for a budget that does not exist', async () => {
    const before = await snapshotTables()

    const res = await deleteBudget(999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Budget not found' })
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it.each(BAD_IDS)('refuses id %s', async (id) => {
    const res = await deleteBudget(id)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })
})

// ---------------------------------------------------------------------------
// One shape everywhere
// ---------------------------------------------------------------------------

describe('POST, PATCH and the list answer one shape', () => {
  it('the created line, the patched line and the listed line are the same object', async () => {
    await seedAccounts()
    await seedTransactions()

    const made = await postBudget({
      scope: 'strawb',
      category: GROCERIES,
      limitCents: 4000,
    })
    const patched = await patchBudget(made.body.id, {})
    const listed: BudgetsResponse = (await getBudgets('strawb')).body

    for (const body of [made.body, patched.body, ...listed.items]) {
      expect(sortedKeys(body)).toStrictEqual(BUDGET_KEYS)
    }
    expect(patched.body).toStrictEqual(made.body)
    expect(listed.items).toStrictEqual([made.body])
    expect(made.body).toStrictEqual({ ...EXPECTED['4'], id: made.body.id })
  })

  it.each(['all', 'personal', 'strawb'])(
    'scope=%s answers exactly the list keys',
    async (scope) => {
      await seedAll()

      const res = await getBudgets(scope)

      expect(sortedKeys(res.body)).toStrictEqual(LIST_KEYS)
    },
  )
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('an overview that cannot be read', () => {
  async function seedNoBalance() {
    await seedAll()
    await connection('accounts')
      .where({ id: ACCOUNT.everyday })
      .update({ balance_cents: null })
  }

  it('fails GET with the overview’s fixed text, logging only the class', async () => {
    await seedNoBalance()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getBudgets('strawb')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'an account has no balance' })
    expect(logged.mock.calls).toStrictEqual([
      ['budgets: could not list budgets', 'OverviewDataError'],
    ])
  })

  // The read after the write is inside the write's transaction, so a write
  // the screen could not show is rolled back rather than stored.
  it.each([
    ['POST /', 'create budget', () => postBudget(VALID)],
    ['PATCH /1', 'update budget', () => patchBudget(1, { limitCents: 100 })],
  ])('rolls %s back and answers 500', async (_route, what, send) => {
    await seedNoBalance()
    const before = await snapshotTables()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await send()

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'an account has no balance' })
    expect(logged.mock.calls).toStrictEqual([
      [`budgets: could not ${what}`, 'OverviewDataError'],
    ])
    expect(await snapshotTables()).toStrictEqual(before)
  })
})

describe('a stored note that is not text', () => {
  it('answers 500 with the fixed text, logging only the class', async () => {
    await seedAccounts()
    await connection('budgets').insert(
      budget(1, 'personal', BAKERIES, 100, Buffer.from('zz-sentinel-blob')),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getBudgets('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a stored budget is not valid' })
    expect(res.text).not.toContain('zz-sentinel-blob')
    expect(logged.mock.calls).toStrictEqual([
      ['budgets: could not list budgets', 'BudgetsDataError'],
    ])
  })

  it('fails only its own scope’s list', async () => {
    await seedAccounts()
    await connection('budgets').insert([
      budget(1, 'personal', BAKERIES, 100, Buffer.from('zz-sentinel-blob')),
      budget(2, 'strawb', BAKERIES, 100),
    ])
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const strawb = await getBudgets('strawb')

    expect(strawb.status).toBe(200)
    expect(strawb.body.items.map((i: BudgetResponse) => i.id)).toEqual(['2'])
    expect((await getBudgets('personal')).status).toBe(500)
  })
})

describe('a failure that is not a BudgetsDataError', () => {
  // The table is set aside so the query fails with SQLite's own message,
  // which names it; that text must reach neither the client nor the log.
  it.each([
    ['GET /', 'list budgets', () => getBudgets('all')],
    ['POST /', 'create budget', () => postBudget(VALID)],
    ['PATCH /1', 'update budget', () => patchBudget(1, { limitCents: 100 })],
    ['DELETE /1', 'delete budget', () => deleteBudget(1)],
  ])(
    '%s answers the generic 500 and logs only the class',
    async (_route, what, send) => {
      await seedAll()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      await connection.schema.renameTable('budgets', 'budgets_aside')
      try {
        const res = await send()

        expect(res.status).toBe(500)
        expect(res.body).toStrictEqual({ error: 'Internal server error' })
        expect(res.text).not.toContain('budgets_aside')
        expect(logged.mock.calls).toStrictEqual([
          [`budgets: could not ${what}`, 'Error'],
        ])
      } finally {
        await connection.schema.renameTable('budgets_aside', 'budgets')
      }
    },
  )
})

describe('paths this router does not serve', () => {
  it.each([
    ['GET /1', () => api.get('/api/v1/budgets/1')],
    ['PUT /1', () => api.put('/api/v1/budgets/1').send(VALID)],
  ])('%s is the app’s JSON 404', async (_why, send) => {
    await seedAll()

    const res = await send()

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })
})

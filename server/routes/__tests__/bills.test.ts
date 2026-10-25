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
  BillResponse,
  BillsResponse,
  OverviewResponse,
} from '../../../shared/contracts.ts'

// /api/v1/bills (prd-02, issue #49): the Bills screen's list and writes,
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

// `account`, `setting`, `bill`, `SECRET_TOKENS` and `snapshotTables` are
// copies of the ones in ./overview.test.ts.
function account(fields: Row): Row {
  return {
    source: 'akahu',
    name: 'Invented account',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

function setting(key: string, value: string | null): Row {
  return { key, value, updated_at: STAMP }
}

function bill(
  id: number,
  scope: string,
  name: string,
  repeat: string,
  amount: number,
  first: string,
  fields: Row = {},
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

const ACCOUNT = { everyday: 1, trading: 2, strawbPot: 3, xero: 4 }

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
    account({
      id: ACCOUNT.strawbPot,
      ...sentinel(3),
      name: 'Strawb tax pot',
      scope: 'strawb',
      balance_cents: 5000,
    }),
    account({
      id: ACCOUNT.xero,
      akahu_id: null,
      source: 'xero',
      name: 'Xero ledger',
      scope: 'strawb',
      balance_cents: 777700,
    }),
  ])
  await connection('account_settings').insert([
    { account_id: ACCOUNT.everyday, role: 'current', updated_at: STAMP },
    { account_id: ACCOUNT.trading, role: 'current', updated_at: STAMP },
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

const getBills = (scope: string) => api.get(`/api/v1/bills?scope=${scope}`)
const getOverview = (scope: string) =>
  api.get(`/api/v1/overview?scope=${scope}`)
const postBill = (body: unknown) =>
  api.post('/api/v1/bills').send(body as object)
const patchBill = (id: string | number, body: unknown) =>
  api.patch(`/api/v1/bills/${id}`).send(body as object)
const deleteBill = (id: string | number) => api.delete(`/api/v1/bills/${id}`)
const pay = (id: string | number) => api.post(`/api/v1/bills/${id}/payments`)

const payments = () => connection('bill_payments').select().orderBy('id')

const sortedKeys = (o: object) => Object.keys(o).sort()

const LIST_KEYS = [
  'items',
  'dueBeforePaydayCents',
  'nextBill',
  'paidThisMonthCents',
]
const BILL_KEYS = [
  'accountName',
  'amountCents',
  'dueDate',
  'firstDueDate',
  'id',
  'name',
  'paid',
  'paidAt',
  'repeat',
  'scope',
]

const VALID = {
  scope: 'personal',
  name: 'Invented power',
  amountCents: 4500,
  firstDueDate: '2026-11-02',
  repeat: 'monthly',
}

// The weekly anchors with exactly 1000 and 1001 occurrences through the
// next payday, 11-03: 999 and 1000 weeks before it.
const ANCHOR_1000 = new Date(Date.UTC(2026, 10, 3) - 6993 * 86400000)
  .toISOString()
  .slice(0, 10)
const ANCHOR_1001 = new Date(Date.UTC(2026, 10, 3) - 7000 * 86400000)
  .toISOString()
  .slice(0, 10)

async function created(body: Row): Promise<BillResponse> {
  const res = await postBill({ ...VALID, ...body })
  expect(res.status).toBe(201)
  return res.body
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/v1/bills', () => {
  it.each([
    ['no scope', '/api/v1/bills'],
    ['an unknown scope', '/api/v1/bills?scope=nope'],
    ['a capitalised scope', '/api/v1/bills?scope=All'],
    ['a repeated scope', '/api/v1/bills?scope=all&scope=all'],
  ])('refuses %s', async (_why, path) => {
    const res = await api.get(path)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
  })

  it('answers an empty list with every key', async () => {
    const res = await getBills('all')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(sortedKeys(res.body)).toStrictEqual([...LIST_KEYS].sort())
    expect(res.body).toStrictEqual({
      items: [],
      dueBeforePaydayCents: 0,
      nextBill: null,
      paidThisMonthCents: 0,
    })
  })

  it('pins every key, orders unpaid first then by due date then id, and names the next bill', async () => {
    await seedAccounts()
    await connection('bills').insert([
      bill(2, 'personal', 'Invented gym', 'weekly', 1500, '2026-10-21', {
        account_id: ACCOUNT.everyday,
      }),
      bill(10, 'personal', 'Invented phone', 'weekly', 2500, '2026-10-21'),
      bill(9, 'strawb', 'Invented hosting', 'monthly', 12000, '2026-10-14'),
      bill(3, 'personal', 'Invented dentist', 'none', 9000, '2026-10-01'),
    ])
    await connection('bill_payments').insert({
      bill_id: 3,
      due_date: '2026-10-01',
      amount_cents: 9000,
      paid_at: '2026-10-02T00:00:00.000Z',
    })

    const res = await getBills('all')

    expect(res.status).toBe(200)
    const body: BillsResponse = res.body
    expect(sortedKeys(body)).toStrictEqual([...LIST_KEYS].sort())
    for (const item of body.items) {
      expect(sortedKeys(item)).toStrictEqual([...BILL_KEYS].sort())
    }
    expect(body.items.map((i) => i.id)).toEqual(['9', '2', '10', '3'])
    expect(body.items[1]).toStrictEqual({
      id: '2',
      scope: 'personal',
      name: 'Invented gym',
      amountCents: 1500,
      dueDate: '2026-10-21',
      repeat: 'weekly',
      firstDueDate: '2026-10-21',
      paid: false,
      paidAt: null,
      accountName: 'Everyday',
    })
    expect(body.items[3]).toMatchObject({
      paid: true,
      paidAt: '2026-10-02T00:00:00.000Z',
    })
    expect(body.nextBill).toStrictEqual(body.items[0])
    // 12000 (10-14) + 1500 × 2 + 2500 × 2 (10-21 and 10-28).
    expect(body.dueBeforePaydayCents).toBe(20000)
    expect(body.paidThisMonthCents).toBe(9000)
  })

  it('writes nothing', async () => {
    await seedAccounts()
    await connection('bills').insert(
      bill(1, 'personal', 'Invented gym', 'weekly', 1500, '2026-10-07'),
    )
    const before = await snapshotTables()

    expect((await getBills('all')).status).toBe(200)
    expect(await snapshotTables()).toStrictEqual(before)
  })

  describe('scopes', () => {
    const PERSONAL = 'Personal sentinel 5e1a'
    const STRAWB = 'Strawb sentinel 7c2b'

    beforeEach(async () => {
      await seedAccounts()
      await connection('bills').insert([
        bill(1, 'personal', PERSONAL, 'none', 1100, '2026-10-30', {
          account_id: ACCOUNT.everyday,
        }),
        bill(2, 'strawb', STRAWB, 'none', 2200, '2026-10-31', {
          account_id: ACCOUNT.trading,
        }),
        bill(3, 'personal', 'Invented paid', 'none', 30, '2026-10-01'),
        bill(4, 'strawb', 'Invented paid too', 'none', 40, '2026-10-01'),
      ])
      await connection('bill_payments').insert([
        {
          bill_id: 3,
          due_date: '2026-10-01',
          amount_cents: 30,
          paid_at: STAMP,
        },
        {
          bill_id: 4,
          due_date: '2026-10-01',
          amount_cents: 40,
          paid_at: STAMP,
        },
      ])
    })

    it.each([
      ['personal', PERSONAL, STRAWB, ['1', '3'], 1100, 30],
      ['strawb', STRAWB, PERSONAL, ['2', '4'], 2200, 40],
    ])(
      '%s shows only its own bills and figures',
      async (scope, own, other, ids, due, paid) => {
        const res = await getBills(scope)

        expect(res.status).toBe(200)
        expect(res.text).not.toContain(other)
        expect(res.text).toContain(own)
        const body: BillsResponse = res.body
        expect(body.items.map((i) => i.id)).toEqual(ids)
        expect(body.items.every((i) => i.scope === scope)).toBe(true)
        expect(body.nextBill?.name).toBe(own)
        expect(body.dueBeforePaydayCents).toBe(due)
        expect(body.paidThisMonthCents).toBe(paid)
      },
    )

    it('all shows both', async () => {
      const body: BillsResponse = (await getBills('all')).body

      expect(body.items.map((i) => i.id)).toEqual(['1', '2', '3', '4'])
      expect(body.dueBeforePaydayCents).toBe(3300)
      expect(body.paidThisMonthCents).toBe(70)
      expect(body.nextBill?.name).toBe(PERSONAL)
    })

    it.each(['all', 'personal', 'strawb'])(
      'scope=%s carries no account number, Akahu id or connection name',
      async (scope) => {
        const res = await getBills(scope)

        for (const token of SECRET_TOKENS) {
          expect(res.text).not.toContain(token)
        }
      },
    )
  })

  it('answers a stored bill that is not valid with its fixed text, logging only the class', async () => {
    await connection('bills').insert(
      bill(1, 'personal', 'Invented gym', 'weekly', 1500, '2026-10-21'),
    )
    await connection('bill_payments').insert({
      bill_id: 1,
      due_date: '2026-10-21',
      amount_cents: 1500,
      paid_at: 'sentinel-not-a-time',
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getBills('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a stored bill is not valid' })
    expect(logged.mock.calls).toStrictEqual([
      ['bills: could not list bills', 'BillsDataError'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Only this site may write
// ---------------------------------------------------------------------------

describe('only this site may write (as POST /api/v1/sync/run)', () => {
  const WRITES: [string, () => ReturnType<typeof pay>][] = [
    ['POST /', () => postBill(VALID)],
    ['PATCH /1', () => patchBill(1, { name: 'Renamed' })],
    ['DELETE /1', () => deleteBill(1)],
    ['POST /1/payments', () => pay(1)],
  ]
  const REFUSED: [string, Record<string, string>][] = [
    ['Sec-Fetch-Site cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['a foreign Origin', { Origin: 'http://evil.example' }],
    ['Origin null', { Origin: 'null' }],
  ]

  describe.each(WRITES)('%s', (_write, send) => {
    it.each(REFUSED)('refuses %s, writing nothing', async (_why, headers) => {
      await connection('bills').insert(
        bill(1, 'personal', 'Invented gym', 'weekly', 1500, '2026-10-21'),
      )
      const before = await snapshotTables()

      const res = await send().set(headers)

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
      expect(await snapshotTables()).toStrictEqual(before)
    })
  })

  it.each([
    ['Sec-Fetch-Site same-origin', { 'Sec-Fetch-Site': 'same-origin' }],
    ['Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
    ['no headers (curl)', {}],
  ])('%s passes every write', async (_why, headers) => {
    const made = await postBill(VALID).set(headers)
    expect(made.status).toBe(201)
    const id = made.body.id
    expect((await patchBill(id, { name: 'Renamed' }).set(headers)).status).toBe(
      200,
    )
    expect((await pay(id).set(headers)).status).toBe(201)
    const spare = await postBill(VALID).set(headers)
    expect((await deleteBill(spare.body.id).set(headers)).status).toBe(204)
  })
})

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe('POST /api/v1/bills', () => {
  it('creates the bill and answers 201 with it', async () => {
    await seedAccounts()

    const res = await postBill({
      ...VALID,
      name: '  Invented power  ',
      accountId: String(ACCOUNT.everyday),
    })

    expect(res.status).toBe(201)
    expect(sortedKeys(res.body)).toStrictEqual([...BILL_KEYS].sort())
    const rows = await connection('bills').select()
    expect(rows).toHaveLength(1)
    expect(res.body).toStrictEqual({
      id: String(rows[0].id),
      scope: 'personal',
      name: 'Invented power',
      amountCents: 4500,
      dueDate: '2026-11-02',
      repeat: 'monthly',
      firstDueDate: '2026-11-02',
      paid: false,
      paidAt: null,
      accountName: 'Everyday',
    })
    expect(rows[0]).toMatchObject({
      name: 'Invented power',
      amount_cents: 4500,
      account_id: ACCOUNT.everyday,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    })
    expect(Number.isSafeInteger(rows[0].amount_cents)).toBe(true)
    expect(typeof rows[0].account_id).toBe('number')
  })

  const SENTINEL = 'zz-sentinel-81fd'

  it.each([
    ['a non-object body', [], 'Body must be a JSON object'],
    ['an unknown field', { ...VALID, id: '5' }, 'Unknown field in body'],
    [
      'no scope',
      { ...VALID, scope: undefined },
      'scope must be personal or strawb',
    ],
    [
      'a bad scope',
      { ...VALID, scope: SENTINEL },
      'scope must be personal or strawb',
    ],
    [
      'a blank name',
      { ...VALID, name: '   ' },
      'name must be 1 to 255 characters',
    ],
    [
      'string cents',
      { ...VALID, amountCents: '4500' },
      'amountCents must be a whole number of cents from 1 to 1000000000',
    ],
    [
      'float cents',
      { ...VALID, amountCents: 45.5 },
      'amountCents must be a whole number of cents from 1 to 1000000000',
    ],
    [
      'an impossible date',
      { ...VALID, firstDueDate: '2026-02-30' },
      'firstDueDate must be a YYYY-MM-DD date from 2000-01-01 to 2099-12-31',
    ],
    [
      'a bad repeat',
      { ...VALID, repeat: SENTINEL },
      'repeat must be none, weekly, monthly or yearly',
    ],
    [
      'a numeric accountId',
      { ...VALID, accountId: ACCOUNT.everyday },
      'accountId must be an account id as a string, or null',
    ],
    [
      'an account that does not exist',
      { ...VALID, accountId: '999' },
      'accountId does not match an account',
    ],
    [
      'a Xero account',
      { ...VALID, scope: 'strawb', accountId: String(ACCOUNT.xero) },
      'accountId does not match an account',
    ],
    [
      'an account in the other scope',
      { ...VALID, accountId: String(ACCOUNT.trading) },
      'accountId must be an account in the same scope as the bill',
    ],
    [
      'a schedule with 1001 unpaid occurrences',
      { ...VALID, repeat: 'weekly', firstDueDate: ANCHOR_1001 },
      'That schedule leaves too many unpaid occurrences',
    ],
  ])('refuses %s with 400, writing nothing', async (_why, body, error) => {
    await seedAccounts()
    const before = await snapshotTables()

    const res = await postBill(body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(res.text).not.toContain(SENTINEL)
    expect(await snapshotTables()).toStrictEqual(before)
  })
})

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const BAD_IDS = ['abc', '0', '01', '1e3', '-1', '9007199254740993']

describe('PATCH /api/v1/bills/:id', () => {
  it('edits the bill and answers it', async () => {
    const made = await created({})

    const res = await patchBill(made.id, {
      name: 'Renamed',
      amountCents: 5100,
      repeat: 'weekly',
    })

    expect(res.status).toBe(200)
    expect(sortedKeys(res.body)).toStrictEqual([...BILL_KEYS].sort())
    expect(res.body).toStrictEqual({
      ...made,
      name: 'Renamed',
      amountCents: 5100,
      repeat: 'weekly',
    })
  })

  it('answers {} with the bill unchanged, writing nothing', async () => {
    const made = await created({})
    const before = await snapshotTables()

    const res = await patchBill(made.id, {})

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual(made)
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it.each(BAD_IDS)('refuses id %s before reading the body', async (id) => {
    const res = await patchBill(id, [])

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })

  it('answers 404 for a bill that does not exist', async () => {
    const res = await patchBill(999, { name: 'Renamed' })

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Bill not found' })
  })

  it('refuses a bad body with 400 before looking for the bill', async () => {
    const res = await patchBill(999, { amountCents: 0 })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'amountCents must be a whole number of cents from 1 to 1000000000',
    })
  })

  it.each([
    ['firstDueDate', { firstDueDate: '2026-11-03' }],
    ['repeat', { repeat: 'yearly' }],
  ])(
    'refuses a new %s on a bill with payments with 409, writing nothing',
    async (_field, change) => {
      const made = await created({})
      expect((await pay(made.id)).status).toBe(201)
      const before = await snapshotTables()

      const res = await patchBill(made.id, { ...change, name: 'Renamed' })

      expect(res.status).toBe(409)
      expect(res.body).toStrictEqual({
        error:
          'Bill has payments, so its first due date and repeat cannot be changed',
      })
      expect(await snapshotTables()).toStrictEqual(before)
    },
  )

  it('refuses an account in the other scope, and moving a bill away from its account', async () => {
    await seedAccounts()
    const made = await created({ accountId: String(ACCOUNT.everyday) })
    const before = await snapshotTables()
    const error = 'accountId must be an account in the same scope as the bill'

    const res = await patchBill(made.id, { accountId: String(ACCOUNT.trading) })
    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })

    const moved = await patchBill(made.id, { scope: 'strawb' })
    expect(moved.status).toBe(400)
    expect(moved.body).toStrictEqual({ error })
    expect(await snapshotTables()).toStrictEqual(before)

    const both = await patchBill(made.id, {
      scope: 'strawb',
      accountId: String(ACCOUNT.trading),
    })
    expect(both.status).toBe(200)
    expect(both.body).toMatchObject({ scope: 'strawb', accountName: 'Trading' })
  })

  it('refuses a new schedule with too many unpaid occurrences', async () => {
    const made = await created({ repeat: 'weekly' })

    const res = await patchBill(made.id, { firstDueDate: ANCHOR_1001 })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'That schedule leaves too many unpaid occurrences',
    })
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/bills/:id', () => {
  it('deletes a bill with no payments: 204 with no body', async () => {
    const made = await created({})

    const res = await deleteBill(made.id)

    expect(res.status).toBe(204)
    expect(res.text).toBe('')
    expect(await connection('bills').select()).toStrictEqual([])
  })

  it('refuses a bill with payments with 409, leaving it and them', async () => {
    const made = await created({})
    expect((await pay(made.id)).status).toBe(201)
    const before = await snapshotTables()

    const res = await deleteBill(made.id)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'Bill has payments, so it cannot be deleted',
    })
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it('answers 404 for a bill that does not exist', async () => {
    const res = await deleteBill(999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Bill not found' })
  })

  it.each(BAD_IDS)('refuses id %s', async (id) => {
    const res = await deleteBill(id)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })
})

// ---------------------------------------------------------------------------
// Mark paid
// ---------------------------------------------------------------------------

describe('POST /api/v1/bills/:id/payments', () => {
  it('pays a late weekly bill’s earliest occurrence and answers the bill moved on', async () => {
    const made = await created({
      repeat: 'weekly',
      firstDueDate: '2026-10-14',
      amountCents: 2000,
    })

    const res = await pay(made.id)

    expect(res.status).toBe(201)
    expect(sortedKeys(res.body)).toStrictEqual(['bill'])
    expect(sortedKeys(res.body.bill)).toStrictEqual([...BILL_KEYS].sort())
    expect(res.body.bill).toStrictEqual({ ...made, dueDate: '2026-10-21' })
    expect(await payments()).toStrictEqual([
      {
        id: expect.any(Number),
        bill_id: Number(made.id),
        due_date: '2026-10-14',
        amount_cents: 2000,
        paid_at: NOW_ISO,
      },
    ])
  })

  it('pays a one-off once, counting it as paid this month', async () => {
    const made = await created({
      repeat: 'none',
      firstDueDate: '2026-10-30',
      amountCents: 6400,
    })
    const before: BillsResponse = (await getBills('all')).body

    const res = await pay(made.id)

    expect(res.status).toBe(201)
    expect(res.body.bill).toStrictEqual({
      ...made,
      paid: true,
      paidAt: NOW_ISO,
    })
    const after: BillsResponse = (await getBills('all')).body
    expect(after.paidThisMonthCents - before.paidThisMonthCents).toBe(6400)
    expect(after.nextBill).toBeNull()

    const tables = await snapshotTables()
    const again = await pay(made.id)
    expect(again.status).toBe(409)
    expect(again.body).toStrictEqual({ error: 'This bill is already paid' })
    expect(await snapshotTables()).toStrictEqual(tables)
  })

  it('keeps paying successive weeks past the next payday', async () => {
    const made = await created({ repeat: 'weekly', firstDueDate: '2026-10-28' })

    const dues: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await pay(made.id)
      expect(res.status).toBe(201)
      dues.push(res.body.bill.dueDate)
    }

    expect(dues).toEqual([
      '2026-11-04',
      '2026-11-11',
      '2026-11-18',
      '2026-11-25',
    ])
  })

  it('refuses the press after 2099-12-31 with 409, writing nothing; the list still answers', async () => {
    const made = await created({ repeat: 'yearly', firstDueDate: '2099-06-15' })
    expect((await pay(made.id)).status).toBe(201)
    const before = await snapshotTables()

    const res = await pay(made.id)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'This bill is paid up to the last date Divvy tracks',
    })
    expect(await snapshotTables()).toStrictEqual(before)
    const list = await getBills('all')
    expect(list.status).toBe(200)
    expect(list.body.items[0].dueDate).toBe('2100-06-15')
  })

  it('a yearly bill prepaid every year to 2099 still lists, and the overview still answers', async () => {
    await seedAccounts()
    const made = await created({ repeat: 'yearly', firstDueDate: '2026-12-01' })

    // Every year to 2097 stored directly, to keep the test fast; the last
    // two presses go through the route.
    await connection('bill_payments').insert(
      Array.from({ length: 2097 - 2026 + 1 }, (_, i) => ({
        bill_id: Number(made.id),
        due_date: `${2026 + i}-12-01`,
        amount_cents: made.amountCents,
        paid_at: STAMP,
      })),
    )
    const presses = [await pay(made.id), await pay(made.id)]
    expect(presses.map((r) => r.body.bill.dueDate)).toEqual([
      '2099-12-01',
      '2100-12-01',
    ])
    expect((await pay(made.id)).status).toBe(409)

    const list = await getBills('all')
    expect(list.status).toBe(200)
    expect(list.body.items[0].dueDate).toBe('2100-12-01')
    expect((await getOverview('all')).status).toBe(200)
  })

  it('answers 404 for a bill that does not exist', async () => {
    const res = await pay(999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Bill not found' })
  })

  it.each(BAD_IDS)('refuses id %s', async (id) => {
    const res = await pay(id)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })

  it.each([
    ['a body with a field', { dueDate: '2026-10-21' }, 'Unknown field in body'],
    ['an array body', [], 'Body must be a JSON object'],
  ])('refuses %s, writing nothing', async (_why, body, error) => {
    const made = await created({})

    const res = await api.post(`/api/v1/bills/${made.id}/payments`).send(body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(await payments()).toStrictEqual([])
  })

  it('takes {} as the body', async () => {
    const made = await created({})

    const res = await api.post(`/api/v1/bills/${made.id}/payments`).send({})

    expect(res.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// The overview agrees
// ---------------------------------------------------------------------------

describe('the bills figure and the overview hero agree', () => {
  async function figures(scope: string) {
    const bills = await getBills(scope)
    const overview = await getOverview(scope)
    expect(bills.status).toBe(200)
    expect(overview.status).toBe(200)
    return {
      bills: bills.body as BillsResponse,
      overview: overview.body as OverviewResponse,
    }
  }

  async function expectIdentity() {
    for (const scope of ['all', 'personal', 'strawb']) {
      const { bills, overview } = await figures(scope)
      const s = overview.safeToSpend
      expect(bills.dueBeforePaydayCents, scope).toBe(
        s.unpaidBillsCents + s.strawbBillsBufferCents,
      )
    }
  }

  const ids = { rent: '', internet: '', hosting: '', rego: '' }

  beforeEach(async () => {
    await seedAccounts()
    ids.rent = (
      await created({
        name: 'Invented rent',
        repeat: 'weekly',
        firstDueDate: '2026-10-21',
        amountCents: 20000,
      })
    ).id
    // Monthly on the 31st: 10-31, then 11-30.
    ids.internet = (
      await created({
        name: 'Invented internet',
        repeat: 'monthly',
        firstDueDate: '2026-10-31',
        amountCents: 8000,
      })
    ).id
    ids.hosting = (
      await created({
        scope: 'strawb',
        name: 'Invented hosting',
        repeat: 'monthly',
        firstDueDate: '2026-10-30',
        amountCents: 12000,
      })
    ).id
    ids.rego = (
      await created({
        name: 'Invented rego',
        repeat: 'none',
        firstDueDate: '2026-11-02',
        amountCents: 15000,
      })
    ).id
  })

  it('with no Strawb tax pot, and with one smaller than Strawb’s bills', async () => {
    await expectIdentity()
    expect(
      (await figures('strawb')).overview.safeToSpend.strawbBillsBufferCents,
    ).toBe(0)

    await connection('account_settings').insert({
      account_id: ACCOUNT.strawbPot,
      role: 'tax_pot',
      updated_at: STAMP,
    })

    await expectIdentity()
    expect(
      (await figures('strawb')).overview.safeToSpend.strawbBillsBufferCents,
    ).toBe(5000)
  })

  it('marking a personal bill paid moves the hero and the bills figure by its amount', async () => {
    const alertId = `bill_due_soon:${ids.internet}:2026-10-31`
    const before = await figures('personal')
    expect(before.overview.alerts.map((a) => a.id)).toContain(alertId)

    const res = await pay(ids.internet)
    expect(res.status).toBe(201)
    expect(res.body.bill.dueDate).toBe('2026-11-30')

    const after = await figures('personal')
    const s0 = before.overview.safeToSpend
    const s1 = after.overview.safeToSpend
    expect(s0.unpaidBillsCents - s1.unpaidBillsCents).toBe(8000)
    expect(s1.safeCents - s0.safeCents).toBe(8000)
    expect(after.overview.alerts.map((a) => a.id)).not.toContain(alertId)
    expect(
      before.bills.dueBeforePaydayCents - after.bills.dueBeforePaydayCents,
    ).toBe(8000)
    await expectIdentity()
  })

  it('marking a Strawb bill paid with the pot in play keeps them agreeing', async () => {
    await connection('account_settings').insert({
      account_id: ACCOUNT.strawbPot,
      role: 'tax_pot',
      updated_at: STAMP,
    })
    const before = await figures('strawb')

    expect((await pay(ids.hosting)).status).toBe(201)

    const after = await figures('strawb')
    expect(
      before.bills.dueBeforePaydayCents - after.bills.dueBeforePaydayCents,
    ).toBe(12000)
    expect(after.overview.safeToSpend.strawbBillsBufferCents).toBe(0)
    await expectIdentity()
  })

  it('paying a bill ahead of the next payday leaves the overview as it was', async () => {
    // Pay the internet bill's 10-31; its next occurrence, 11-30, is after
    // the next payday.
    expect((await pay(ids.internet)).status).toBe(201)
    const before = await figures('all')

    const res = await pay(ids.internet)
    expect(res.status).toBe(201)
    expect(res.body.bill.dueDate).toBe('2026-12-31')

    const after = await figures('all')
    expect(after.overview).toStrictEqual(before.overview)
    expect(after.bills.dueBeforePaydayCents).toBe(
      before.bills.dueBeforePaydayCents,
    )
  })
})

describe('the 1000-occurrence limit is the overview’s', () => {
  it('a bill created at 1000 still lets the overview answer; 1001 is refused; stored anyway, the overview fails', async () => {
    await seedAccounts()

    const at1000 = await postBill({
      ...VALID,
      repeat: 'weekly',
      firstDueDate: ANCHOR_1000,
    })
    expect(at1000.status).toBe(201)
    expect((await getOverview('all')).status).toBe(200)

    const at1001 = await postBill({
      ...VALID,
      repeat: 'weekly',
      firstDueDate: ANCHOR_1001,
    })
    expect(at1001.status).toBe(400)

    await connection('bills').insert(
      bill(99, 'personal', 'Invented legacy', 'weekly', 100, ANCHOR_1001),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overview = await getOverview('all')
    expect(overview.status).toBe(500)
    expect(overview.body).toStrictEqual({
      error: 'a bill has too many unpaid occurrences',
    })
    // The list has no such limit on read.
    expect((await getBills('all')).status).toBe(200)
  })
})

describe('a stored payday that is not valid', () => {
  it('fails the overview but the list reads it as the default', async () => {
    await seedAccounts()
    await connection('settings').insert(setting('payday_weekday', 'x'))
    await created({ repeat: 'none', firstDueDate: '2026-11-03' })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const overview = await getOverview('all')
    expect(overview.status).toBe(500)
    expect(overview.body).toStrictEqual({
      error: 'a stored setting is not valid',
    })

    const list = await getBills('all')
    expect(list.status).toBe(200)
    expect(list.body.dueBeforePaydayCents).toBe(4500)
  })
})

describe('paths this router does not serve', () => {
  it.each([
    ['GET /1', () => api.get('/api/v1/bills/1')],
    ['PUT /1', () => api.put('/api/v1/bills/1').send(VALID)],
    ['GET /1/payments', () => api.get('/api/v1/bills/1/payments')],
  ])('%s is the app’s JSON 404', async (_why, send) => {
    await connection('bills').insert(
      bill(1, 'personal', 'Invented gym', 'weekly', 1500, '2026-10-21'),
    )

    const res = await send()

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })
})

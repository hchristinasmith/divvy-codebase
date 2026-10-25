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
  HabitStreak,
  HabitsResponse,
  VerdictRow,
} from '../../../shared/contracts.ts'
import type { HabitVerdictRow } from '../../db/habits.ts'

// /api/v1/habits (prd-02, issue #52): runway, streaks and verdicts over
// HTTP against the real app and a fresh in-memory database. The clock is
// fixed at 23:30 UTC on 27 October 2026, which is 12:30 NZDT on the 28th,
// so today in NZ is 2026-10-28. Stored instants are midnight UTC, so each
// row's NZ date is its UTC date. Every value below is invented.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

const NOW_ISO = '2026-10-27T23:30:00.000Z'
const LATER_ISO = '2026-10-27T23:45:00.000Z'

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

const STAMP = '2026-08-01T00:00:00.000Z'

type Row = Record<string, unknown>

// A copy of the account/transaction builders in ./subscriptions.test.ts.
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
  id: number,
  accountId: string,
  day: string,
  amountCents: number,
  balanceCents: number | null,
  fields: Row = {},
): Row {
  return {
    id,
    account_id: accountId,
    date: `${day}T00:00:00.000Z`,
    amount_cents: amountCents,
    balance_cents: balanceCents,
    description: 'EXAMPLE SHOP 4821',
    merchant_name: 'Example Shop',
    status: 'settled',
    source: 'akahu',
    category: 'Shopping',
    category_source: 'akahu',
    ...fields,
  }
}

const EVERYDAY = 'acc_sentinel_everyday'
const TRADING = 'acc_sentinel_trading'

async function insertAll(table: string, rows: Row[]) {
  // One insert per row: a multi-row insert binds NULL for a key a row
  // leaves out, which would skip the column defaults.
  for (const row of rows) await connection(table).insert(row)
}

async function seedAccounts() {
  await insertAll('accounts', [
    account({
      id: 1,
      akahu_id: EVERYDAY,
      name: 'Sentinel Everyday',
      scope: 'personal',
      balance_cents: 1_000_000,
    }),
    account({
      id: 2,
      akahu_id: TRADING,
      name: 'Sentinel Trading',
      scope: 'strawb',
      balance_cents: 500_000,
    }),
  ])
  await connection('account_settings').insert([
    { account_id: 1, role: 'current', updated_at: STAMP },
    { account_id: 2, role: 'current', updated_at: STAMP },
  ])
}

// Personal: history from 2026-09-01, a grocery spend, a pending spend, a
// refund-like inflow.
const PERSONAL_ROWS = [
  tx(102, EVERYDAY, '2026-09-01', 5_000, 900_000),
  tx(101, EVERYDAY, '2026-10-20', -128_000, 872_000, {
    merchant_name: 'Example Grocer',
    description: 'EXAMPLE GROCER 0042',
    category: 'Groceries',
  }),
  tx(103, EVERYDAY, '2026-10-28', -500, null, { status: 'pending' }),
]

// Strawb: history from 2026-09-01, one supplier spend.
const STRAWB_ROWS = [
  tx(202, TRADING, '2026-09-01', 1_000, 500_000),
  tx(201, TRADING, '2026-10-21', -64_000, 436_000, {
    merchant_name: null,
    description: 'EXAMPLE SUPPLIER',
    category: null,
  }),
]

// Strawb → Personal on the same day: not spend in All, Strawb's spend in
// Strawb, an inflow (never spend) in Personal.
const TRANSFER_ROWS = [
  tx(203, TRADING, '2026-10-22', -40_000, 396_000),
  tx(104, EVERYDAY, '2026-10-22', 40_000, 912_000),
]

// Never read: a Xero row on a stored account's id, and an Akahu row on an
// account that is not stored.
const UNREADABLE_ROWS = [
  tx(900, EVERYDAY, '2026-10-25', -9_999, null, { source: 'xero' }),
  tx(901, 'acc_sentinel_unmapped', '2026-10-25', -8_888, 100),
]

async function seed() {
  await seedAccounts()
  await insertAll('transactions', [
    ...PERSONAL_ROWS,
    ...STRAWB_ROWS,
    ...TRANSFER_ROWS,
    ...UNREADABLE_ROWS,
  ])
}

const get = (scope: string) => api.get(`/api/v1/habits?scope=${scope}`)
const put = (id: string | number, body: unknown) =>
  api.put(`/api/v1/habits/verdicts/${id}`).send(body as object)
const verdictRows = (): Promise<HabitVerdictRow[]> =>
  connection('habit_verdicts').orderBy('id')

const RESPONSE_KEYS: Record<keyof HabitsResponse, true> = {
  runwayTenths: true,
  streaks: true,
  verdicts: true,
}
const STREAK_KEYS: Record<keyof HabitStreak, true> = {
  key: true,
  label: true,
  days: true,
}
const VERDICT_KEYS: Record<keyof VerdictRow, true> = {
  transactionId: true,
  date: true,
  merchant: true,
  category: true,
  amountCents: true,
  verdict: true,
}
const STORED_KEYS: Record<keyof HabitVerdictRow, true> = {
  id: true,
  transaction_id: true,
  verdict: true,
  created_at: true,
  updated_at: true,
}
const keys = (o: object) => Object.keys(o).sort()

/** Every key at any depth of a JSON value. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)])
  }
  return []
}

const GROCER: VerdictRow = {
  transactionId: '101',
  date: '2026-10-20',
  merchant: 'Example Grocer',
  category: 'Groceries',
  amountCents: -128_000,
  verdict: null,
}
const SUPPLIER: VerdictRow = {
  transactionId: '201',
  date: '2026-10-21',
  // No merchant name: the description.
  merchant: 'EXAMPLE SUPPLIER',
  category: null,
  amountCents: -64_000,
  verdict: null,
}
const DRAWING: VerdictRow = {
  transactionId: '203',
  date: '2026-10-22',
  merchant: 'Example Shop',
  category: 'Shopping',
  amountCents: -40_000,
  verdict: null,
}
// 2026-09-01 to 2026-10-28, both counted: 30 days of September + 28.
const STREAK_58: HabitStreak = {
  key: 'no_overdraft',
  label: 'No overdraft',
  days: 58,
}

describe('GET: the response is the contract', () => {
  it('all: hand-worked runway, the streak and both scopes’ spending', async () => {
    await seed()

    const res = await get('all')

    expect(res.status).toBe(200)
    expect(keys(res.body)).toEqual(keys(RESPONSE_KEYS))
    for (const s of res.body.streaks) expect(keys(s)).toEqual(keys(STREAK_KEYS))
    for (const v of res.body.verdicts)
      expect(keys(v)).toEqual(keys(VERDICT_KEYS))
    expect(res.body).toStrictEqual({
      // assets 1,000,000 + 500,000; spend 128,000 + 500 + 64,000 = 192,500
      // (the transfer is not spend); 15,000,000 ÷ 192,500 = 77.9 → 77.
      runwayTenths: 77,
      streaks: [STREAK_58],
      // Newest first; the transfer, the pending row, inflows, the Xero row
      // and the unmapped row are not listed.
      verdicts: [SUPPLIER, GROCER],
    })
  })

  it('personal: its own runway and spending only', async () => {
    await seed()

    const res = await get('personal')

    expect(res.body).toStrictEqual({
      // 10,000,000 ÷ (128,000 + 500) = 77.8 → 77.
      runwayTenths: 77,
      streaks: [STREAK_58],
      verdicts: [GROCER],
    })
  })

  it('strawb: the drawing to Personal is Strawb’s spend', async () => {
    await seed()

    const res = await get('strawb')

    expect(res.body).toStrictEqual({
      // 5,000,000 ÷ (64,000 + 40,000) = 48.07 → 48.
      runwayTenths: 48,
      streaks: [STREAK_58],
      verdicts: [DRAWING, SUPPLIER],
    })
  })

  it('carries no freedom date at any depth', async () => {
    await seed()

    for (const scope of ['all', 'personal', 'strawb']) {
      const res = await get(scope)
      expect(allKeys(res.body).filter((k) => /freedom/i.test(k))).toEqual([])
    }
  })

  it('an empty database: runway 0, no streak, no verdicts', async () => {
    const res = await get('all')

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      runwayTenths: 0,
      streaks: [],
      verdicts: [],
    })
  })

  it.each(['', 'both', 'ALL'])('scope=%j is a 400', async (scope) => {
    const res = await get(scope)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
  })

  it('no scope is a 400', async () => {
    const res = await api.get('/api/v1/habits')

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
  })

  it('an Akahu row with no date is a fixed-text 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedAccounts()
    await insertAll('transactions', [
      { ...tx(101, EVERYDAY, '2026-10-20', -100, 100), date: null },
    ])

    const res = await get('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
  })
})

describe('NZ calendar dates from stored UTC instants', () => {
  it('a row is dated by its NZ day, not its UTC day', async () => {
    await seedAccounts()
    // 11:30 UTC on the 21st is 00:30 NZDT on the 22nd.
    await insertAll('transactions', [
      {
        ...tx(105, EVERYDAY, '2026-10-21', -2_500, 997_500),
        date: '2026-10-21T11:30:00.000Z',
      },
    ])

    const res = await get('personal')

    expect(res.body.verdicts).toStrictEqual([
      { ...DRAWING, transactionId: '105', amountCents: -2_500 },
    ])
  })

  it('the read reaches a leg whose UTC day is before the window’s first NZ day', async () => {
    await seedAccounts()
    await connection('accounts').insert(
      account({
        id: 3,
        akahu_id: 'acc_sentinel_saver',
        name: 'Sentinel Saver',
        scope: 'personal',
        balance_cents: 0,
      }),
    )
    await connection('account_settings').insert({
      account_id: 3,
      role: 'savings',
      updated_at: STAMP,
    })
    // The outflow is on 2026-07-31, the verdict window's first day, so it is
    // listed on its own.
    await insertAll('transactions', [
      tx(106, EVERYDAY, '2026-07-31', -3_300, 996_700),
    ])
    expect(
      (await get('personal')).body.verdicts.map(
        (v: VerdictRow) => v.transactionId,
      ),
    ).toEqual(['106'])

    // Its inflow is on 2026-07-29 in NZ (00:30 NZST), the first day read,
    // which is 2026-07-28 in UTC. Read, it pairs and the outflow drops out.
    await insertAll('transactions', [
      {
        ...tx(301, 'acc_sentinel_saver', '2026-07-28', 3_300, 3_300),
        date: '2026-07-28T12:30:00.000Z',
      },
    ])
    expect((await get('personal')).body.verdicts).toStrictEqual([])
  })
})

describe('scope isolation', () => {
  it('Strawb spend, verdicts and transfers neither appear in nor move Personal', async () => {
    await seedAccounts()
    await insertAll('transactions', PERSONAL_ROWS)
    const before = (await get('personal')).body

    await insertAll('transactions', [...STRAWB_ROWS, ...TRANSFER_ROWS])
    expect((await put(201, { verdict: 'not_really' })).status).toBe(200)

    expect((await get('personal')).body).toStrictEqual(before)
  })

  it('Personal spend, verdicts and transfers neither appear in nor move Strawb', async () => {
    await seedAccounts()
    await insertAll('transactions', STRAWB_ROWS)
    const before = (await get('strawb')).body

    // Personal → Strawb, the reverse of TRANSFER_ROWS.
    await insertAll('transactions', [
      ...PERSONAL_ROWS,
      tx(105, EVERYDAY, '2026-10-22', -40_000, 832_000),
      tx(204, TRADING, '2026-10-22', 40_000, 476_000),
    ])
    expect((await put(101, { verdict: 'worth_it' })).status).toBe(200)

    expect((await get('strawb')).body).toStrictEqual(before)
  })
})

describe('PUT /verdicts/:transactionId', () => {
  it('sets a verdict: the VerdictRow back, one stored row, ISO-Z stamps', async () => {
    await seed()

    const res = await put(101, { verdict: 'worth_it' })

    expect(res.status).toBe(200)
    expect(keys(res.body)).toEqual(keys(VERDICT_KEYS))
    expect(res.body).toStrictEqual({ ...GROCER, verdict: 'worth_it' })
    const rows = await verdictRows()
    expect(rows).toHaveLength(1)
    expect(keys(rows[0])).toEqual(keys(STORED_KEYS))
    expect(rows[0]).toStrictEqual({
      id: rows[0].id,
      transaction_id: 101,
      verdict: 'worth_it',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    })
  })

  it('persists across two reads', async () => {
    await seed()
    await put(101, { verdict: 'not_really' })

    for (let i = 0; i < 2; i++) {
      const res = await get('personal')
      expect(res.body.verdicts).toStrictEqual([
        { ...GROCER, verdict: 'not_really' },
      ])
    }
  })

  it('changing keeps one row and its created_at', async () => {
    await seed()
    await put(101, { verdict: 'worth_it' })
    vi.setSystemTime(LATER_ISO)

    const res = await put(101, { verdict: 'not_really' })

    expect(res.status).toBe(200)
    expect(res.body.verdict).toBe('not_really')
    const rows = await verdictRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('not_really')
    expect(rows[0].created_at).toBe(NOW_ISO)
    expect(rows[0].updated_at).toBe(LATER_ISO)
  })

  it('null clears it: the row is deleted', async () => {
    await seed()
    await put(101, { verdict: 'worth_it' })

    const res = await put(101, { verdict: null })

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual(GROCER)
    expect(await verdictRows()).toHaveLength(0)
    expect((await get('personal')).body.verdicts).toStrictEqual([GROCER])
  })

  it('null with no verdict is a 200 with null, writing nothing', async () => {
    await seed()

    const res = await put(101, { verdict: null })

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual(GROCER)
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a pending row is a 409 and writes nothing', async () => {
    await seed()

    const res = await put(103, { verdict: 'worth_it' })

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'Transaction is still pending; it can be tagged once it settles',
    })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a pending row is never listed', async () => {
    await seed()

    const res = await get('all')

    expect(
      res.body.verdicts.map((v: VerdictRow) => v.transactionId),
    ).not.toContain('103')
  })

  it.each([
    ['a missing row', 999],
    ['a Xero row', 900],
    ['a row on an account that is not stored', 901],
  ])('%s is a 404 and writes nothing', async (_name, id) => {
    await seed()

    const res = await put(id, { verdict: 'worth_it' })

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Transaction not found' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a stored verdict on an unmapped row is never listed', async () => {
    await seed()
    await connection('habit_verdicts').insert({
      transaction_id: 901,
      verdict: 'worth_it',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    })

    const res = await get('all')

    expect(
      res.body.verdicts.map((v: VerdictRow) => v.transactionId),
    ).not.toContain('901')
  })

  it('money in is a 400 and writes nothing', async () => {
    await seed()

    const res = await put(102, { verdict: 'worth_it' })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Only spending can be tagged' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it.each(['abc', '0', '01', '1e3', '-1', '1234567890123456'])(
    'id %j is a 400',
    async (id) => {
      await seed()

      const res = await put(id, { verdict: 'worth_it' })

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({
        error: 'transactionId must be a positive integer',
      })
    },
  )

  it.each([
    ['a missing verdict', {}],
    ['an unknown verdict', { verdict: 'meh' }],
    ['a verdict that is not text', { verdict: 1 }],
  ])('%s is a 400', async (_name, body) => {
    await seed()

    const res = await put(101, body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'verdict must be worth_it, not_really or null',
    })
    expect(await verdictRows()).toHaveLength(0)
  })

  it.each([
    ['an extra key', { verdict: 'worth_it', scope: 'personal' }],
    ['an array', ['worth_it']],
  ])('%s is a 400', async (_name, body) => {
    await seed()

    const res = await put(101, body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Invalid body' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a cross-site request is a 403 and writes nothing', async () => {
    await seed()

    const res = await api
      .put('/api/v1/habits/verdicts/101')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ verdict: 'worth_it' })

    expect(res.status).toBe(403)
    expect(res.body).toStrictEqual({ error: 'Forbidden' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a foreign Origin is a 403 and writes nothing', async () => {
    await seed()

    const res = await api
      .put('/api/v1/habits/verdicts/101')
      .set('Origin', 'https://evil.example')
      .send({ verdict: 'worth_it' })

    expect(res.status).toBe(403)
    expect(res.body).toStrictEqual({ error: 'Forbidden' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a same-origin request passes the site check', async () => {
    await seed()

    const res = await api
      .put('/api/v1/habits/verdicts/101')
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ verdict: 'worth_it' })

    expect(res.status).toBe(200)
  })
})

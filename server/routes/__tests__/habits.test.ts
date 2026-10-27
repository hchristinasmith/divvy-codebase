import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { connect } from 'node:net'

import connection from '../../db/connection.ts'
import * as habitsDb from '../../db/habits.ts'
import * as matcher from '../../../shared/drawings.ts'
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

// The data module is the real one; its two entry points are wrapped only so
// a test can make one fail with an error that is not a HabitsDataError.
vi.mock('../../db/habits.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/habits.ts')>()
  return {
    ...real,
    readHabits: vi.fn(real.readHabits),
    setVerdict: vi.fn(real.setVerdict),
  }
})

// The real drawing matcher, behind a spy, so a test can make it throw
// through the real loader. As in ../../db/__tests__/overview.test.ts, the
// spy sits on shared/drawings.ts, not on server/db/drawings.ts, which
// overview.ts and it import from each other.
vi.mock('../../../shared/drawings.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../shared/drawings.ts')>()
  return { ...real, findDrawingIds: vi.fn(real.findDrawingIds) }
})

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
const SAVER = 'acc_sentinel_saver'

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

async function seedSaver() {
  await connection('accounts').insert(
    account({
      id: 3,
      akahu_id: SAVER,
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

// Strawb → Personal on the same day, the same amount: a drawing (prd-02
// Ruling 15), so both halves show Drawings and neither is spend in any
// scope.
const DRAWING_ROWS = [
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
    ...DRAWING_ROWS,
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
      // (the drawing is not spend); 15,000,000 ÷ 192,500 = 77.9 → 77.
      runwayTenths: 77,
      streaks: [STREAK_58],
      // Newest first; the drawing, the pending row, inflows, the Xero row
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

  it('strawb: the drawing to Personal is not Strawb’s spend (prd-02 Ruling 15)', async () => {
    await seed()

    const res = await get('strawb')

    expect(res.body).toStrictEqual({
      // 5,000,000 ÷ 64,000 = 78.125 → 78; the drawing's 40,000 is not
      // spend.
      runwayTenths: 78,
      streaks: [STREAK_58],
      verdicts: [SUPPLIER],
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

  // The pending row and the savings row are read only because a row with no
  // date is read whatever its status and account; the settled row on a
  // current account would also be read as overdraft history.
  it.each([
    ['settled, on a current account', EVERYDAY, 'settled'],
    ['pending, on a current account', EVERYDAY, 'pending'],
    ['settled, on a savings account', SAVER, 'settled'],
  ])(
    'an Akahu row with no date (%s) is a fixed-text 500',
    async (_name, akahuId, status) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await seedAccounts()
      await seedSaver()
      await insertAll('transactions', [
        { ...tx(101, akahuId, '2026-10-20', -100, null), status, date: null },
      ])

      const res = await get('all')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
    },
  )

  it('an Akahu row with no amount is a fixed-text 500, not 0', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    await insertAll('transactions', [
      { ...tx(105, EVERYDAY, '2026-10-23', 0, 900_000), amount_cents: null },
    ])

    const res = await get('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
  })

  it('an account with no balance is a fixed-text 500, not 0', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    await connection('accounts').insert(
      account({
        id: 3,
        akahu_id: SAVER,
        name: 'Sentinel Saver',
        scope: 'personal',
        balance_cents: null,
      }),
    )

    const res = await get('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'an account has no balance' })
    expect(log.mock.calls).toEqual([
      ['habits: could not read habits', 'HabitsDataError'],
    ])
  })

  // Integer affinity keeps a fractional value as REAL, so it reaches
  // shared/habits.ts, whose TypeError names the field; a balance whose ten
  // times is past the safe integers is its RangeError.
  it.each([
    ['a fractional transaction amount (TypeError)', 'transactions', -128_000.5],
    ['a fractional account balance (TypeError)', 'accounts', 1_000_000.5],
    ['a balance too large for runway (RangeError)', 'accounts', 1e15],
  ])(
    '%s is the fixed text from the shared checks',
    async (_name, table, value) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await seed()
      if (table === 'transactions') {
        await connection('transactions')
          .where({ id: 101 })
          .update({ amount_cents: value })
      } else {
        await connection('accounts')
          .where({ id: 1 })
          .update({ balance_cents: value })
      }

      const res = await get('all')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'habits input invalid' })
    },
  )

  it('a Personal card owing money lowers Personal runway and not Strawb’s', async () => {
    await seed()
    await connection('accounts').insert(
      account({
        id: 3,
        akahu_id: 'acc_sentinel_card',
        name: 'Sentinel Card',
        scope: 'personal',
        balance_cents: -357_000,
      }),
    )
    await connection('account_settings').insert({
      account_id: 3,
      role: 'credit_card',
      updated_at: STAMP,
    })

    // (1,000,000 − 357,000) × 10 ÷ 128,500 = 6,430,000 ÷ 128,500 = 50.04 → 50.
    expect((await get('personal')).body.runwayTenths).toBe(50)
    // Unchanged from the strawb test: 78.
    expect((await get('strawb')).body.runwayTenths).toBe(78)
    // (1,500,000 − 357,000) × 10 ÷ 192,500 = 11,430,000 ÷ 192,500 = 59.37… → 59.
    expect((await get('all')).body.runwayTenths).toBe(59)
  })

  it('an account with no role adds nothing to runway and is not a current account', async () => {
    await seed()
    // No account_settings row. Were it `current`, its balance would lift
    // runway and, with no settled row to count from, it would drop the
    // streak.
    await connection('accounts').insert(
      account({
        id: 3,
        akahu_id: SAVER,
        name: 'Sentinel Saver',
        scope: 'personal',
        balance_cents: 9_000_000,
      }),
    )

    const res = await get('personal')

    expect(res.body).toStrictEqual({
      // As without it: 10,000,000 ÷ 128,500 = 77.8 → 77.
      runwayTenths: 77,
      streaks: [STREAK_58],
      verdicts: [GROCER],
    })
  })
})

describe('overdraft history before the read window', () => {
  it('a settled row on a current account older than the window starts the streak', async () => {
    await seedAccounts()
    // habitsReadFrom(2026-10-28) is 2026-07-29; this row is before it.
    await insertAll('transactions', [
      tx(110, EVERYDAY, '2026-06-01', -1_000, 999_000),
      tx(102, EVERYDAY, '2026-09-01', 5_000, 900_000),
    ])

    const res = await get('personal')

    // 2026-06-01 to 2026-10-28, both counted: 30 + 31 + 31 + 30 + 28.
    expect(res.body.streaks).toStrictEqual([{ ...STREAK_58, days: 150 }])
    // Older than the verdict window, so not listed.
    expect(res.body.verdicts).toStrictEqual([])
  })

  it('an old row on a savings account is not read', async () => {
    await seed()
    await seedSaver()
    // Were it read, its missing amount would be a 500.
    await insertAll('transactions', [
      { ...tx(302, SAVER, '2026-06-01', 0, 100), amount_cents: null },
    ])

    const res = await get('personal')

    expect(res.status).toBe(200)
    expect(res.body.streaks).toStrictEqual([STREAK_58])
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
      {
        transactionId: '105',
        date: '2026-10-22',
        merchant: 'Example Shop',
        category: 'Shopping',
        amountCents: -2_500,
        verdict: null,
      },
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

describe('drawings are never spending (prd-02 Ruling 15)', () => {
  // Strawb pays Personal 40,000: out on 2026-10-21, in on 2026-10-24. Three
  // days apart is inside the drawing window (DRAWING_DAYS_AFTER) and outside
  // the transfer window (TRANSFER_WINDOW_DAYS), so only the drawing rule can
  // leave it out of All.
  const drawingRows = (outFields: Row = {}) => [
    tx(205, TRADING, '2026-10-21', -40_000, 396_000, {
      merchant_name: null,
      description: 'EXAMPLE DRAWING OUT',
      category: null,
      ...outFields,
    }),
    tx(106, EVERYDAY, '2026-10-24', 40_000, 912_000, {
      merchant_name: null,
      description: 'EXAMPLE DRAWING IN',
      category: 'Income',
    }),
  ]

  it('a Strawb → Personal drawing moves no scope’s runway and is listed in none', async () => {
    await seedAccounts()
    await insertAll('transactions', [...PERSONAL_ROWS, ...STRAWB_ROWS])
    const scopes = ['all', 'personal', 'strawb'] as const
    const before = new Map<string, HabitsResponse>()
    for (const scope of scopes) before.set(scope, (await get(scope)).body)

    await insertAll('transactions', drawingRows())

    for (const scope of scopes) {
      const res = await get(scope)
      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual(before.get(scope))
      const listed = res.body.verdicts.map((v: VerdictRow) => v.transactionId)
      expect(listed).not.toContain('205')
      expect(listed).not.toContain('106')
    }
    // Hand-worked, so the comparison above is not of two broken reads:
    // Strawb is 5,000,000 ÷ 64,000 = 78.125 → 78.
    expect((await get('strawb')).body.runwayTenths).toBe(78)
  })

  it('the drawing ids are loaded once per read', async () => {
    await seed()
    vi.mocked(matcher.findDrawingIds).mockClear()

    expect((await get('all')).status).toBe(200)

    expect(vi.mocked(matcher.findDrawingIds)).toHaveBeenCalledTimes(1)
  })

  it('a half Hannah categorised by hand keeps her category and is spend', async () => {
    await seedAccounts()
    await insertAll('transactions', [
      ...STRAWB_ROWS,
      ...drawingRows({ category: 'Contractors', category_source: 'user' }),
    ])

    const res = await get('strawb')

    expect(res.body).toStrictEqual({
      // 5,000,000 ÷ (64,000 + 40,000) = 48.07 → 48.
      runwayTenths: 48,
      streaks: [STREAK_58],
      verdicts: [
        {
          transactionId: '205',
          date: '2026-10-21',
          merchant: 'EXAMPLE DRAWING OUT',
          category: 'Contractors',
          amountCents: -40_000,
          verdict: null,
        },
        SUPPLIER,
      ],
    })
  })

  // The shared matcher's RangeError and TypeError name ids and values.
  it.each([
    ['RangeError', new RangeError('candidate 205 appears twice')],
    ['TypeError', new TypeError('amountCents of candidate 205 is 1.5')],
  ])('a drawing-load %s is the fixed-text 500', async (_name, thrown) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    vi.mocked(matcher.findDrawingIds).mockImplementationOnce(() => {
      throw thrown
    })

    const res = await get('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'habits input invalid' })
    expect(log.mock.calls).toEqual([
      ['habits: could not read habits', 'HabitsDataError'],
    ])
  })
})

describe('scope isolation', () => {
  it('Strawb spend, verdicts and transfers neither appear in nor move Personal', async () => {
    await seedAccounts()
    await insertAll('transactions', PERSONAL_ROWS)
    const before = (await get('personal')).body

    await insertAll('transactions', [...STRAWB_ROWS, ...DRAWING_ROWS])
    expect((await put(201, { verdict: 'not_really' })).status).toBe(200)

    expect((await get('personal')).body).toStrictEqual(before)
  })

  it('Personal spend, verdicts and transfers neither appear in nor move Strawb', async () => {
    await seedAccounts()
    await insertAll('transactions', STRAWB_ROWS)
    const before = (await get('strawb')).body

    // Personal → Strawb, the reverse of DRAWING_ROWS: money put in, never a
    // drawing.
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

  it('Sec-Fetch-Site: none (typed in the address bar) passes the site check', async () => {
    await seed()

    const res = await api
      .put('/api/v1/habits/verdicts/101')
      .set('Sec-Fetch-Site', 'none')
      .send({ verdict: 'worth_it' })

    expect(res.status).toBe(200)
    expect(await verdictRows()).toHaveLength(1)
  })

  it('an Origin naming this host passes the site check', async () => {
    await seed()

    const res = await api
      .put('/api/v1/habits/verdicts/101')
      .set('Origin', `http://127.0.0.1:${served?.address.port}`)
      .send({ verdict: 'worth_it' })

    expect(res.status).toBe(200)
    expect(await verdictRows()).toHaveLength(1)
  })

  it('an Origin matches a Host header in any case', async () => {
    await seed()

    const res = await api
      .put('/api/v1/habits/verdicts/101')
      .set('Host', 'DIVVY.EXAMPLE')
      .set('Origin', 'http://divvy.example')
      .send({ verdict: 'worth_it' })

    expect(res.status).toBe(200)
  })

  it('an Origin with no Host header is a 403 and writes nothing', async () => {
    await seed()
    // HTTP/1.0 over a raw socket: Node's HTTP client always sends Host, and
    // Node's server answers an HTTP/1.1 request without one with a 400
    // before the app sees it.
    const port = served?.address.port ?? 0

    // The control: the same request with no Origin reaches the route.
    const control = await rawPutWithoutHost(port, 103, [])
    expect(control.status).toBe(409)

    const res = await rawPutWithoutHost(port, 101, ['Origin: http://127.0.0.1'])

    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toStrictEqual({ error: 'Forbidden' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a settled row of 0 is not spending: a 400 that writes nothing', async () => {
    await seed()
    await insertAll('transactions', [
      tx(105, EVERYDAY, '2026-10-23', 0, 900_000),
    ])

    const res = await put(105, { verdict: 'worth_it' })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Only spending can be tagged' })
    expect(await verdictRows()).toHaveLength(0)
  })

  it('a settled row with no amount is a fixed-text 500, not money in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    await insertAll('transactions', [
      { ...tx(105, EVERYDAY, '2026-10-23', 0, 900_000), amount_cents: null },
    ])

    const res = await put(105, { verdict: 'worth_it' })

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
    expect(await verdictRows()).toHaveLength(0)
  })
})

/** Status and body of a PUT sent as HTTP/1.0 with no Host header. */
function rawPutWithoutHost(
  port: number,
  id: number,
  headers: string[],
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ verdict: 'worth_it' })
  const request = [
    `PUT /api/v1/habits/verdicts/${id} HTTP/1.0`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...headers,
    '',
    body,
  ].join('\r\n')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = connect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const [head, ...rest] = text.split('\r\n\r\n')
      resolve({
        status: Number(head.split(' ')[1]),
        body: rest.join('\r\n\r\n'),
      })
    })
  })
}

describe('a failure that is not a HabitsDataError', () => {
  // A message that must reach neither the client nor the log.
  class SentinelFailure extends Error {}
  const SECRET = 'SQLITE_ERROR near acc_sentinel_secret 4821'

  it('GET answers the generic text and logs only the error class', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(habitsDb.readHabits).mockRejectedValueOnce(
      new SentinelFailure(SECRET),
    )

    const res = await get('all')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not read habits' })
    expect(log.mock.calls).toEqual([
      ['habits: could not read habits', 'SentinelFailure'],
    ])
  })

  it('PUT answers the generic text and logs only the error class', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    vi.mocked(habitsDb.setVerdict).mockRejectedValueOnce(
      new SentinelFailure(SECRET),
    )

    const res = await put(101, { verdict: 'worth_it' })

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not save verdict' })
    expect(log.mock.calls).toEqual([
      ['habits: could not save verdict', 'SentinelFailure'],
    ])
    expect(await verdictRows()).toHaveLength(0)
  })
})

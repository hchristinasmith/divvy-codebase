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
  GoalResponse,
  GoalsResponse,
  OverviewResponse,
} from '../../../shared/contracts.ts'

// /api/v1/goals (prd-02, issue #50): the Goals screen's list and writes,
// over HTTP against the real app and a fresh in-memory database. The clock
// is fixed at 23:30 UTC on Tuesday 27 October 2026, which is 12:30 NZDT on
// Wednesday the 28th, so "today" is 2026-10-28. Every value below is
// invented; every expected pace is worked by hand in the comment beside it.

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

// `account`, `seedAccounts`, `snapshotTables`, `BAD_IDS` and
// `sortedKeys` are copies of the ones in ./overview.test.ts and
// ./bills.test.ts.
function account(fields: Row): Row {
  return {
    source: 'akahu',
    name: 'Invented account',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

const ACCOUNT = { everyday: 1, trading: 2, strawbPot: 3, xero: 4, savings: 5 }

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

const BAD_IDS = ['abc', '0', '01', '1e3', '-1', '9007199254740993']

const sortedKeys = (o: object) => Object.keys(o).sort()

function goal(
  id: number,
  name: string,
  target: number,
  date: string | null,
  fields: Row = {},
): Row {
  return {
    id,
    name,
    target_cents: target,
    target_date: date,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

function contribution(goalId: number, amount: number): Row {
  return { goal_id: goalId, amount_cents: amount, contributed_at: STAMP }
}

const getGoals = () => api.get('/api/v1/goals')
const getOverview = (scope: string) =>
  api.get(`/api/v1/overview?scope=${scope}`)
const postGoal = (body: unknown) =>
  api.post('/api/v1/goals').send(body as object)
const patchGoal = (id: string | number, body: unknown) =>
  api.patch(`/api/v1/goals/${id}`).send(body as object)
const deleteGoal = (id: string | number) => api.delete(`/api/v1/goals/${id}`)
const contribute = (id: string | number, body: unknown) =>
  api.post(`/api/v1/goals/${id}/contributions`).send(body as object)

const goalRows = () => connection('goals').select().orderBy('id')
const contributionRows = () =>
  connection('goal_contributions').select().orderBy('id')

const GOAL_KEYS = [
  'id',
  'name',
  'targetCents',
  'savedCents',
  'targetDate',
  'paceCents',
  'monthsToGo',
]

const VALID = {
  name: 'Invented trip',
  targetCents: 120000,
  // Three whole months from 2026-10-28.
  targetDate: '2027-01-28',
}

async function created(body: Row = {}): Promise<GoalResponse> {
  const res = await postGoal({ ...VALID, ...body })
  expect(res.status).toBe(201)
  return res.body
}

const TARGET_ERROR =
  'targetCents must be a whole number of cents from 1 to 1000000000'
const DATE_ERROR =
  'targetDate must be a YYYY-MM-DD date from 2000-01-01 to 2099-12-31, or null'
const NAME_ERROR = 'name must be 1 to 255 characters'
const AMOUNT_ERROR =
  'amountCents must be a whole number of cents from 1 to 1000000000'

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/v1/goals', () => {
  it('answers an empty list', async () => {
    const res = await getGoals()

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(sortedKeys(res.body)).toStrictEqual(['items'])
    expect(res.body).toStrictEqual({ items: [] })
  })

  it('pins every key, orders by id, and derives saved and pace from the stored rows', async () => {
    await connection('goals').insert([
      goal(7, 'Invented bike', 50000, null),
      goal(2, 'Invented trip', 120000, '2027-01-28'),
      goal(5, 'Invented laptop', 30000, '2026-12-01'),
    ])
    await connection('goal_contributions').insert([
      contribution(2, 15000),
      contribution(5, 30000),
      contribution(2, 5000),
      contribution(5, 1),
    ])

    const res = await getGoals()

    expect(res.status).toBe(200)
    const body: GoalsResponse = res.body
    for (const item of body.items) {
      expect(sortedKeys(item)).toStrictEqual([...GOAL_KEYS].sort())
    }
    expect(body.items.map((i) => i.id)).toEqual(['2', '5', '7'])
    expect(body.items).toStrictEqual([
      {
        id: '2',
        name: 'Invented trip',
        targetCents: 120000,
        // 15000 + 5000.
        savedCents: 20000,
        targetDate: '2027-01-28',
        // 100000 left over 3 months (10-28 to 01-28), rounded up once.
        paceCents: 33334,
        monthsToGo: 3,
      },
      {
        id: '5',
        name: 'Invented laptop',
        targetCents: 30000,
        // Overfunded: 30000 + 1.
        savedCents: 30001,
        targetDate: '2026-12-01',
        paceCents: 0,
        monthsToGo: 0,
      },
      {
        id: '7',
        name: 'Invented bike',
        targetCents: 50000,
        // No contributions.
        savedCents: 0,
        targetDate: null,
        paceCents: null,
        monthsToGo: null,
      },
    ])
  })

  it('a funded goal with no date is 0 and 0', async () => {
    await connection('goals').insert(goal(1, 'Invented fund', 1000, null))
    await connection('goal_contributions').insert(contribution(1, 1000))

    const body: GoalsResponse = (await getGoals()).body

    expect(body.items[0]).toMatchObject({
      savedCents: 1000,
      paceCents: 0,
      monthsToGo: 0,
    })
  })

  it('writes nothing', async () => {
    await connection('goals').insert(goal(1, 'Invented trip', 1000, null))
    await connection('goal_contributions').insert(contribution(1, 10))
    const before = await snapshotTables()

    expect((await getGoals()).status).toBe(200)
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it('answers stored contributions whose sum is not a safe integer with its fixed text, logging only the class', async () => {
    await connection('goals').insert(goal(1, 'Invented trip', 1000, null))
    // Each is a safe integer; together they are 2^53, which is not.
    await connection('goal_contributions').insert([
      contribution(1, 2 ** 52),
      contribution(1, 2 ** 52),
    ])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getGoals()

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a stored goal is not valid' })
    expect(logged.mock.calls).toStrictEqual([
      ['goals: could not list goals', 'GoalsDataError'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Months to go at the route
// ---------------------------------------------------------------------------

describe('months to go', () => {
  it.each([
    ['in the past', '2026-09-01', 1, 100000],
    ['today', '2026-10-28', 1, 100000],
    ['tomorrow', '2026-10-29', 1, 100000],
    // 11-29 is a day past a whole month from 10-28: two, 50000 each.
    ['a month and a day out', '2026-11-29', 2, 50000],
  ])(
    'a target date %s is %i month(s)',
    async (_why, targetDate, months, pace) => {
      const made = await created({ targetCents: 100000, targetDate })

      expect(made).toMatchObject({ monthsToGo: months, paceCents: pace })
    },
  )
})

// ---------------------------------------------------------------------------
// Only this site may write
// ---------------------------------------------------------------------------

describe('only this site may write (as POST /api/v1/sync/run)', () => {
  const WRITES: [string, () => ReturnType<typeof deleteGoal>][] = [
    ['POST /', () => postGoal(VALID)],
    ['PATCH /1', () => patchGoal(1, { name: 'Renamed' })],
    ['DELETE /1', () => deleteGoal(1)],
    ['POST /1/contributions', () => contribute(1, { amountCents: 5000 })],
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
      await connection('goals').insert(goal(1, 'Invented trip', 1000, null))
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
    ['PATCH /abc', () => patchGoal('abc', { name: 'Renamed' })],
    ['DELETE /abc', () => deleteGoal('abc')],
    ['POST /abc/contributions', () => contribute('abc', { amountCents: 1 })],
    ['POST / with an invalid body', () => postGoal({})],
    ['PATCH /1 with an invalid body', () => patchGoal(1, { targetCents: 'x' })],
    [
      'POST /1/contributions with an invalid body',
      () => contribute(1, { amountCents: 0 }),
    ],
  ])(
    'refuses a cross-site %s with 403 before reading the id or body',
    async (_write, send) => {
      await connection('goals').insert(goal(1, 'Invented trip', 1000, null))
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
      const headers = build(port())
      const made = await postGoal(VALID).set(headers)
      expect(made.status).toBe(201)
      const id = made.body.id
      expect(
        (await patchGoal(id, { name: 'Renamed' }).set(headers)).status,
      ).toBe(200)
      expect(
        (await contribute(id, { amountCents: 100 }).set(headers)).status,
      ).toBe(201)
      expect((await deleteGoal(id).set(headers)).status).toBe(204)
    },
  )
})

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe('POST /api/v1/goals', () => {
  it('creates the goal and answers 201 with it, stamped now', async () => {
    const res = await postGoal({ ...VALID, name: '  Invented trip  ' })

    expect(res.status).toBe(201)
    expect(sortedKeys(res.body)).toStrictEqual([...GOAL_KEYS].sort())
    const rows = await goalRows()
    expect(rows).toHaveLength(1)
    expect(res.body).toStrictEqual({
      id: String(rows[0].id),
      name: 'Invented trip',
      targetCents: 120000,
      savedCents: 0,
      targetDate: '2027-01-28',
      // 120000 over 3 months.
      paceCents: 40000,
      monthsToGo: 3,
    })
    expect(rows[0]).toStrictEqual({
      id: rows[0].id,
      name: 'Invented trip',
      target_cents: 120000,
      target_date: '2027-01-28',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    })
    expect(await contributionRows()).toStrictEqual([])
  })

  it.each([
    ['omitted', { name: 'Invented fund', targetCents: 5000 }],
    ['null', { name: 'Invented fund', targetCents: 5000, targetDate: null }],
  ])('a targetDate %s is no date and no pace', async (_why, body) => {
    const res = await postGoal(body)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      targetDate: null,
      paceCents: null,
      monthsToGo: null,
    })
    expect((await goalRows())[0].target_date).toBeNull()
  })

  const SENTINEL = 'zz-sentinel-81fd'

  it.each([
    ['an empty array body', [], 'Body must be a JSON object'],
    ['an array body', [VALID], 'Body must be a JSON object'],
    ['an unknown field', { ...VALID, savedCents: 5 }, 'Unknown field in body'],
    ['no name', { ...VALID, name: undefined }, NAME_ERROR],
    ['a blank name', { ...VALID, name: '   ' }, NAME_ERROR],
    ['an over-long name', { ...VALID, name: 'x'.repeat(256) }, NAME_ERROR],
    ['a numeric name', { ...VALID, name: 42 }, NAME_ERROR],
    ['no target', { ...VALID, targetCents: undefined }, TARGET_ERROR],
    ['a zero target', { ...VALID, targetCents: 0 }, TARGET_ERROR],
    ['a negative target', { ...VALID, targetCents: -100 }, TARGET_ERROR],
    ['a float target', { ...VALID, targetCents: 100.5 }, TARGET_ERROR],
    ['a string target', { ...VALID, targetCents: '120000' }, TARGET_ERROR],
    ['a null target', { ...VALID, targetCents: null }, TARGET_ERROR],
    [
      'a target over the limit',
      { ...VALID, targetCents: 1_000_000_001 },
      TARGET_ERROR,
    ],
    ['an impossible date', { ...VALID, targetDate: '2026-02-30' }, DATE_ERROR],
    ['a short date', { ...VALID, targetDate: '2026-1-1' }, DATE_ERROR],
    ['a date before 2000', { ...VALID, targetDate: '1999-12-31' }, DATE_ERROR],
    ['a date after 2099', { ...VALID, targetDate: '2100-01-01' }, DATE_ERROR],
    ['a numeric date', { ...VALID, targetDate: 20270128 }, DATE_ERROR],
    ['a sentinel date', { ...VALID, targetDate: SENTINEL }, DATE_ERROR],
    // The first failure in field order, whatever order the body sends.
    [
      'a bad date before a bad name',
      { targetDate: 'x', targetCents: 0, name: '' },
      NAME_ERROR,
    ],
    [
      'a bad date and a bad target',
      { targetDate: 'x', name: 'Invented trip', targetCents: 0 },
      TARGET_ERROR,
    ],
  ])('refuses %s with 400, writing nothing', async (_why, body, error) => {
    const before = await snapshotTables()

    const res = await postGoal(body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(res.text).not.toContain(SENTINEL)
    expect(await snapshotTables()).toStrictEqual(before)
  })

  // express.json() is strict: a JSON null, number or string never reaches
  // the route, and the app answers its own fixed 400. Only an array does,
  // which the table above covers.
  it.each(['null', '5', '"x"'])(
    'refuses a JSON %s body with 400, writing nothing',
    async (raw) => {
      const before = await snapshotTables()

      const res = await api
        .post('/api/v1/goals')
        .set('Content-Type', 'application/json')
        .send(raw)

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'Bad request' })
      expect(await snapshotTables()).toStrictEqual(before)
    },
  )
})

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/goals/:id', () => {
  it.each([
    ['name', { name: '  Renamed  ' }, { name: 'Renamed' }],
    [
      'targetCents',
      // 90000 over 3 months.
      { targetCents: 90000 },
      { targetCents: 90000, paceCents: 30000 },
    ],
    [
      'targetDate',
      // 120000 over 6 months (10-28 to 04-28).
      { targetDate: '2027-04-28' },
      { targetDate: '2027-04-28', paceCents: 20000, monthsToGo: 6 },
    ],
  ])(
    'edits %s, answers the goal and stamps updated_at',
    async (_f, body, changed) => {
      const made = await created()
      vi.setSystemTime('2026-10-27T23:45:00.000Z')

      const res = await patchGoal(made.id, body)

      expect(res.status).toBe(200)
      expect(sortedKeys(res.body)).toStrictEqual([...GOAL_KEYS].sort())
      expect(res.body).toStrictEqual({ ...made, ...changed })
      const [row] = await goalRows()
      expect(row.created_at).toBe(NOW_ISO)
      expect(row.updated_at).toBe('2026-10-27T23:45:00.000Z')
    },
  )

  it.each([
    ['{}', {}],
    ['every stored value again', VALID],
  ])(
    'answers %s with the goal unchanged, writing nothing',
    async (_why, body) => {
      const made = await created()
      const before = await snapshotTables()
      vi.setSystemTime('2026-10-27T23:45:00.000Z')

      const res = await patchGoal(made.id, body)

      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual(made)
      expect(await snapshotTables()).toStrictEqual(before)
    },
  )

  it('targetDate: null clears the date and the pace', async () => {
    const made = await created()

    const res = await patchGoal(made.id, { targetDate: null })

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      ...made,
      targetDate: null,
      paceCents: null,
      monthsToGo: null,
    })
    expect((await goalRows())[0].target_date).toBeNull()
  })

  it('a target below what is saved is allowed and funds the goal', async () => {
    const made = await created()
    expect((await contribute(made.id, { amountCents: 20000 })).status).toBe(201)

    const res = await patchGoal(made.id, { targetCents: 10000 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      targetCents: 10000,
      savedCents: 20000,
      paceCents: 0,
      monthsToGo: 0,
    })
  })

  it.each([
    ['a null name', { name: null }, NAME_ERROR],
    ['a null target', { targetCents: null }, TARGET_ERROR],
    ['an unknown field', { savedCents: 0 }, 'Unknown field in body'],
    ['an array body', [], 'Body must be a JSON object'],
  ])('refuses %s with 400, writing nothing', async (_why, body, error) => {
    const made = await created()
    const before = await snapshotTables()

    const res = await patchGoal(made.id, body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it('answers 404 for a goal that does not exist', async () => {
    const res = await patchGoal(999, { name: 'Renamed' })

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Goal not found' })
  })

  it('refuses a bad body with 400 before looking for the goal', async () => {
    const res = await patchGoal(999, { targetCents: 0 })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: TARGET_ERROR })
  })

  it.each(BAD_IDS)('refuses id %s before reading the body', async (id) => {
    const res = await patchGoal(id, [])

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/goals/:id', () => {
  it('deletes the goal and its contributions, leaving another goal’s: 204 with no body', async () => {
    const gone = await created({ name: 'Invented gone' })
    const kept = await created({ name: 'Invented kept' })
    expect((await contribute(gone.id, { amountCents: 300 })).status).toBe(201)
    expect((await contribute(kept.id, { amountCents: 700 })).status).toBe(201)
    expect((await contribute(gone.id, { amountCents: 400 })).status).toBe(201)
    const keptRows = (await contributionRows()).filter(
      (c) => c.goal_id === Number(kept.id),
    )
    const keptGoal = (await goalRows()).filter((g) => g.id === Number(kept.id))

    const res = await deleteGoal(gone.id)

    expect(res.status).toBe(204)
    expect(res.text).toBe('')
    expect(await goalRows()).toStrictEqual(keptGoal)
    expect(await contributionRows()).toStrictEqual(keptRows)
    expect(keptRows).toHaveLength(1)
  })

  it('answers 404 for a goal that does not exist', async () => {
    const res = await deleteGoal(999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Goal not found' })
  })

  it.each(BAD_IDS)('refuses id %s', async (id) => {
    const res = await deleteGoal(id)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })
})

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

describe('POST /api/v1/goals/:id/contributions', () => {
  it('appends each contribution, answering the goal with the running sum and a fresh pace', async () => {
    const made = await created()
    const [goalBefore] = await goalRows()
    const seen: GoalResponse[] = []
    // Each amount is the request's; the server holds none of them.
    for (const [amountCents, at] of [
      [5000, '2026-10-27T23:31:00.000Z'],
      [20000, '2026-10-27T23:32:00.000Z'],
      [1234, '2026-10-27T23:33:00.000Z'],
    ] as const) {
      vi.setSystemTime(at)
      const res = await contribute(made.id, { amountCents })
      expect(res.status).toBe(201)
      expect(sortedKeys(res.body)).toStrictEqual(['goal'])
      expect(sortedKeys(res.body.goal)).toStrictEqual([...GOAL_KEYS].sort())
      seen.push(res.body.goal)
    }

    expect(seen).toStrictEqual([
      // 120000 − 5000 = 115000 over 3 months: 38333.33…, up to 38334.
      { ...made, savedCents: 5000, paceCents: 38334 },
      // 120000 − 25000 = 95000 over 3: 31666.66…, up to 31667.
      { ...made, savedCents: 25000, paceCents: 31667 },
      // 120000 − 26234 = 93766 over 3: 31255.33…, up to 31256.
      { ...made, savedCents: 26234, paceCents: 31256 },
    ])
    expect(await contributionRows()).toStrictEqual([
      {
        id: expect.any(Number),
        goal_id: Number(made.id),
        amount_cents: 5000,
        contributed_at: '2026-10-27T23:31:00.000Z',
      },
      {
        id: expect.any(Number),
        goal_id: Number(made.id),
        amount_cents: 20000,
        contributed_at: '2026-10-27T23:32:00.000Z',
      },
      {
        id: expect.any(Number),
        goal_id: Number(made.id),
        amount_cents: 1234,
        contributed_at: '2026-10-27T23:33:00.000Z',
      },
    ])
    // The goal row itself, updated_at included, is untouched.
    expect(await goalRows()).toStrictEqual([goalBefore])
    // And the list says the same.
    expect((await getGoals()).body.items).toStrictEqual([seen[2]])
  })

  it('an odd amount sums exactly: 1234 + 1', async () => {
    const made = await created({ targetCents: 2000, targetDate: null })
    await contribute(made.id, { amountCents: 1234 })

    const res = await contribute(made.id, { amountCents: 1 })

    expect(res.body.goal.savedCents).toBe(1235)
  })

  it('a contribution that funds the goal answers 0 and 0', async () => {
    const made = await created({ targetCents: 5000 })

    const res = await contribute(made.id, { amountCents: 5000 })

    expect(res.body.goal).toMatchObject({
      savedCents: 5000,
      paceCents: 0,
      monthsToGo: 0,
    })
  })

  it.each([
    ['a zero amount', { amountCents: 0 }, AMOUNT_ERROR],
    ['a negative amount', { amountCents: -5000 }, AMOUNT_ERROR],
    ['a float amount', { amountCents: 50.5 }, AMOUNT_ERROR],
    ['a string amount', { amountCents: '5000' }, AMOUNT_ERROR],
    ['a null amount', { amountCents: null }, AMOUNT_ERROR],
    ['no amount', {}, AMOUNT_ERROR],
    ['an amount over the limit', { amountCents: 1_000_000_001 }, AMOUNT_ERROR],
    [
      'a contributedAt',
      { amountCents: 5000, contributedAt: '2026-01-01T00:00:00.000Z' },
      'Unknown field in body',
    ],
    ['an empty array body', [], 'Body must be a JSON object'],
    ['an array body', [5000], 'Body must be a JSON object'],
  ])('refuses %s with 400, writing nothing', async (_why, body, error) => {
    const made = await created()
    const before = await snapshotTables()

    const res = await contribute(made.id, body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it('answers 404 for a goal that does not exist, after a valid body', async () => {
    const before = await snapshotTables()

    const res = await contribute(999, { amountCents: 5000 })

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Goal not found' })
    expect(await snapshotTables()).toStrictEqual(before)
  })

  it('refuses a bad body with 400 before looking for the goal', async () => {
    const res = await contribute(999, { amountCents: 0 })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: AMOUNT_ERROR })
  })

  it.each(BAD_IDS)('refuses id %s before reading the body', async (id) => {
    const res = await contribute(id, [])

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
  })
})

// ---------------------------------------------------------------------------
// Contributions are append only
// ---------------------------------------------------------------------------

describe('no route edits or deletes a contribution', () => {
  it.each([
    ['GET /1/contributions', () => api.get('/api/v1/goals/1/contributions')],
    [
      'PUT /1/contributions',
      () => api.put('/api/v1/goals/1/contributions').send({ amountCents: 1 }),
    ],
    [
      'PATCH /1/contributions',
      () => api.patch('/api/v1/goals/1/contributions').send({ amountCents: 1 }),
    ],
    [
      'DELETE /1/contributions',
      () => api.delete('/api/v1/goals/1/contributions'),
    ],
    [
      'GET /1/contributions/1',
      () => api.get('/api/v1/goals/1/contributions/1'),
    ],
    [
      'PUT /1/contributions/1',
      () => api.put('/api/v1/goals/1/contributions/1').send({ amountCents: 1 }),
    ],
    [
      'PATCH /1/contributions/1',
      () =>
        api.patch('/api/v1/goals/1/contributions/1').send({ amountCents: 1 }),
    ],
    [
      'DELETE /1/contributions/1',
      () => api.delete('/api/v1/goals/1/contributions/1'),
    ],
    [
      'POST /1/contributions/1',
      () =>
        api.post('/api/v1/goals/1/contributions/1').send({ amountCents: 1 }),
    ],
  ])('%s is the app’s JSON 404, changing nothing', async (_why, send) => {
    await connection('goals').insert(goal(1, 'Invented trip', 1000, null))
    await connection('goal_contributions').insert({
      id: 1,
      ...contribution(1, 400),
    })
    const before = await snapshotTables()

    const res = await send()

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
    expect(await snapshotTables()).toStrictEqual(before)
  })
})

// ---------------------------------------------------------------------------
// prd-02 Ruling 5: a contribution is a record, not a transfer
// ---------------------------------------------------------------------------

describe('a contribution never changes safe-to-spend (prd-02 Ruling 5)', () => {
  it('the overview is the same before and after, in every scope, and only goal_contributions changes', async () => {
    await seedAccounts()
    await connection('accounts').insert(
      account({
        id: ACCOUNT.savings,
        akahu_id: 'acc_sentinel_5',
        name: 'Invented savings',
        scope: 'personal',
        balance_cents: 90000,
      }),
    )
    await connection('account_settings').insert({
      account_id: ACCOUNT.savings,
      role: 'savings',
      updated_at: STAMP,
    })
    const made = await created()

    const SCOPES = ['all', 'personal', 'strawb']
    const before: OverviewResponse[] = []
    for (const scope of SCOPES) {
      const res = await getOverview(scope)
      expect(res.status, scope).toBe(200)
      before.push(res.body)
    }
    const tablesBefore = await snapshotTables()

    expect((await contribute(made.id, { amountCents: 5000 })).status).toBe(201)
    expect((await contribute(made.id, { amountCents: 20000 })).status).toBe(201)

    for (const [i, scope] of SCOPES.entries()) {
      const res = await getOverview(scope)
      expect(res.status, scope).toBe(200)
      const after: OverviewResponse = res.body
      expect(after.safeToSpend.safeCents, scope).toBe(
        before[i].safeToSpend.safeCents,
      )
      expect(after, scope).toStrictEqual(before[i])
    }
    const tablesAfter = await snapshotTables()
    expect(tablesAfter.goal_contributions).toHaveLength(2)
    const exceptContributions = (tables: Record<string, Row[]>) =>
      Object.fromEntries(
        Object.entries(tables).filter(
          ([name]) => name !== 'goal_contributions',
        ),
      )
    expect(Object.keys(tablesAfter)).toContain('goals')
    expect(exceptContributions(tablesAfter)).toStrictEqual(
      exceptContributions(tablesBefore),
    )
  })
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('a failure that is not a GoalsDataError', () => {
  // The table is set aside so the query fails with SQLite's own message,
  // which names it; that text must reach neither the client nor the log.
  it.each([
    ['GET /', 'goal_contributions', 'list goals', () => getGoals()],
    ['POST /', 'goals', 'create goal', () => postGoal(VALID)],
    [
      'PATCH /1',
      'goals',
      'update goal',
      () => patchGoal(1, { name: 'Renamed' }),
    ],
    ['DELETE /1', 'goals', 'delete goal', () => deleteGoal(1)],
    [
      'POST /1/contributions',
      'goal_contributions',
      'add contribution',
      () => contribute(1, { amountCents: 5000 }),
    ],
  ])(
    '%s answers the generic 500 and logs only the class',
    async (_route, table, what, send) => {
      await connection('goals').insert(goal(1, 'Invented trip', 1000, null))
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      await connection.schema.renameTable(table, `${table}_aside`)
      try {
        const res = await send()

        expect(res.status).toBe(500)
        expect(res.body).toStrictEqual({ error: 'Internal server error' })
        expect(logged.mock.calls).toStrictEqual([
          [`goals: could not ${what}`, 'Error'],
        ])
      } finally {
        await connection.schema.renameTable(`${table}_aside`, table)
      }
    },
  )
})

describe('paths this router does not serve', () => {
  it.each([
    ['GET /1', () => api.get('/api/v1/goals/1')],
    ['PUT /1', () => api.put('/api/v1/goals/1').send(VALID)],
  ])('%s is the app’s JSON 404', async (_why, send) => {
    await connection('goals').insert(goal(1, 'Invented trip', 1000, null))

    const res = await send()

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })
})

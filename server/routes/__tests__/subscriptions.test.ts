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
  SubscriptionMarkResponse,
  SubscriptionMerchant,
  SubscriptionRow,
  SubscriptionsResponse,
  SubscriptionTotals,
} from '../../../shared/contracts.ts'

// /api/v1/subscriptions (prd-02 Ruling 14, issue #229): the read and
// Hannah's marks, over HTTP against the real app and a fresh in-memory
// database. The clock is fixed at 23:30 UTC on 27 October 2026, which is
// 12:30 NZDT on the 28th, so today in NZ is 2026-10-28. Every value below is
// invented.

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

// A copy of the account/transaction builders in ./overview.test.ts and
// server/db/__tests__/subscriptions.test.ts.
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
  accountId: string,
  date: string,
  amountCents: number,
  fields: Row = {},
): Row {
  return {
    account_id: accountId,
    date,
    amount_cents: amountCents,
    description: 'EXAMPLE STREAM 4829',
    merchant_id: 'merchant_fixture_stream',
    merchant_name: 'Example Stream',
    status: 'settled',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

// Account numbers, Akahu ids, connection ids and names: never in a payload.
const SECRET_TOKENS = [
  'acc_sentinel_',
  '00-SENT-',
  'Sentinel Bank 91c2',
  'conn_sentinel_',
  'Sentinel Everyday',
  'Sentinel Trading',
]

const EVERYDAY = 'acc_sentinel_everyday'
const TRADING = 'acc_sentinel_trading'
const STREAM = 'm:merchant_fixture_stream'
const CLOUD = 'm:merchant_fixture_cloud'
const HOST = 'm:merchant_fixture_host'

async function insertAll(table: string, rows: Row[]) {
  // One insert per row: a multi-row insert binds NULL for a key a row
  // leaves out, which would skip the column defaults.
  for (const row of rows) await connection(table).insert(row)
}

// Personal: Example Stream, three monthly charges (detected), and Example
// Cloud Storage, one charge with a hint name (a question). Strawb: Example
// Host, three weekly charges of 1000 (detected).
async function seed() {
  const sentinel = (n: number, akahuId: string) => ({
    akahu_id: akahuId,
    formatted_account: `00-SENT-000000${n}-00`,
    connection_id: `conn_sentinel_${n}`,
    connection_name: 'Sentinel Bank 91c2',
  })
  await insertAll('accounts', [
    account({
      id: 1,
      ...sentinel(1, EVERYDAY),
      name: 'Sentinel Everyday',
      scope: 'personal',
      balance_cents: 250000,
    }),
    account({
      id: 2,
      ...sentinel(2, TRADING),
      name: 'Sentinel Trading',
      scope: 'strawb',
      balance_cents: 600000,
    }),
  ])
  await connection('account_settings').insert([
    { account_id: 1, role: 'current', updated_at: STAMP },
    { account_id: 2, role: 'current', updated_at: STAMP },
  ])
  await insertAll('transactions', [
    // Noon NZST: the NZ date is the UTC date.
    tx(EVERYDAY, '2026-07-01T00:00:00.000Z', -1599),
    tx(EVERYDAY, '2026-07-31T00:00:00.000Z', -1599),
    tx(EVERYDAY, '2026-08-30T00:00:00.000Z', -1599),
    tx(EVERYDAY, '2026-10-01T00:00:00.000Z', -299, {
      merchant_id: 'merchant_fixture_cloud',
      merchant_name: 'Example Cloud Storage',
      description: 'EXAMPLE CLOUD',
    }),
    // Noon NZDT on the 5th, 12th and 19th.
    ...[
      '2026-10-04T23:00:00.000Z',
      '2026-10-11T23:00:00.000Z',
      '2026-10-18T23:00:00.000Z',
    ].map((date) =>
      tx(TRADING, date, -1000, {
        merchant_id: 'merchant_fixture_host',
        merchant_name: 'Example Host',
        description: 'EXAMPLE HOST',
      }),
    ),
  ])
}

const marks = (): Promise<Row[]> =>
  connection('subscription_marks').orderBy('id')

const get = (scope: string) => api.get(`/api/v1/subscriptions?scope=${scope}`)
const mark = (body: unknown) =>
  api.put('/api/v1/subscriptions/mark').send(body as object)
const cancel = (body: unknown) =>
  api.post('/api/v1/subscriptions/cancel').send(body as object)
const uncancel = (body: unknown) =>
  api.post('/api/v1/subscriptions/uncancel').send(body as object)

const RESPONSE_KEYS: Record<keyof SubscriptionsResponse, true> = {
  subscriptions: true,
  questions: true,
  notSubscriptions: true,
  totals: true,
}
const MERCHANT_KEYS: Record<keyof SubscriptionMerchant, true> = {
  merchantKey: true,
  scope: true,
  name: true,
  chargeCount: true,
  lastChargedOn: true,
  amountCents: true,
}
const ROW_KEYS: Record<keyof SubscriptionRow, true> = {
  ...MERCHANT_KEYS,
  cadence: true,
  detected: true,
  marked: true,
  status: true,
  cancelledOn: true,
  chargedAgainOn: true,
  perMonthCents: true,
  perYearCents: true,
  possiblyStopped: true,
}
const TOTAL_KEYS: Record<keyof SubscriptionTotals, true> = {
  perMonthCents: true,
  perYearCents: true,
  countedCount: true,
  uncountedCount: true,
  possiblyStoppedCount: true,
}
const MARK_RESPONSE_KEYS: Record<keyof SubscriptionMarkResponse, true> = {
  scope: true,
  merchantKey: true,
  answer: true,
  cancelledOn: true,
}
const keys = (o: object) => Object.keys(o).sort()

const STREAM_ROW: SubscriptionRow = {
  merchantKey: STREAM,
  scope: 'personal',
  name: 'Example Stream',
  chargeCount: 3,
  lastChargedOn: '2026-08-30',
  amountCents: 1599,
  cadence: 'monthly',
  detected: true,
  marked: false,
  status: 'active',
  cancelledOn: null,
  chargedAgainOn: null,
  perMonthCents: 1599,
  // 12 × 1599
  perYearCents: 19188,
  possiblyStopped: false,
}
const HOST_ROW: SubscriptionRow = {
  merchantKey: HOST,
  scope: 'strawb',
  name: 'Example Host',
  chargeCount: 3,
  lastChargedOn: '2026-10-19',
  amountCents: 1000,
  cadence: 'weekly',
  detected: true,
  marked: false,
  status: 'active',
  cancelledOn: null,
  chargedAgainOn: null,
  // 1000 × 52 ÷ 12 = 4333.33 → 4333
  perMonthCents: 4333,
  // 12 × 4333
  perYearCents: 51996,
  possiblyStopped: false,
}
const CLOUD_QUESTION: SubscriptionMerchant = {
  merchantKey: CLOUD,
  scope: 'personal',
  name: 'Example Cloud Storage',
  chargeCount: 1,
  lastChargedOn: '2026-10-01',
  amountCents: 299,
}

describe('GET: the response is the contract', () => {
  it('all: both scopes, the question, and totals over both', async () => {
    await seed()

    const res = await get('all')

    expect(res.status).toBe(200)
    expect(keys(res.body)).toEqual(keys(RESPONSE_KEYS))
    expect(keys(res.body.totals)).toEqual(keys(TOTAL_KEYS))
    for (const row of res.body.subscriptions)
      expect(keys(row)).toEqual(keys(ROW_KEYS))
    for (const q of res.body.questions)
      expect(keys(q)).toEqual(keys(MERCHANT_KEYS))
    expect(res.body).toStrictEqual({
      subscriptions: [HOST_ROW, STREAM_ROW],
      questions: [CLOUD_QUESTION],
      notSubscriptions: [],
      // 4333 + 1599 = 5932; 12 × 5932 = 71184.
      totals: {
        perMonthCents: 5932,
        perYearCents: 71184,
        countedCount: 2,
        uncountedCount: 0,
        possiblyStoppedCount: 0,
      },
    })
  })

  it('personal has no strawb merchant', async () => {
    await seed()

    const res = await get('personal')

    expect(res.body.subscriptions).toStrictEqual([STREAM_ROW])
    expect(res.body.questions).toStrictEqual([CLOUD_QUESTION])
    expect(res.body.totals).toStrictEqual({
      perMonthCents: 1599,
      perYearCents: 19188,
      countedCount: 1,
      uncountedCount: 0,
      possiblyStoppedCount: 0,
    })
  })

  it('strawb has no personal merchant', async () => {
    await seed()

    const res = await get('strawb')

    expect(res.body.subscriptions).toStrictEqual([HOST_ROW])
    expect(res.body.questions).toStrictEqual([])
    expect(res.body.totals).toStrictEqual({
      perMonthCents: 4333,
      perYearCents: 51996,
      countedCount: 1,
      uncountedCount: 0,
      possiblyStoppedCount: 0,
    })
  })

  it('an empty database answers empty lists and zero totals', async () => {
    const res = await get('all')

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      subscriptions: [],
      questions: [],
      notSubscriptions: [],
      totals: {
        perMonthCents: 0,
        perYearCents: 0,
        countedCount: 0,
        uncountedCount: 0,
        possiblyStoppedCount: 0,
      },
    })
  })

  it('no account id, account number, connection or account name is in the payload; the merchant key is', async () => {
    await seed()

    for (const scope of ['all', 'personal', 'strawb']) {
      const res = await get(scope)
      for (const token of SECRET_TOKENS)
        expect(res.text, `${scope}: ${token}`).not.toContain(token)
    }
    expect((await get('all')).text).toContain(STREAM)
  })

  it.each([
    ['missing', ''],
    ['empty', '?scope='],
    ['upper case', '?scope=ALL'],
    ['unknown', '?scope=business'],
    ['repeated', '?scope=all&scope=all'],
    ['an object', '?scope[x]=y'],
  ])('a scope that is %s is a 400', async (_why, query) => {
    const res = await api.get(`/api/v1/subscriptions${query}`)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'scope must be all, personal or strawb',
    })
    expect(res.text).not.toContain('business')
  })
})

const WRITES = [
  [
    'PUT /mark',
    mark,
    { scope: 'personal', merchantKey: STREAM, answer: 'subscription' },
  ],
  ['POST /cancel', cancel, { scope: 'personal', merchantKey: STREAM }],
  ['POST /uncancel', uncancel, { scope: 'personal', merchantKey: STREAM }],
] as const

const URLS = {
  'PUT /mark': (h: Record<string, string>) =>
    api.put('/api/v1/subscriptions/mark').set(h),
  'POST /cancel': (h: Record<string, string>) =>
    api.post('/api/v1/subscriptions/cancel').set(h),
  'POST /uncancel': (h: Record<string, string>) =>
    api.post('/api/v1/subscriptions/uncancel').set(h),
}

describe('only this site may write (as POST /api/v1/sync/run)', () => {
  const ownOrigin = () => `http://127.0.0.1:${served?.address.port}`

  describe.each(WRITES)('%s', (name, _send, body) => {
    it.each(['cross-site', 'same-site'])(
      'Sec-Fetch-Site %s is refused even with this host’s own Origin',
      async (site) => {
        await seed()

        const res = await URLS[name]({
          'Sec-Fetch-Site': site,
          Origin: ownOrigin(),
        }).send(body)

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await marks()).toStrictEqual([])
      },
    )

    it.each(['http://evil.example', 'null', 'not a url'])(
      'without Sec-Fetch-Site, Origin %s is refused',
      async (origin) => {
        await seed()

        const res = await URLS[name]({ Origin: origin }).send(body)

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await marks()).toStrictEqual([])
      },
    )

    it('the guard comes before the body is read', async () => {
      const res = await URLS[name]({ 'Sec-Fetch-Site': 'cross-site' }).send([])

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
    })

    it.each<[string, Record<string, string> | 'own']>([
      [
        'Sec-Fetch-Site same-origin, behind the dev proxy',
        { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' },
      ],
      ['Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
      ['this host’s own Origin', 'own'],
      ['no headers (curl)', {}],
    ])('%s passes', async (_why, headers) => {
      await seed()

      const res = await URLS[name](
        headers === 'own' ? { Origin: ownOrigin() } : headers,
      ).send(body)

      expect(res.status).toBe(200)
    })
  })
})

describe('writes refuse a bad body with a fixed text and write nothing', () => {
  const LONG_KEY = `m:${'x'.repeat(254)}`

  const COMMON: [string, unknown, number, string][] = [
    ['an array', [], 400, 'Invalid body'],
    [
      'an unknown key',
      { scope: 'personal', merchantKey: STREAM, extra: 1 },
      400,
      'Invalid body',
    ],
    [
      'no scope',
      { merchantKey: STREAM },
      400,
      'scope must be personal or strawb',
    ],
    [
      'scope all',
      { scope: 'all', merchantKey: STREAM },
      400,
      'scope must be personal or strawb',
    ],
    [
      'scope family',
      { scope: 'family', merchantKey: STREAM },
      400,
      'scope must be personal or strawb',
    ],
    ['no merchantKey', { scope: 'personal' }, 400, 'merchantKey is not valid'],
    [
      'a number merchantKey',
      { scope: 'personal', merchantKey: 42 },
      400,
      'merchantKey is not valid',
    ],
    [
      'an empty merchantKey',
      { scope: 'personal', merchantKey: '' },
      400,
      'merchantKey is not valid',
    ],
    [
      'an x: merchantKey',
      { scope: 'personal', merchantKey: 'x:abc' },
      400,
      'merchantKey is not valid',
    ],
    [
      'a bare m:',
      { scope: 'personal', merchantKey: 'm:' },
      400,
      'merchantKey is not valid',
    ],
    [
      'a 256-character merchantKey',
      { scope: 'personal', merchantKey: LONG_KEY },
      400,
      'merchantKey is not valid',
    ],
  ]

  const withAnswer = (body: unknown) =>
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? { answer: 'subscription', ...body }
      : body

  it.each(COMMON)('PUT /mark: %s', async (_why, body, status, error) => {
    await seed()

    const res = await mark(withAnswer(body))

    expect([res.status, res.body]).toStrictEqual([status, { error }])
    expect(await marks()).toStrictEqual([])
  })

  it.each(COMMON)('POST /cancel: %s', async (_why, body, status, error) => {
    await seed()

    const res = await cancel(body)

    expect([res.status, res.body]).toStrictEqual([status, { error }])
    expect(await marks()).toStrictEqual([])
  })

  it.each(COMMON)('POST /uncancel: %s', async (_why, body, status, error) => {
    await seed()

    const res = await uncancel(body)

    expect([res.status, res.body]).toStrictEqual([status, { error }])
    expect(await marks()).toStrictEqual([])
  })

  it.each<[string, Row]>([
    ['missing', {}],
    ['yes', { answer: 'yes' }],
    ['a boolean', { answer: true }],
    ['upper case', { answer: 'SUBSCRIPTION' }],
  ])('PUT /mark: an answer that is %s', async (_why, extra) => {
    await seed()

    const res = await mark({ scope: 'personal', merchantKey: STREAM, ...extra })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'answer must be subscription, not_subscription or null',
    })
    expect(await marks()).toStrictEqual([])
  })

  it.each<[string, unknown]>([
    ['an impossible date', '2026-02-30'],
    ['a timestamp', '2026-10-28T00:00:00Z'],
    ['a number', 20261028],
    ['null', null],
    ['an empty string', ''],
  ])('POST /cancel: on that is %s', async (_why, on) => {
    await seed()

    const res = await cancel({ scope: 'personal', merchantKey: STREAM, on })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'on must be a YYYY-MM-DD date' })
    expect(await marks()).toStrictEqual([])
  })

  it('POST /cancel: on tomorrow in NZ is in the future; today in NZ is not', async () => {
    await seed()

    const future = await cancel({
      scope: 'personal',
      merchantKey: STREAM,
      on: '2026-10-29',
    })
    expect(future.status).toBe(400)
    expect(future.body).toStrictEqual({ error: 'on cannot be in the future' })
    expect(await marks()).toStrictEqual([])

    const today = await cancel({
      scope: 'personal',
      merchantKey: STREAM,
      on: '2026-10-28',
    })
    expect(today.status).toBe(200)
    expect(today.body.cancelledOn).toBe('2026-10-28')
  })

  it('POST /uncancel: an on key is not allowed', async () => {
    await seed()

    const res = await uncancel({
      scope: 'personal',
      merchantKey: STREAM,
      on: '2026-10-01',
    })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Invalid body' })
  })

  it.each(WRITES)(
    '%s: a JSON null body is the server’s own 400',
    async (name) => {
      const res = await URLS[name]({ 'Content-Type': 'application/json' }).send(
        'null',
      )

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'Bad request' })
    },
  )

  it.each(WRITES)(
    '%s: no body at all names the missing scope',
    async (name) => {
      const res = await URLS[name]({})

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({
        error: 'scope must be personal or strawb',
      })
    },
  )
})

describe('writes: 404 for a merchant with no charge in that scope', () => {
  it.each(WRITES)('%s', async (_name, send, body) => {
    await seed()

    for (const target of [
      { merchantKey: 'm:merchant_fixture_nobody', scope: 'personal' },
      // Example Host is Strawb's.
      { merchantKey: HOST, scope: 'personal' },
      { merchantKey: STREAM, scope: 'strawb' },
    ]) {
      const res = await send({ ...body, ...target })
      expect([res.status, res.body], target.merchantKey).toStrictEqual([
        404,
        { error: 'Merchant not found' },
      ])
    }
    expect(await marks()).toStrictEqual([])
  })
})

describe('round trips', () => {
  it('Yes on a question lists it; clearing asks again; No moves a detected one out of the totals', async () => {
    await seed()

    const yes = await mark({
      scope: 'personal',
      merchantKey: CLOUD,
      answer: 'subscription',
    })
    expect(yes.status).toBe(200)
    expect(keys(yes.body)).toEqual(keys(MARK_RESPONSE_KEYS))
    expect(yes.body).toStrictEqual({
      scope: 'personal',
      merchantKey: CLOUD,
      answer: 'subscription',
      cancelledOn: null,
    })

    let body: SubscriptionsResponse = (await get('personal')).body
    expect(body.questions).toStrictEqual([])
    expect(
      body.subscriptions.map((r) => [r.merchantKey, r.marked, r.cadence]),
    ).toStrictEqual([
      [CLOUD, true, null],
      [STREAM, false, 'monthly'],
    ])
    expect(body.totals).toStrictEqual({
      perMonthCents: 1599,
      perYearCents: 19188,
      countedCount: 1,
      uncountedCount: 1,
      possiblyStoppedCount: 0,
    })

    await mark({ scope: 'personal', merchantKey: CLOUD, answer: null })
    body = (await get('personal')).body
    expect(body.questions).toStrictEqual([CLOUD_QUESTION])

    await mark({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'not_subscription',
    })
    body = (await get('personal')).body
    expect(body.subscriptions).toStrictEqual([])
    expect(body.notSubscriptions.map((r) => r.merchantKey)).toStrictEqual([
      STREAM,
    ])
    expect(body.totals).toStrictEqual({
      perMonthCents: 0,
      perYearCents: 0,
      countedCount: 0,
      uncountedCount: 0,
      possiblyStoppedCount: 0,
    })
  })

  it('cancel, a charge after it, and uncancel', async () => {
    await seed()

    const cancelled = await cancel({
      scope: 'personal',
      merchantKey: STREAM,
      on: '2026-09-01',
    })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: '2026-09-01',
    })

    let body: SubscriptionsResponse = (await get('personal')).body
    expect(
      body.subscriptions.map((r) => [
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
      ]),
    ).toStrictEqual([['cancelled', '2026-09-01', null]])
    expect(body.totals.countedCount).toBe(0)
    // The strawb row in `all` still counts.
    expect((await get('all')).body.totals.perMonthCents).toBe(4333)

    await connection('transactions').insert(
      tx(EVERYDAY, '2026-09-29T00:00:00.000Z', -1599),
    )
    body = (await get('personal')).body
    expect(
      body.subscriptions.map((r) => [r.status, r.chargedAgainOn]),
    ).toStrictEqual([['active', '2026-09-29']])
    expect(body.totals.perMonthCents).toBe(1599)

    const back = await uncancel({ scope: 'personal', merchantKey: STREAM })
    expect(back.body).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: null,
    })
    body = (await get('personal')).body
    expect(
      body.subscriptions.map((r) => [
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
      ]),
    ).toStrictEqual([['active', null, null]])
  })

  describe('one key in both scopes', () => {
    // Example Stream is also paid from the strawb account, on the same days.
    async function seedBoth() {
      await seed()
      await insertAll('transactions', [
        tx(TRADING, '2026-07-01T00:00:00.000Z', -1599),
        tx(TRADING, '2026-07-31T00:00:00.000Z', -1599),
        tx(TRADING, '2026-08-30T00:00:00.000Z', -1599),
      ])
    }
    const streamRows = (body: SubscriptionsResponse) =>
      body.subscriptions
        .filter((r) => r.merchantKey === STREAM)
        .map((r) => [r.scope, r.status, r.cancelledOn])
    const notSubscriptions = (body: SubscriptionsResponse) =>
      body.notSubscriptions.map((r) => [r.scope, r.merchantKey])

    it('a strawb cancel and a strawb No show under strawb and all, and never under personal', async () => {
      await seedBoth()

      const cancelled = await cancel({
        scope: 'strawb',
        merchantKey: STREAM,
        on: '2026-09-01',
      })
      expect(cancelled.status).toBe(200)
      expect(streamRows((await get('strawb')).body)).toStrictEqual([
        ['strawb', 'cancelled', '2026-09-01'],
      ])
      expect(streamRows((await get('all')).body)).toStrictEqual([
        ['personal', 'active', null],
        ['strawb', 'cancelled', '2026-09-01'],
      ])
      expect(streamRows((await get('personal')).body)).toStrictEqual([
        ['personal', 'active', null],
      ])

      const no = await mark({
        scope: 'strawb',
        merchantKey: STREAM,
        answer: 'not_subscription',
      })
      expect(no.status).toBe(200)
      expect(notSubscriptions((await get('strawb')).body)).toStrictEqual([
        ['strawb', STREAM],
      ])
      const all: SubscriptionsResponse = (await get('all')).body
      expect(notSubscriptions(all)).toStrictEqual([['strawb', STREAM]])
      expect(streamRows(all)).toStrictEqual([['personal', 'active', null]])
      expect(notSubscriptions((await get('personal')).body)).toStrictEqual([])
    })

    it('a personal uncancel and a cleared answer leave the strawb mark alone and answer with the personal one', async () => {
      await seedBoth()
      // Strawb first, so its row is the first for the key.
      await mark({
        scope: 'strawb',
        merchantKey: STREAM,
        answer: 'not_subscription',
      })
      await cancel({ scope: 'strawb', merchantKey: STREAM, on: '2026-09-15' })
      await mark({
        scope: 'personal',
        merchantKey: STREAM,
        answer: 'subscription',
      })
      await cancel({ scope: 'personal', merchantKey: STREAM, on: '2026-09-01' })
      const strawbRow = async () =>
        (await marks()).filter((m) => m.scope === 'strawb')
      const strawbBefore = await strawbRow()
      expect(
        strawbBefore.map((m) => [m.merchant_key, m.answer, m.cancelled_on]),
      ).toStrictEqual([[STREAM, 'not_subscription', '2026-09-15']])

      const back = await uncancel({ scope: 'personal', merchantKey: STREAM })
      expect(back.status).toBe(200)
      expect(back.body).toStrictEqual({
        scope: 'personal',
        merchantKey: STREAM,
        answer: 'subscription',
        cancelledOn: null,
      })
      expect(await strawbRow()).toStrictEqual(strawbBefore)

      const cleared = await mark({
        scope: 'personal',
        merchantKey: STREAM,
        answer: null,
      })
      expect(cleared.status).toBe(200)
      expect(cleared.body).toStrictEqual({
        scope: 'personal',
        merchantKey: STREAM,
        answer: null,
        cancelledOn: null,
      })
      expect(await strawbRow()).toStrictEqual(strawbBefore)
    })
  })

  it('cancel with no date records today in NZ', async () => {
    await seed()

    const res = await cancel({ scope: 'personal', merchantKey: STREAM })

    expect(res.body.cancelledOn).toBe('2026-10-28')
  })
})

describe('subscriptions never enter safe-to-spend, and nothing is called out', () => {
  it('marks and cancels leave every scope’s safe-to-spend as it was', async () => {
    await seed()
    const before: Record<string, unknown> = {}
    for (const scope of ['all', 'personal', 'strawb']) {
      const res = await api.get(`/api/v1/overview?scope=${scope}`)
      expect(res.status).toBe(200)
      before[scope] = res.body.safeToSpend
    }

    await mark({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'not_subscription',
    })
    await mark({
      scope: 'personal',
      merchantKey: CLOUD,
      answer: 'subscription',
    })
    await cancel({ scope: 'strawb', merchantKey: HOST })
    expect(await marks()).toHaveLength(3)

    for (const scope of ['all', 'personal', 'strawb']) {
      const res = await api.get(`/api/v1/overview?scope=${scope}`)
      expect(res.body.safeToSpend, scope).toStrictEqual(before[scope])
    }
  })

  it('no write calls fetch', async () => {
    await seed()
    const fetch = vi.spyOn(globalThis, 'fetch')

    expect(
      (
        await mark({
          scope: 'personal',
          merchantKey: STREAM,
          answer: 'subscription',
        })
      ).status,
    ).toBe(200)
    expect(
      (await cancel({ scope: 'personal', merchantKey: STREAM })).status,
    ).toBe(200)
    expect(
      (await uncancel({ scope: 'personal', merchantKey: STREAM })).status,
    ).toBe(200)

    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('errors are fixed text', () => {
  it('a transaction with a garbage date is a 500 that does not echo it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    await connection('transactions').insert(
      tx(EVERYDAY, 'garbage-date-sentinel', -100),
    )

    const res = await get('personal')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'a transaction is incomplete' })
    expect(res.text).not.toContain('garbage')
    expect(error.mock.calls).toStrictEqual([
      ['subscriptions: could not read subscriptions', 'SubscriptionsDataError'],
    ])

    const write = await mark({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'subscription',
    })
    expect(write.status).toBe(500)
    expect(write.body).toStrictEqual({ error: 'a transaction is incomplete' })
    expect(await marks()).toStrictEqual([])
  })

  it('an unreadable table is a 500 with a generic text, no SQL, table name or stack', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed()
    // Renamed and restored, never dropped.
    await connection.schema.renameTable(
      'subscription_marks',
      'subscription_marks_away',
    )
    try {
      const read = await get('all')
      const write = await mark({
        scope: 'personal',
        merchantKey: STREAM,
        answer: 'subscription',
      })

      expect([read.status, read.body]).toStrictEqual([
        500,
        { error: 'Could not read subscriptions' },
      ])
      expect([write.status, write.body]).toStrictEqual([
        500,
        { error: 'Could not save subscription' },
      ])
      for (const leak of [
        'SQLITE',
        'subscription_marks',
        'select',
        'insert',
        ' at ',
      ]) {
        expect(read.text).not.toContain(leak)
        expect(write.text).not.toContain(leak)
      }
      expect(error.mock.calls).toStrictEqual([
        ['subscriptions: could not read subscriptions', 'Error'],
        ['subscriptions: could not save subscription', 'Error'],
      ])
    } finally {
      await connection.schema.renameTable(
        'subscription_marks_away',
        'subscription_marks',
      )
    }
  })

  it.each([
    ['DELETE /mark', () => api.delete('/api/v1/subscriptions/mark')],
    ['GET /mark', () => api.get('/api/v1/subscriptions/mark')],
    ['POST /', () => api.post('/api/v1/subscriptions').send({})],
    ['PUT /cancel', () => api.put('/api/v1/subscriptions/cancel').send({})],
  ])('%s is the app’s JSON 404', async (_why, send) => {
    const res = await send()

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })
})

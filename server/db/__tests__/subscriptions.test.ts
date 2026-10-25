import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import { columns, count } from './schemaInfo.ts'
import type {
  RowScope,
  SubscriptionMarkResponse,
} from '../../../shared/contracts.ts'
import {
  SubscriptionsDataError,
  cancelSubscription,
  readSubscriptions,
  setAnswer,
  uncancelSubscription,
  type SubscriptionMarkRow,
} from '../subscriptions.ts'

// The subscriptions data module (prd-02 Ruling 14, issue #229), against a
// fresh in-memory database. Every value below is invented. The clock is
// passed in: 23:30 UTC on 27 October 2026 is 12:30 NZDT on the 28th.

const NOW = new Date('2026-10-27T23:30:00Z')
const LATER = new Date('2026-10-28T02:00:00Z')
const STAMP = '2026-10-20T00:00:00.000Z'

type Row = Record<string, unknown>

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await connection.destroy()
})

// A copy of the account/transaction builders in
// server/routes/__tests__/overview.test.ts and its siblings.
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
  date: string | null,
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

const EVERYDAY = 'acc_sentinel_everyday'
const TRADING = 'acc_sentinel_trading'
const STREAM = 'm:merchant_fixture_stream'
const CLOUD = 'm:merchant_fixture_cloud'

// Noon NZST on each day: the NZ date is the UTC date.
const MONTHLY = [
  '2026-07-01T00:00:00.000Z',
  '2026-07-31T00:00:00.000Z',
  '2026-08-30T00:00:00.000Z',
]

async function seedAccounts() {
  for (const row of [
    account({
      id: 1,
      akahu_id: EVERYDAY,
      name: 'Sentinel Everyday',
      scope: 'personal',
    }),
    account({
      id: 2,
      akahu_id: TRADING,
      name: 'Sentinel Trading',
      scope: 'strawb',
    }),
    account({
      id: 3,
      akahu_id: null,
      source: 'xero',
      name: 'Xero ledger',
      scope: 'strawb',
    }),
  ]) {
    await connection('accounts').insert(row)
  }
}

async function insertTxs(rows: Row[]) {
  // One insert per row: a multi-row insert binds NULL for a key a row
  // leaves out, which would skip the column defaults.
  for (const row of rows) await connection('transactions').insert(row)
}

async function seedStream(accountId = EVERYDAY, fields: Row = {}) {
  await insertTxs(MONTHLY.map((date) => tx(accountId, date, -1599, fields)))
}

// A hint name with one charge: a question.
async function seedCloudQuestion(accountId = EVERYDAY) {
  await insertTxs([
    tx(accountId, '2026-10-01T00:00:00.000Z', -299, {
      merchant_id: 'merchant_fixture_cloud',
      merchant_name: 'Example Cloud Storage',
      description: 'EXAMPLE CLOUD',
    }),
  ])
}

const marks = (): Promise<SubscriptionMarkRow[]> =>
  connection('subscription_marks').orderBy('id')

const MARK_ROW_KEYS: Record<keyof SubscriptionMarkRow, true> = {
  id: true,
  scope: true,
  merchant_key: true,
  answer: true,
  cancelled_on: true,
  created_at: true,
  updated_at: true,
}
const MARK_RESPONSE_KEYS: Record<keyof SubscriptionMarkResponse, true> = {
  scope: true,
  merchantKey: true,
  answer: true,
  cancelledOn: true,
}
const keys = (o: object) => Object.keys(o).sort()

describe('SubscriptionMarkRow', () => {
  it('names exactly the columns of subscription_marks', async () => {
    expect((await columns(connection, 'subscription_marks')).sort()).toEqual(
      keys(MARK_ROW_KEYS),
    )
  })
})

describe('readSubscriptions: what is read', () => {
  it('three settled monthly Akahu outflows are a subscription, as the shared module returns it', async () => {
    await seedAccounts()
    await seedStream()

    expect(await readSubscriptions('personal')).toStrictEqual({
      subscriptions: [
        {
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
          perYearCents: 19188,
        },
      ],
      questions: [],
      notSubscriptions: [],
      totals: {
        perMonthCents: 1599,
        perYearCents: 19188,
        countedCount: 1,
        uncountedCount: 0,
      },
    })
  })

  it.each<[string, Row, string]>([
    ['a Xero row', { source: 'xero' }, EVERYDAY],
    ['a pending row', { status: 'pending' }, EVERYDAY],
    ['an account that is not stored', {}, 'acc_nobody'],
  ])('%s is never read', async (_why, fields, accountId) => {
    await seedAccounts()
    await seedStream(accountId, fields)

    expect((await readSubscriptions('all')).subscriptions).toStrictEqual([])
  })

  it('an inflow is never read', async () => {
    await seedAccounts()
    await insertTxs(MONTHLY.map((date) => tx(EVERYDAY, date, 1599)))

    expect((await readSubscriptions('all')).subscriptions).toStrictEqual([])
  })

  it('dates are NZ calendar dates, whatever form the instant is stored in', async () => {
    await seedAccounts()
    await insertTxs([
      // 20:00 UTC is 08:00 NZST the next day.
      tx(EVERYDAY, '2026-08-05T20:00:00Z', -1599),
      // NZ midnight written with its offset.
      tx(EVERYDAY, '2026-09-05T00:00:00+12:00', -1599),
      // 20:00 UTC on 5 October is 09:00 NZDT on the 6th.
      tx(EVERYDAY, '2026-10-05T20:00:00.000Z', -1599),
    ])

    const [row] = (await readSubscriptions('personal')).subscriptions
    // Gaps 30 (08-06 to 09-05) and 31 (09-05 to 10-06).
    expect([row.lastChargedOn, row.cadence]).toStrictEqual([
      '2026-10-06',
      'monthly',
    ])
  })

  it.each([
    ['a null date', null],
    ['a garbage date', 'garbage-date-sentinel'],
  ])('%s is a fixed-text error', async (_why, date) => {
    await seedAccounts()
    await seedStream()
    await insertTxs([tx(EVERYDAY, date, -100)])

    const read = readSubscriptions('personal')
    await expect(read).rejects.toThrow(SubscriptionsDataError)
    await expect(readSubscriptions('personal')).rejects.toThrow(
      /^a transaction is incomplete$/,
    )
  })

  it('a stored amount that is not whole cents is a fixed-text error, not the value', async () => {
    await seedAccounts()
    await insertTxs([tx(EVERYDAY, MONTHLY[0], -15.5)])

    await expect(readSubscriptions('personal')).rejects.toThrow(
      SubscriptionsDataError,
    )
    await expect(readSubscriptions('personal')).rejects.toThrow(
      /^subscription input invalid$/,
    )
  })
})

describe('readSubscriptions: scope', () => {
  beforeEach(async () => {
    await seedAccounts()
    await seedStream(EVERYDAY)
    await insertTxs(
      [
        '2026-10-05T00:00:00.000Z',
        '2026-10-12T00:00:00.000Z',
        '2026-10-19T00:00:00.000Z',
      ].map((date) =>
        tx(TRADING, date, -1000, {
          merchant_id: 'merchant_fixture_host',
          merchant_name: 'Example Host',
        }),
      ),
    )
  })

  it('personal shows no strawb merchant', async () => {
    expect(
      (await readSubscriptions('personal')).subscriptions.map((r) => [
        r.scope,
        r.name,
      ]),
    ).toStrictEqual([['personal', 'Example Stream']])
  })

  it('strawb shows no personal merchant', async () => {
    expect(
      (await readSubscriptions('strawb')).subscriptions.map((r) => [
        r.scope,
        r.name,
      ]),
    ).toStrictEqual([['strawb', 'Example Host']])
  })

  it('all shows both', async () => {
    expect(
      (await readSubscriptions('all')).subscriptions.map((r) => [
        r.scope,
        r.name,
      ]),
    ).toStrictEqual([
      ['strawb', 'Example Host'],
      ['personal', 'Example Stream'],
    ])
  })
})

// Regression (#264, before drawings): a recurring Strawb outflow that has no
// personal inflow of the same amount beside it is an ordinary charge, and is
// detected as a subscription exactly as any other.
describe('readSubscriptions: a recurring strawb outflow (#264 regression)', () => {
  const payee = {
    merchant_id: 'merchant_fixture_payee',
    merchant_name: 'Example Payee',
    description: 'EXAMPLE PAYEE 7731',
  }
  // The day after each MONTHLY charge, at noon NZST.
  const NEXT_DAYS = [
    '2026-07-02T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
    '2026-08-31T00:00:00.000Z',
  ]

  it.each<[string, Row[]]>([
    ['with no personal inflow at all', []],
    [
      'with a personal inflow 1 cent short the next day',
      NEXT_DAYS.map((date) => tx(EVERYDAY, date, 29999)),
    ],
    [
      'with an equal inflow the next day on another strawb account',
      NEXT_DAYS.map((date) => tx('acc_sentinel_spot', date, 30000)),
    ],
  ])('is detected %s', async (_why, partners) => {
    await seedAccounts()
    await connection('accounts').insert(
      account({
        id: 4,
        akahu_id: 'acc_sentinel_spot',
        name: 'Sentinel Strawb pot',
        scope: 'strawb',
      }),
    )
    await insertTxs([
      ...MONTHLY.map((date) => tx(TRADING, date, -30000, payee)),
      ...partners,
    ])

    const { subscriptions } = await readSubscriptions('strawb')

    expect(
      subscriptions.map((r) => [
        r.scope,
        r.merchantKey,
        r.name,
        r.chargeCount,
        r.amountCents,
        r.cadence,
        r.detected,
        r.status,
      ]),
    ).toStrictEqual([
      [
        'strawb',
        'm:merchant_fixture_payee',
        'Example Payee',
        3,
        30000,
        'monthly',
        true,
        'active',
      ],
    ])
  })
})

// Drawings (prd-02 Ruling 15, issue #264): the regression block above with
// an equal personal inflow the day after each charge. Every charge is a half
// of a drawing, so nothing is detected, and no mark can be written for it.
describe('readSubscriptions: drawings (prd-02 Ruling 15)', () => {
  const payee = {
    merchant_id: 'merchant_fixture_payee',
    merchant_name: 'Example Payee',
    description: 'EXAMPLE PAYEE 7731',
  }
  const NEXT_DAYS = [
    '2026-07-02T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
    '2026-08-31T00:00:00.000Z',
  ]

  async function seedDrawings(chargeFields: Record<string, unknown> = {}) {
    await seedAccounts()
    await insertTxs([
      ...MONTHLY.map((date) =>
        tx(TRADING, date, -30000, { ...payee, ...chargeFields }),
      ),
      ...NEXT_DAYS.map((date) => tx(EVERYDAY, date, 30000)),
    ])
  }

  it('a monthly strawb outflow paired with equal personal inflows is not a subscription (DW2)', async () => {
    await seedDrawings()
    for (const scope of ['all', 'strawb'] as const) {
      const result = await readSubscriptions(scope)
      expect(result.subscriptions, scope).toStrictEqual([])
      expect(result.questions, scope).toStrictEqual([])
    }
    expect(
      await setAnswer(
        { scope: 'strawb', merchantKey: 'm:merchant_fixture_payee' },
        'subscription',
      ),
    ).toBe('not_found')
    expect(await connection('subscription_marks').select()).toStrictEqual([])
  })

  it('charges Hannah categorised by hand are detected again (DW4)', async () => {
    await seedDrawings({
      category: 'Business software and cloud services',
      category_source: 'user',
    })
    const { subscriptions } = await readSubscriptions('strawb')
    expect(
      subscriptions.map((r) => [r.merchantKey, r.chargeCount]),
    ).toStrictEqual([['m:merchant_fixture_payee', 3]])
  })
})

describe('her mark wins after the next sync', () => {
  it('a detected merchant marked No stays No when every row is replaced and a fourth charge lands', async () => {
    await seedAccounts()
    await seedStream()
    expect(
      await setAnswer(
        { scope: 'personal', merchantKey: STREAM },
        'not_subscription',
        NOW,
      ),
    ).not.toBe('not_found')

    const idsBefore = await connection('transactions').orderBy('id').pluck('id')
    await connection('transactions').del()
    await seedStream()
    await insertTxs([tx(EVERYDAY, '2026-09-29T00:00:00.000Z', -1599)])
    const idsAfter = await connection('transactions').orderBy('id').pluck('id')
    expect(idsAfter.some((id) => idsBefore.includes(id))).toBe(false)

    const result = await readSubscriptions('personal')
    expect(result.subscriptions).toStrictEqual([])
    expect(
      result.notSubscriptions.map((r) => [r.merchantKey, r.chargeCount]),
    ).toStrictEqual([[STREAM, 4]])
  })

  it('a one-charge merchant marked Yes is still listed, with no cadence, after its row is replaced', async () => {
    await seedAccounts()
    await seedCloudQuestion()
    await setAnswer(
      { scope: 'personal', merchantKey: CLOUD },
      'subscription',
      NOW,
    )

    await connection('transactions').del()
    await seedCloudQuestion()

    const result = await readSubscriptions('personal')
    expect(result.questions).toStrictEqual([])
    expect(
      result.subscriptions.map((r) => [r.merchantKey, r.cadence, r.marked]),
    ).toStrictEqual([[CLOUD, null, true]])
    expect(result.totals.uncountedCount).toBe(1)
  })
})

describe('writes', () => {
  beforeEach(async () => {
    await seedAccounts()
    await seedStream()
  })

  type Target = { scope: RowScope; merchantKey: string }
  const target: Target = { scope: 'personal', merchantKey: STREAM }

  it.each([
    ['setAnswer', (t: Target) => setAnswer(t, 'subscription', NOW)],
    [
      'cancelSubscription',
      (t: Target) => cancelSubscription(t, undefined, NOW),
    ],
    ['uncancelSubscription', (t: Target) => uncancelSubscription(t, NOW)],
  ])(
    '%s: an unknown key, a key only the other scope has, or one only a pending row or an inflow makes, is not_found and writes nothing',
    async (_why, write) => {
      expect(
        await write({
          scope: 'personal',
          merchantKey: 'm:merchant_fixture_nobody',
        }),
      ).toBe('not_found')
      expect(await write({ scope: 'strawb', merchantKey: STREAM })).toBe(
        'not_found',
      )
      // A key that only a pending row would make.
      await insertTxs([
        tx(EVERYDAY, MONTHLY[0], -100, {
          merchant_id: 'merchant_fixture_pending',
          status: 'pending',
        }),
      ])
      expect(
        await write({
          scope: 'personal',
          merchantKey: 'm:merchant_fixture_pending',
        }),
      ).toBe('not_found')
      // A key that only an inflow makes.
      await insertTxs([
        tx(EVERYDAY, MONTHLY[0], 500, {
          merchant_id: 'merchant_fixture_refund',
        }),
      ])
      expect(
        await write({
          scope: 'personal',
          merchantKey: 'm:merchant_fixture_refund',
        }),
      ).toBe('not_found')
      expect(await marks()).toStrictEqual([])
    },
  )

  it('setAnswer stores her answer and answers what is stored', async () => {
    const res = await setAnswer(target, 'subscription', NOW)

    expect(res).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'subscription',
      cancelledOn: null,
    })
    expect(keys(res as object)).toEqual(keys(MARK_RESPONSE_KEYS))
    const rows = await marks()
    expect(rows).toStrictEqual([
      {
        id: 1,
        scope: 'personal',
        merchant_key: STREAM,
        answer: 'subscription',
        cancelled_on: null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    ])
    expect(keys(rows[0])).toEqual(keys(MARK_ROW_KEYS))
  })

  it('a second setAnswer updates the one row in place: created_at kept, updated_at moved', async () => {
    await setAnswer(target, 'subscription', NOW)
    await setAnswer(target, 'not_subscription', LATER)

    expect(await marks()).toStrictEqual([
      {
        id: 1,
        scope: 'personal',
        merchant_key: STREAM,
        answer: 'not_subscription',
        cancelled_on: null,
        created_at: NOW.toISOString(),
        updated_at: LATER.toISOString(),
      },
    ])
  })

  it('setAnswer(null) on a merchant with no row creates nothing', async () => {
    expect(await setAnswer(target, null, NOW)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: null,
    })
    expect(await count(connection, 'subscription_marks')).toBe(0)
  })

  it('setAnswer(null) clears her answer and keeps the cancel date', async () => {
    await setAnswer(target, 'subscription', NOW)
    await cancelSubscription(target, '2026-10-01', NOW)

    expect(await setAnswer(target, null, LATER)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: '2026-10-01',
    })
  })

  it('cancel keeps her answer; a later answer keeps the cancel date', async () => {
    await setAnswer(target, 'subscription', NOW)
    expect(await cancelSubscription(target, '2026-10-01', NOW)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'subscription',
      cancelledOn: '2026-10-01',
    })
    expect(await setAnswer(target, 'not_subscription', LATER)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'not_subscription',
      cancelledOn: '2026-10-01',
    })
    expect(await count(connection, 'subscription_marks')).toBe(1)
  })

  it('cancel with no date records today in NZ, not in UTC', async () => {
    // 23:30 UTC on the 27th is the 28th in NZ.
    expect(await cancelSubscription(target, undefined, NOW)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: '2026-10-28',
    })
  })

  it('cancel on today in NZ is accepted; tomorrow is future_date and writes nothing', async () => {
    expect(await cancelSubscription(target, '2026-10-29', NOW)).toBe(
      'future_date',
    )
    expect(await count(connection, 'subscription_marks')).toBe(0)

    expect(await cancelSubscription(target, '2026-10-28', NOW)).not.toBe(
      'future_date',
    )
    expect((await marks()).map((r) => r.cancelled_on)).toStrictEqual([
      '2026-10-28',
    ])
  })

  it('cancelling again moves the date', async () => {
    await cancelSubscription(target, '2026-09-01', NOW)
    await cancelSubscription(target, '2026-10-01', LATER)

    expect(
      (await marks()).map((r) => [r.cancelled_on, r.created_at, r.updated_at]),
    ).toStrictEqual([['2026-10-01', NOW.toISOString(), LATER.toISOString()]])
  })

  it('a date that is not a real date is refused with a fixed text', async () => {
    await expect(cancelSubscription(target, '2026-02-30', NOW)).rejects.toThrow(
      /^subscription input invalid$/,
    )
    expect(await count(connection, 'subscription_marks')).toBe(0)
  })

  it('uncancel clears the date, keeps her answer, and never creates a row', async () => {
    expect(await uncancelSubscription(target, NOW)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: null,
    })
    expect(await count(connection, 'subscription_marks')).toBe(0)

    await setAnswer(target, 'subscription', NOW)
    await cancelSubscription(target, '2026-10-01', NOW)
    expect(await uncancelSubscription(target, LATER)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'subscription',
      cancelledOn: null,
    })
  })

  it('cancelled, then charged again, then uncancelled, end to end', async () => {
    await cancelSubscription(target, '2026-08-31', NOW)
    expect(
      (await readSubscriptions('personal')).subscriptions.map((r) => [
        r.status,
        r.chargedAgainOn,
      ]),
    ).toStrictEqual([['cancelled', null]])
    expect((await readSubscriptions('personal')).totals.countedCount).toBe(0)

    await insertTxs([tx(EVERYDAY, '2026-09-29T00:00:00.000Z', -1599)])
    expect(
      (await readSubscriptions('personal')).subscriptions.map((r) => [
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
      ]),
    ).toStrictEqual([['active', '2026-08-31', '2026-09-29']])

    await uncancelSubscription(target, LATER)
    expect(
      (await readSubscriptions('personal')).subscriptions.map((r) => [
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
      ]),
    ).toStrictEqual([['active', null, null]])
  })

  it('a charge-again off the cadence after a cancel shows as charged again; uncancelled, the merchant is no longer detected', async () => {
    await cancelSubscription(target, '2026-09-01', NOW)
    // 51 days after the last charge: no band.
    await insertTxs([tx(EVERYDAY, '2026-10-20T00:00:00.000Z', -1799)])

    const read = await readSubscriptions('personal')
    expect(
      read.subscriptions.map((r) => [
        r.merchantKey,
        r.status,
        r.cadence,
        r.cancelledOn,
        r.chargedAgainOn,
        r.perMonthCents,
      ]),
    ).toStrictEqual([
      [STREAM, 'active', 'monthly', '2026-09-01', '2026-10-20', 1799],
    ])
    expect(read.totals.perMonthCents).toBe(1799)

    await uncancelSubscription(target, LATER)
    expect((await readSubscriptions('personal')).subscriptions).toStrictEqual(
      [],
    )
  })

  it('a cancel on a long description key with letters beyond U+FFFF is read back', async () => {
    // The key is cut to fit the column; a cut inside a surrogate pair was
    // stored as U+FFFD and the read then matched no mark.
    await seedStream(EVERYDAY, {
      merchant_id: null,
      description: `${'a'.repeat(252)}${'\u{1D400}'.repeat(5)}`,
    })
    const sent = (await readSubscriptions('personal')).subscriptions.find((r) =>
      r.merchantKey.startsWith('d:'),
    )?.merchantKey
    expect(sent).toBe(`d:${'a'.repeat(252)}`)
    const longTarget = { scope: 'personal' as const, merchantKey: sent ?? '' }
    await cancelSubscription(longTarget, '2026-09-01', NOW)

    expect((await marks()).map((m) => m.merchant_key)).toContain(sent)
    expect(
      (await readSubscriptions('personal')).subscriptions
        .filter((r) => r.merchantKey === sent)
        .map((r) => [r.status, r.cancelledOn]),
    ).toStrictEqual([['cancelled', '2026-09-01']])
  })

  it('a write in one scope never marks the same key in the other', async () => {
    await seedStream(TRADING)
    await setAnswer(target, 'not_subscription', NOW)

    expect(
      (await readSubscriptions('strawb')).subscriptions.map(
        (r) => r.merchantKey,
      ),
    ).toStrictEqual([STREAM])
    expect((await readSubscriptions('personal')).subscriptions).toStrictEqual(
      [],
    )
  })

  it('uncancel and a null answer in one scope change only that scope’s row and answer with it', async () => {
    await seedStream(TRADING)
    const strawbTarget: Target = { scope: 'strawb', merchantKey: STREAM }
    // The strawb row is written first, so it is the first row for the key.
    await setAnswer(strawbTarget, 'not_subscription', NOW)
    await cancelSubscription(strawbTarget, '2026-09-15', NOW)
    await setAnswer(target, 'subscription', NOW)
    await cancelSubscription(target, '2026-09-01', NOW)
    const strawbRow = async () =>
      (await marks()).filter((m) => m.scope === 'strawb')
    const strawbBefore = await strawbRow()
    expect(
      strawbBefore.map((m) => [m.merchant_key, m.answer, m.cancelled_on]),
    ).toStrictEqual([[STREAM, 'not_subscription', '2026-09-15']])

    expect(await uncancelSubscription(target, LATER)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: 'subscription',
      cancelledOn: null,
    })
    expect(await strawbRow()).toStrictEqual(strawbBefore)

    expect(await setAnswer(target, null, LATER)).toStrictEqual({
      scope: 'personal',
      merchantKey: STREAM,
      answer: null,
      cancelledOn: null,
    })
    expect(await strawbRow()).toStrictEqual(strawbBefore)

    // The strawb read is unchanged too.
    expect(
      (await readSubscriptions('strawb')).notSubscriptions.map((r) => [
        r.scope,
        r.merchantKey,
      ]),
    ).toStrictEqual([['strawb', STREAM]])
  })

  it('no write calls anything outbound', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')

    await setAnswer(target, 'subscription', NOW)
    await cancelSubscription(target, undefined, NOW)
    await uncancelSubscription(target, NOW)
    await setAnswer(target, null, NOW)
    await readSubscriptions('all')

    expect(fetch).not.toHaveBeenCalled()
  })
})

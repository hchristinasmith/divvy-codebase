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
import * as drawings from '../drawings.ts'

// The real drawing loader, behind a spy, so a test can make it throw what
// the shared matcher throws.
vi.mock('../drawings.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../drawings.ts')>()
  return { ...real, loadDrawingIds: vi.fn(real.loadDrawingIds) }
})

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

  it.each([
    ['a RangeError', new RangeError('candidate 7 appears twice')],
    [
      'a TypeError',
      new TypeError(
        'amountCents of candidate 7 must be an integer number of cents, got 1.5',
      ),
    ],
  ])(
    'the drawing matcher throwing %s is a fixed-text error, not its message',
    async (_why, thrown) => {
      await seedAccounts()
      await seedStream()
      vi.mocked(drawings.loadDrawingIds).mockClear()
      vi.mocked(drawings.loadDrawingIds).mockRejectedValueOnce(thrown)

      const err: unknown = await readSubscriptions('personal').then(
        () => undefined,
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(SubscriptionsDataError)
      expect((err as Error).message).toMatch(/^subscription input invalid$/)
      expect(vi.mocked(drawings.loadDrawingIds)).toHaveBeenCalledTimes(1)
    },
  )
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

// Written before the detector changes (#391), green on the all-history rule
// as it is today. What the change must NOT alter: a merchant detected today
// keeps its bare key end to end, a mark written on that key is read back on
// that row, and a key that is no merchant in the scope is still not_found.
describe('#391 regression: what detection today must keep', () => {
  type Target = { scope: RowScope; merchantKey: string }
  const target: Target = { scope: 'personal', merchantKey: STREAM }

  const BISTRO_KEY = 'm:merchant_fixture_bistro'
  const bistro = {
    merchant_id: 'merchant_fixture_bistro',
    merchant_name: 'Example Bistro',
    description: 'EXAMPLE BISTRO 2210 AKL',
  }
  const VISIT_AMOUNTS = [1850, 4200, 2900, 3600, 2200, 4500, 3100, 2750]
  // Noon NZST on each day (June and July are NZST). Gaps 8, 6, 6, 8, 8, 6, 7.
  const VISIT_DAYS = [
    '2026-06-01',
    '2026-06-09',
    '2026-06-15',
    '2026-06-21',
    '2026-06-29',
    '2026-07-07',
    '2026-07-13',
    '2026-07-20',
  ]
  // Gaps 8, 6, 6, 16, 8, 6, 7: one skipped week.
  const SKIPPED_DAYS = [
    '2026-06-01',
    '2026-06-09',
    '2026-06-15',
    '2026-06-21',
    '2026-07-07',
    '2026-07-15',
    '2026-07-21',
    '2026-07-28',
  ]
  const seedVisits = (days: readonly string[]) =>
    insertTxs(
      days.map((day, i) =>
        tx(EVERYDAY, `${day}T00:00:00.000Z`, -VISIT_AMOUNTS[i], bistro),
      ),
    )

  describe('a detected merchant keeps its bare key through the read', () => {
    beforeEach(async () => {
      await seedAccounts()
    })

    it('three monthly charges are one row keyed m:<merchant id>', async () => {
      await seedStream()

      const result = await readSubscriptions('personal')

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_stream',
      ])
      expect(result.subscriptions).toHaveLength(1)
      expect(keys(result.subscriptions[0])).toEqual(
        [
          'merchantKey',
          'scope',
          'name',
          'chargeCount',
          'lastChargedOn',
          'amountCents',
          'cadence',
          'detected',
          'marked',
          'status',
          'cancelledOn',
          'chargedAgainOn',
          'perMonthCents',
          'perYearCents',
        ].sort(),
      )
    })

    it('a price change on regular gaps is still one row at the latest price', async () => {
      // Gaps 30, 31, 30; prices 1299, 1299, 1499, 1799.
      await insertTxs([
        tx(EVERYDAY, '2026-05-01T00:00:00.000Z', -1299),
        tx(EVERYDAY, '2026-05-31T00:00:00.000Z', -1299),
        tx(EVERYDAY, '2026-07-01T00:00:00.000Z', -1499),
        tx(EVERYDAY, '2026-07-31T00:00:00.000Z', -1799),
      ])

      const result = await readSubscriptions('personal')

      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.chargeCount,
          r.amountCents,
          r.cadence,
          r.perMonthCents,
          r.perYearCents,
        ]),
      ).toStrictEqual([[STREAM, 4, 1799, 'monthly', 1799, 21588]])
    })

    it('#393 baseline: eight weekly visits at varying prices are one weekly row with the bare key', async () => {
      await seedVisits(VISIT_DAYS)

      const result = await readSubscriptions('personal')

      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: BISTRO_KEY,
          scope: 'personal',
          name: 'Example Bistro',
          chargeCount: 8,
          lastChargedOn: '2026-07-20',
          amountCents: 2750,
          cadence: 'weekly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          // 2750 × 52 = 143000; ÷ 12 = 11916.67 → 11917; × 12 = 143004.
          perMonthCents: 11917,
          perYearCents: 143004,
        },
      ])
      expect(result.totals).toStrictEqual({
        perMonthCents: 11917,
        perYearCents: 143004,
        countedCount: 1,
        uncountedCount: 0,
      })
    })

    it('#393 baseline: the same visits with one skipped week are not detected', async () => {
      await seedVisits(SKIPPED_DAYS)

      expect((await readSubscriptions('personal')).subscriptions).toStrictEqual(
        [],
      )
    })
  })

  describe('a mark on the bare key of a detected merchant is read back on its row', () => {
    beforeEach(async () => {
      await seedAccounts()
      await seedStream()
    })

    it('Yes: stored under the bare key, and the one row is marked', async () => {
      await setAnswer(target, 'subscription', NOW)

      expect(
        (await marks()).map((m) => [m.scope, m.merchant_key, m.answer]),
      ).toStrictEqual([
        ['personal', 'm:merchant_fixture_stream', 'subscription'],
      ])
      expect(
        (await readSubscriptions('personal')).subscriptions.map((r) => [
          r.merchantKey,
          r.detected,
          r.marked,
          r.status,
        ]),
      ).toStrictEqual([['m:merchant_fixture_stream', true, true, 'active']])
    })

    it('No: the merchant leaves subscriptions and shows under notSubscriptions with the bare key', async () => {
      await setAnswer(target, 'not_subscription', NOW)

      const result = await readSubscriptions('personal')

      expect(result.subscriptions).toStrictEqual([])
      expect(result.notSubscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 3,
          lastChargedOn: '2026-08-30',
          amountCents: 1599,
        },
      ])
      expect(result.totals).toStrictEqual({
        perMonthCents: 0,
        perYearCents: 0,
        countedCount: 0,
        uncountedCount: 0,
      })
    })

    it('cancel: stored under the bare key, and the one row is cancelled on that date', async () => {
      await cancelSubscription(target, '2026-09-01', NOW)

      expect(
        (await marks()).map((m) => [m.scope, m.merchant_key, m.cancelled_on]),
      ).toStrictEqual([['personal', 'm:merchant_fixture_stream', '2026-09-01']])
      expect(
        (await readSubscriptions('personal')).subscriptions.map((r) => [
          r.merchantKey,
          r.status,
          r.cancelledOn,
          r.chargedAgainOn,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_stream', 'cancelled', '2026-09-01', null],
      ])
    })

    it('uncancel: the date is cleared on that same row', async () => {
      await cancelSubscription(target, '2026-09-01', NOW)
      await uncancelSubscription(target, LATER)

      expect(
        (await readSubscriptions('personal')).subscriptions.map((r) => [
          r.merchantKey,
          r.status,
          r.cancelledOn,
        ]),
      ).toStrictEqual([['m:merchant_fixture_stream', 'active', null]])
    })
  })

  describe('a key that is no merchant in the scope is not_found and writes nothing', () => {
    beforeEach(async () => {
      await seedAccounts()
      await seedStream()
    })

    const JUNK_KEYS = [
      'junk',
      'm:',
      'x:merchant_fixture_stream',
      'M:merchant_fixture_stream',
      'd:example stream',
      'm:merchant_fixture_stream ',
    ]

    it.each([
      ['setAnswer', (t: Target) => setAnswer(t, 'subscription', NOW)],
      [
        'cancelSubscription',
        (t: Target) => cancelSubscription(t, undefined, NOW),
      ],
      ['uncancelSubscription', (t: Target) => uncancelSubscription(t, NOW)],
    ])('%s: a junk key and an other-scope key', async (_why, write) => {
      for (const merchantKey of JUNK_KEYS) {
        expect(
          await write({ scope: 'personal', merchantKey }),
          merchantKey,
        ).toBe('not_found')
      }
      // STREAM has charges in personal only.
      expect(await write({ scope: 'strawb', merchantKey: STREAM })).toBe(
        'not_found',
      )
      expect(await marks()).toStrictEqual([])
      expect(
        (await readSubscriptions('personal')).subscriptions.map((r) => [
          r.merchantKey,
          r.marked,
          r.cancelledOn,
        ]),
      ).toStrictEqual([[STREAM, false, null]])
    })
  })
})

// #391: a merchant the all-history rule misses is read again as lanes, each
// its own subscription under its own key (prd-02 Ruling 16), and the writes
// accept exactly the keys the read lists. Every key below is worked by hand
// in shared/__tests__/subscriptions.test.ts (P1) and written as a literal.
describe('#391 lanes through the data module (prd-02 Ruling 16)', () => {
  type Target = { scope: RowScope; merchantKey: string }
  const TOOLS = 'm:merchant_fixture_tools'
  const LANE_2000 = 'm:merchant_fixture_tools#2026-01-01:2000'
  const LANE_4620 = 'm:merchant_fixture_tools#2026-01-01:4620'
  const tools = (day: string, cents: number) =>
    tx(EVERYDAY, `${day}T00:00:00.000Z`, -cents, {
      merchant_id: 'merchant_fixture_tools',
      merchant_name: 'Example Tools',
      description: 'EXAMPLE TOOLS 0001',
    })

  // P1: three subscriptions billed on the 1st, January to May, at 2000,
  // 2000 and 4620 in that row order, and a one-off on 17 March. Midnight
  // UTC is midday or later in NZ: the NZ date is the UTC date.
  async function seedTools() {
    const rows: Row[] = []
    for (const month of ['01', '02', '03', '04', '05']) {
      rows.push(
        tools(`2026-${month}-01`, 2000),
        tools(`2026-${month}-01`, 2000),
        tools(`2026-${month}-01`, 4620),
      )
    }
    rows.push(tools('2026-03-17', 1500))
    await insertTxs(rows)
  }

  const lanes = async () =>
    (await readSubscriptions('personal')).subscriptions.map((r) => [
      r.merchantKey,
      r.chargeCount,
      r.amountCents,
      r.marked,
      r.status,
      r.cancelledOn,
    ])

  beforeEach(async () => {
    await seedAccounts()
    await seedTools()
  })

  it('the read lists one row per lane, each under its own key', async () => {
    const result = await readSubscriptions('personal')

    expect(await lanes()).toStrictEqual([
      [TOOLS, 5, 2000, false, 'active', null],
      [LANE_2000, 5, 2000, false, 'active', null],
      [LANE_4620, 5, 4620, false, 'active', null],
    ])
    // 2000 + 2000 + 4620 = 8620; 12 × 8620 = 103440.
    expect(result.totals).toStrictEqual({
      perMonthCents: 8620,
      perYearCents: 103440,
      countedCount: 3,
      uncountedCount: 0,
    })
  })

  it('an answer on a lane key is stored under that key and read back on that lane only', async () => {
    const res = await setAnswer(
      { scope: 'personal', merchantKey: LANE_4620 },
      'not_subscription',
      NOW,
    )

    expect(res).toStrictEqual({
      scope: 'personal',
      merchantKey: LANE_4620,
      answer: 'not_subscription',
      cancelledOn: null,
    })
    expect(
      (await marks()).map((m) => [m.scope, m.merchant_key, m.answer]),
    ).toStrictEqual([['personal', LANE_4620, 'not_subscription']])
    const result = await readSubscriptions('personal')
    expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
      TOOLS,
      LANE_2000,
    ])
    expect(
      result.notSubscriptions.map((r) => [r.merchantKey, r.chargeCount]),
    ).toStrictEqual([[LANE_4620, 5]])

    await setAnswer({ scope: 'personal', merchantKey: LANE_4620 }, null, LATER)
    expect((await lanes()).map((r) => r[0])).toStrictEqual([
      TOOLS,
      LANE_2000,
      LANE_4620,
    ])
  })

  it('cancel and uncancel on a lane key round-trip on that lane only', async () => {
    const target = { scope: 'personal' as const, merchantKey: LANE_2000 }

    expect(await cancelSubscription(target, '2026-05-01', NOW)).toStrictEqual({
      scope: 'personal',
      merchantKey: LANE_2000,
      answer: null,
      cancelledOn: '2026-05-01',
    })
    expect(await lanes()).toStrictEqual([
      [TOOLS, 5, 2000, false, 'active', null],
      [LANE_2000, 5, 2000, false, 'cancelled', '2026-05-01'],
      [LANE_4620, 5, 4620, false, 'active', null],
    ])

    await uncancelSubscription(target, LATER)
    expect(await lanes()).toStrictEqual([
      [TOOLS, 5, 2000, false, 'active', null],
      [LANE_2000, 5, 2000, false, 'active', null],
      [LANE_4620, 5, 4620, false, 'active', null],
    ])
  })

  it.each([
    ['setAnswer', (t: Target) => setAnswer(t, 'subscription', NOW)],
    [
      'cancelSubscription',
      (t: Target) => cancelSubscription(t, undefined, NOW),
    ],
    ['uncancelSubscription', (t: Target) => uncancelSubscription(t, NOW)],
  ])(
    '%s: a well-formed lane key no lane has, or one from the other scope, is not_found and writes nothing',
    async (_why, write) => {
      for (const merchantKey of [
        'm:merchant_fixture_tools#2026-01-01:9999',
        'm:merchant_fixture_tools#2026-01-01:2000.3',
        'm:merchant_fixture_tools#2026-02-01:2000',
        'm:merchant_fixture_tools#2026-01-01:2000.2',
      ]) {
        expect(
          await write({ scope: 'personal', merchantKey }),
          merchantKey,
        ).toBe('not_found')
      }
      expect(await write({ scope: 'strawb', merchantKey: LANE_4620 })).toBe(
        'not_found',
      )
      expect(await marks()).toStrictEqual([])
    },
  )

  it('a lane-form key on a merchant the all-history rule detects is not_found', async () => {
    await seedStream()

    expect(
      await setAnswer(
        {
          scope: 'personal',
          merchantKey: 'm:merchant_fixture_stream#2026-07-01:1599',
        },
        'subscription',
        NOW,
      ),
    ).toBe('not_found')
    expect(await marks()).toStrictEqual([])
  })

  it('not_subscription on the bare key hides every lane, and a lane key is then not_found', async () => {
    await setAnswer(
      { scope: 'personal', merchantKey: TOOLS },
      'not_subscription',
      NOW,
    )

    const result = await readSubscriptions('personal')
    expect(result.subscriptions).toStrictEqual([])
    expect(
      result.notSubscriptions.map((r) => [r.merchantKey, r.chargeCount]),
    ).toStrictEqual([[TOOLS, 16]])
    expect(
      await cancelSubscription(
        { scope: 'personal', merchantKey: LANE_4620 },
        undefined,
        NOW,
      ),
    ).toBe('not_found')
    expect((await marks()).map((m) => m.merchant_key)).toStrictEqual([TOOLS])
  })

  // A on the 5th at 1000 and B on the 20th at 2500, both from the read's
  // own dealing (worked by hand in the shared test 'a stale lane’s key is
  // one only while a mark pins it'): A forms on 5 March and holds the bare
  // key; B, February to May, forms on 20 April under its lane key.
  it('a stale lane key is writable while a mark pins it, and not once nothing does', async () => {
    const APP = 'm:merchant_fixture_app'
    const B = 'm:merchant_fixture_app#2026-02-20:2500'
    const app = (day: string, cents: number) =>
      tx(EVERYDAY, `${day}T00:00:00.000Z`, -cents, {
        merchant_id: 'merchant_fixture_app',
        merchant_name: 'Example App',
        description: 'EXAMPLE APP 0001',
      })
    const appLanes = async () =>
      (await lanes()).filter((r) => String(r[0]).startsWith(APP))
    await insertTxs([
      ...['01', '02', '03', '04', '05'].map((m) => app(`2026-${m}-05`, 1000)),
      ...['02', '03', '04', '05'].map((m) => app(`2026-${m}-20`, 2500)),
    ])

    // On 20 May both are live and listed.
    expect(await appLanes()).toStrictEqual([
      [APP, 5, 1000, false, 'active', null],
      [B, 4, 2500, false, 'active', null],
    ])
    expect(
      await cancelSubscription(
        { scope: 'personal', merchantKey: B },
        '2026-05-21',
        NOW,
      ),
    ).toStrictEqual({
      scope: 'personal',
      merchantKey: B,
      answer: null,
      cancelledOn: '2026-05-21',
    })

    // A runs on to 5 October; B's last charge, 20 May, is then 138 days
    // back: stale, but the cancel pins it, so it stays listed and writable.
    await insertTxs(
      ['06', '07', '08', '09', '10'].map((m) => app(`2026-${m}-05`, 1000)),
    )
    expect(await appLanes()).toStrictEqual([
      [APP, 10, 1000, false, 'active', null],
      [B, 4, 2500, false, 'cancelled', '2026-05-21'],
    ])
    expect(
      await uncancelSubscription({ scope: 'personal', merchantKey: B }, LATER),
    ).toStrictEqual({
      scope: 'personal',
      merchantKey: B,
      answer: null,
      cancelledOn: null,
    })

    // Now nothing pins B: it is not listed, and a write to it is not_found.
    expect(await appLanes()).toStrictEqual([
      [APP, 10, 1000, false, 'active', null],
    ])
    expect(
      await cancelSubscription(
        { scope: 'personal', merchantKey: B },
        undefined,
        LATER,
      ),
    ).toBe('not_found')
    // A's own lane-form key was never a key: A holds the bare key.
    expect(
      await setAnswer(
        {
          scope: 'personal',
          merchantKey: 'm:merchant_fixture_app#2026-01-05:1000',
        },
        'subscription',
        LATER,
      ),
    ).toBe('not_found')
    expect(
      (await marks()).map((m) => [m.merchant_key, m.answer, m.cancelled_on]),
    ).toStrictEqual([[B, null, null]])
  })

  it('a lane key in the strawb scope is written there, marks that lane only, and leaves personal’s lane of the same key alone', async () => {
    // The same merchant and shape paid from the trading account: strawb
    // has its own three lanes under the same three keys.
    const rows: Row[] = []
    for (const month of ['01', '02', '03', '04', '05']) {
      for (const cents of [2000, 2000, 4620]) {
        rows.push({
          ...tools(`2026-${month}-01`, cents),
          account_id: TRADING,
        })
      }
    }
    rows.push({ ...tools('2026-03-17', 1500), account_id: TRADING })
    await insertTxs(rows)

    expect(
      await cancelSubscription(
        { scope: 'strawb', merchantKey: LANE_4620 },
        '2026-05-01',
        NOW,
      ),
    ).toStrictEqual({
      scope: 'strawb',
      merchantKey: LANE_4620,
      answer: null,
      cancelledOn: '2026-05-01',
    })
    expect(
      await setAnswer(
        { scope: 'strawb', merchantKey: LANE_2000 },
        'subscription',
        NOW,
      ),
    ).toStrictEqual({
      scope: 'strawb',
      merchantKey: LANE_2000,
      answer: 'subscription',
      cancelledOn: null,
    })

    expect(
      (await marks()).map((m) => [
        m.scope,
        m.merchant_key,
        m.answer,
        m.cancelled_on,
      ]),
    ).toStrictEqual([
      ['strawb', LANE_4620, null, '2026-05-01'],
      ['strawb', LANE_2000, 'subscription', null],
    ])
    const rowsOf = (result: Awaited<ReturnType<typeof readSubscriptions>>) =>
      result.subscriptions.map((r) => [r.merchantKey, r.marked, r.status])
    expect(rowsOf(await readSubscriptions('strawb'))).toStrictEqual([
      [TOOLS, false, 'active'],
      [LANE_2000, true, 'active'],
      [LANE_4620, false, 'cancelled'],
    ])
    expect(rowsOf(await readSubscriptions('personal'))).toStrictEqual([
      [TOOLS, false, 'active'],
      [LANE_2000, false, 'active'],
      [LANE_4620, false, 'active'],
    ])
  })

  it('a stored amount that is not whole cents makes a write a fixed-text error, not the value', async () => {
    await insertTxs([tx(EVERYDAY, MONTHLY[0], -15.5)])

    await expect(
      setAnswer({ scope: 'personal', merchantKey: TOOLS }, 'subscription', NOW),
    ).rejects.toThrow(SubscriptionsDataError)
    await expect(
      setAnswer({ scope: 'personal', merchantKey: TOOLS }, 'subscription', NOW),
    ).rejects.toThrow(/^subscription input invalid$/)
    expect(await marks()).toStrictEqual([])
  })
})

// A target whose scope is not one the shared module accepts (a caller bug:
// `all` is a view, never a row scope) reaches `chargeKeys`, which throws a
// RangeError naming the value. Every write turns it into the fixed text and
// writes nothing.
describe('writes: a scope the shared module refuses (#391)', () => {
  type Target = { scope: RowScope; merchantKey: string }
  const BAD_SCOPE: Target = {
    scope: 'all' as unknown as RowScope,
    merchantKey: STREAM,
  }

  beforeEach(async () => {
    await seedAccounts()
    await seedStream()
  })

  it.each([
    ['setAnswer', (t: Target) => setAnswer(t, 'subscription', NOW)],
    [
      'cancelSubscription',
      (t: Target) => cancelSubscription(t, undefined, NOW),
    ],
    ['uncancelSubscription', (t: Target) => uncancelSubscription(t, NOW)],
  ])(
    '%s: the fixed text, not the shared module’s message',
    async (_why, write) => {
      const err: unknown = await write(BAD_SCOPE).then(
        () => undefined,
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(SubscriptionsDataError)
      expect((err as Error).message).toBe('subscription input invalid')
      expect(await marks()).toStrictEqual([])
    },
  )
})

// Written before the "possibly stopped" flag (#392), green on main as it is
// today: `readSubscriptions` takes no clock, so an active subscription whose
// last charge is years before today is still counted in the totals. The
// build is meant to change this; its diff here is the change. Invented
// values only.
describe('before #392: readSubscriptions', () => {
  // 00:00 UTC is 13:00 NZDT or 12:00 NZST: the NZ date is the UTC date.
  // Gaps 30 and 30 (2023 has no 29 February).
  const OLD_MONTHLY = [
    '2023-01-10T00:00:00.000Z',
    '2023-02-09T00:00:00.000Z',
    '2023-03-11T00:00:00.000Z',
  ]

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a monthly subscription last charged in 2023 is active and counted in the totals (changes in #392)', async () => {
    await seedAccounts()
    await insertTxs(OLD_MONTHLY.map((date) => tx(EVERYDAY, date, -1599)))
    // Today is 28 October 2026 in NZ.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    const result = await readSubscriptions('personal')

    expect(result.subscriptions).toHaveLength(1)
    expect(keys(result.subscriptions[0])).toEqual(
      [
        'merchantKey',
        'scope',
        'name',
        'chargeCount',
        'lastChargedOn',
        'amountCents',
        'cadence',
        'detected',
        'marked',
        'status',
        'cancelledOn',
        'chargedAgainOn',
        'perMonthCents',
        'perYearCents',
      ].sort(),
    )
    expect(keys(result.totals)).toEqual(
      ['perMonthCents', 'perYearCents', 'countedCount', 'uncountedCount'].sort(),
    )
    expect(result).toStrictEqual({
      subscriptions: [
        {
          merchantKey: STREAM,
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 3,
          lastChargedOn: '2023-03-11',
          amountCents: 1599,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          perMonthCents: 1599,
          // 12 × 1599 = 19188
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
})

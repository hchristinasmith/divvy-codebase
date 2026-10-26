// Subscriptions (prd-02 Ruling 14, issue #229): detection, Hannah's marks,
// cancel and the integer-cent totals, all from `shared/subscriptions.ts`.
// Every expected figure is worked by hand in the comment beside it and
// written as a literal; none is computed by the code under test. Gaps were
// counted on a calendar. Merchants and amounts are invented.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RowScope,
  Scope,
  SubscriptionAnswer,
  SubscriptionMerchant,
  SubscriptionRow,
  SubscriptionsResponse,
  SubscriptionTotals,
} from '../contracts.ts'
import {
  CADENCE_BANDS,
  LANE_CADENCES,
  LANE_DEVIATION_SLACK_DAYS,
  LANE_KEY_HEADROOM,
  LANE_KEY_SEPARATOR,
  LANE_MAX_CONCURRENT,
  LANE_MAX_DEVIATION_DAYS,
  LANE_MAX_GAP_SPREAD_DAYS,
  LANE_MIN_CHARGES_SHARED,
  MAX_MERCHANT_KEY_LENGTH,
  MIN_CHARGES,
  MONTHLY_GAP_DAYS,
  MONTHLY_TOLERANCE_DAYS,
  MONTHS_PER_YEAR,
  SUBSCRIPTION_HINTS,
  UNNAMED_MERCHANT,
  WEEKLY_GAP_DAYS,
  WEEKLY_TOLERANCE_DAYS,
  WEEKS_PER_YEAR,
  YEARLY_GAP_DAYS,
  YEARLY_TOLERANCE_DAYS,
  chargeKeys,
  classifyGaps,
  isIsoDate,
  isMerchantKey,
  merchantKeyOf,
  nameLooksLikeSubscription,
  normaliseDescription,
  perMonthCents,
  roundHalfUpDiv,
  subscriptions,
  type SubscriptionMark,
  type SubscriptionTransaction,
} from '../subscriptions.ts'
import { daysBetween } from '../safe-to-spend.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STREAM_ID = 'merchant_fixture_stream'
const STREAM = `m:${STREAM_ID}`

function tx(
  fields: Partial<SubscriptionTransaction> = {},
): SubscriptionTransaction {
  return {
    scope: 'personal',
    status: 'settled',
    date: '2026-07-01',
    amountCents: -1599,
    merchantId: STREAM_ID,
    merchantName: 'Example Stream',
    description: 'EXAMPLE STREAM 4829 AKL',
    ...fields,
  }
}

function charges(
  dates: readonly string[],
  fields: Partial<SubscriptionTransaction> = {},
): SubscriptionTransaction[] {
  return dates.map((date) => tx({ date, ...fields }))
}

function mark(fields: Partial<SubscriptionMark> = {}): SubscriptionMark {
  return {
    scope: 'personal',
    merchantKey: STREAM,
    answer: null,
    cancelledOn: null,
    ...fields,
  }
}

function run(
  transactions: readonly SubscriptionTransaction[],
  marks: readonly SubscriptionMark[] = [],
  scope: Scope = 'personal',
): SubscriptionsResponse {
  return subscriptions({ scope, transactions, marks })
}

// Gaps 30 and 30.
const MONTHLY = ['2026-07-01', '2026-07-31', '2026-08-30']
// Gaps 7 and 7.
const WEEKLY = ['2026-08-03', '2026-08-10', '2026-08-17']
// Gaps 365 and 365: 29 Feb 2024 is before 1 Mar 2024.
const YEARLY = ['2024-03-01', '2025-03-01', '2026-03-01']

const NOTHING: SubscriptionsResponse = {
  subscriptions: [],
  questions: [],
  notSubscriptions: [],
  totals: {
    perMonthCents: 0,
    perYearCents: 0,
    countedCount: 0,
    uncountedCount: 0,
  },
}

// Key sets, tied to the contract types: TypeScript refuses a key the type
// lacks and requires every key it has.
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
}
const TOTAL_KEYS: Record<keyof SubscriptionTotals, true> = {
  perMonthCents: true,
  perYearCents: true,
  countedCount: true,
  uncountedCount: true,
}

const keys = (o: object) => Object.keys(o).sort()

/** Every number anywhere in a value. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value]
  if (Array.isArray(value)) return value.flatMap(numbersIn)
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(numbersIn)
  return []
}

/** Dates from `start` moved by each gap in turn (test arithmetic, in UTC). */
function datesWithGaps(start: string, gaps: readonly number[]): string[] {
  const out = [start]
  let t = Date.parse(`${start}T00:00:00Z`)
  for (const gap of gaps) {
    t += gap * 86_400_000
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants (prd-02 Ruling 14)', () => {
  it('are the Ruling’s numbers', () => {
    expect(MIN_CHARGES).toBe(3)
    expect([WEEKLY_GAP_DAYS, WEEKLY_TOLERANCE_DAYS]).toStrictEqual([7, 2])
    expect([MONTHLY_GAP_DAYS, MONTHLY_TOLERANCE_DAYS]).toStrictEqual([30, 4])
    expect([YEARLY_GAP_DAYS, YEARLY_TOLERANCE_DAYS]).toStrictEqual([365, 10])
    expect(CADENCE_BANDS).toStrictEqual([
      { cadence: 'weekly', days: 7, toleranceDays: 2 },
      { cadence: 'monthly', days: 30, toleranceDays: 4 },
      { cadence: 'yearly', days: 365, toleranceDays: 10 },
    ])
    expect([WEEKS_PER_YEAR, MONTHS_PER_YEAR]).toStrictEqual([52, 12])
    expect(MAX_MERCHANT_KEY_LENGTH).toBe(255)
    expect(UNNAMED_MERCHANT).toBe('Unnamed merchant')
  })

  it('the bands do not overlap', () => {
    const ranges = CADENCE_BANDS.map((b) => [
      b.days - b.toleranceDays,
      b.days + b.toleranceDays,
    ])
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1])
    }
  })

  it('the hint list is the shipped one', () => {
    expect(SUBSCRIPTION_HINTS).toStrictEqual([
      'subscription',
      'subscriptions',
      'membership',
      'memberships',
      'streaming',
      'software',
      'premium',
      'cloud',
      'hosting',
      'vpn',
      'newsletter',
      'magazine',
      'antivirus',
    ])
  })

  it('every hint is a lowercase single word that a normalised name can contain', () => {
    expect(new Set(SUBSCRIPTION_HINTS).size).toBe(SUBSCRIPTION_HINTS.length)
    for (const hint of SUBSCRIPTION_HINTS) {
      expect(hint).toBe(hint.trim().toLowerCase())
      expect(hint).not.toContain(' ')
      expect(normaliseDescription(hint)).toBe(hint)
    }
  })
})

// ---------------------------------------------------------------------------
// Merchant keys
// ---------------------------------------------------------------------------

describe('normaliseDescription and merchantKeyOf (a stored contract)', () => {
  it.each([
    ['  EXAMPLE Stream  4829 AKL ', 'example stream akl'],
    ['POS W/D EXAMPLE*CLOUD-12/10', 'pos w d example cloud'],
    ['1234 5678', ''],
    ['', ''],
    ['Café Ōtautahi #2', 'café ōtautahi'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(normaliseDescription(raw)).toBe(expected)
  })

  const LONG_ID = 'i'.repeat(254)
  const FITTING_ID = 'i'.repeat(253)

  it.each<[string, string | null, string | null, string | null]>([
    [
      'an id wins over the description',
      'merchant_fixture_1',
      'EXAMPLE CLOUD 99',
      'm:merchant_fixture_1',
    ],
    ['an id is trimmed', '  merchant_fixture_1 ', null, 'm:merchant_fixture_1'],
    [
      'a blank id falls back to the description',
      '   ',
      'EXAMPLE CLOUD 99',
      'd:example cloud',
    ],
    [
      'no id falls back to the description',
      null,
      'EXAMPLE CLOUD 99',
      'd:example cloud',
    ],
    [
      'an id of 253 fits exactly',
      FITTING_ID,
      'EXAMPLE CLOUD',
      `m:${FITTING_ID}`,
    ],
    [
      'an id of 254 is too long and falls back',
      LONG_ID,
      'EXAMPLE CLOUD',
      'd:example cloud',
    ],
    [
      'a long description is cut to 255 in all',
      null,
      'a'.repeat(300),
      `d:${'a'.repeat(253)}`,
    ],
    [
      'a cut never splits a letter beyond U+FFFF',
      null,
      `${'a'.repeat(252)}${'\u{1D400}'.repeat(5)}`,
      `d:${'a'.repeat(252)}`,
    ],
    [
      'a letter beyond U+FFFF that fits whole is kept',
      null,
      `${'a'.repeat(251)}${'\u{1D400}'.repeat(5)}`,
      `d:${'a'.repeat(251)}\u{1D400}`,
    ],
    ['a digits-only description has no key', null, '0000 1111', null],
    ['nothing at all has no key', null, null, null],
  ])('%s', (_why, merchantId, description, expected) => {
    const key = merchantKeyOf({ merchantId, description })
    expect(key).toBe(expected)
    if (key !== null) {
      expect(key.length).toBeLessThanOrEqual(MAX_MERCHANT_KEY_LENGTH)
      expect(isMerchantKey(key)).toBe(true)
    }
  })

  it('a merchant name alone never makes a key', () => {
    expect(
      merchantKeyOf(
        tx({
          merchantId: null,
          description: null,
          merchantName: 'Example Cloud',
        }),
      ),
    ).toBeNull()
    expect(
      run(
        charges(MONTHLY, {
          merchantId: null,
          description: '  ',
          merchantName: 'Example Cloud',
        }),
      ),
    ).toStrictEqual(NOTHING)
  })
})

describe('isMerchantKey and isIsoDate', () => {
  it.each<[unknown, boolean]>([
    ['m:a', true],
    ['d:abc', true],
    [`m:${'x'.repeat(253)}`, true],
    [`m:${'x'.repeat(254)}`, false],
    ['', false],
    ['m:', false],
    ['d:', false],
    ['x:abc', false],
    ['M:abc', false],
    ['abc', false],
    [42, false],
    [null, false],
    [undefined, false],
  ])('isMerchantKey(%j) is %s', (value, expected) => {
    expect(isMerchantKey(value)).toBe(expected)
  })

  it.each<[unknown, boolean]>([
    ['2026-10-25', true],
    ['2028-02-29', true],
    ['2000-02-29', true],
    ['1900-02-29', false],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['2026-2-3', false],
    ['2026-10-25T00:00:00Z', false],
    [' 2026-10-25', false],
    [20261025, false],
    ['', false],
    [null, false],
  ])('isIsoDate(%j) is %s', (value, expected) => {
    expect(isIsoDate(value)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

describe('classifyGaps: every gap in one inclusive band', () => {
  it.each<[string, number[], string | null]>([
    ['weekly low edge', [5, 5], 'weekly'],
    ['weekly high edge', [9, 9], 'weekly'],
    ['below weekly', [4, 4], null],
    ['above weekly, below monthly', [10, 10], null],
    ['monthly low edge', [26, 26], 'monthly'],
    ['monthly high edge', [34, 34], 'monthly'],
    ['below monthly', [25, 25], null],
    ['above monthly', [35, 35], null],
    ['yearly low edge', [355, 355], 'yearly'],
    ['yearly high edge', [375, 375], 'yearly'],
    ['below yearly', [354, 354], null],
    ['above yearly', [376, 376], null],
    ['one edge gap among normal ones', [30, 34, 26], 'monthly'],
    ['weekly then monthly', [7, 30], null],
    ['monthly with one gap out', [30, 30, 36], null],
    ['a same-day pair', [0], null],
    ['monthly then a same-day pair', [30, 0], null],
    ['one gap is enough to classify', [30], 'monthly'],
    ['no gap at all', [], null],
  ])('%s %j → %s', (_why, gaps, expected) => {
    expect(classifyGaps(datesWithGaps('2026-01-05', gaps))).toBe(expected)
  })

  it('calendar months: 31 Jan, 28 Feb, 31 Mar (gaps 28 and 31) are monthly', () => {
    expect(classifyGaps(['2026-01-31', '2026-02-28', '2026-03-31'])).toBe(
      'monthly',
    )
  })

  it('1 March three years running (gaps 365 and 365) is yearly; across a leap day 366 is too', () => {
    expect(classifyGaps(YEARLY)).toBe('yearly')
    expect(classifyGaps(['2023-03-01', '2024-03-01'])).toBe('yearly')
  })

  it('no dates is null', () => {
    expect(classifyGaps([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detection', () => {
  it('three settled monthly charges are a subscription, with every field', () => {
    const result = run(charges(MONTHLY))

    expect(keys(result)).toEqual(keys(RESPONSE_KEYS))
    expect(keys(result.totals)).toEqual(keys(TOTAL_KEYS))
    expect(result.subscriptions).toHaveLength(1)
    expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
    expect(result).toStrictEqual({
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

  it('two charges, however regular, are not a subscription (and Example Stream is not a hint)', () => {
    expect(run(charges(MONTHLY.slice(0, 2)))).toStrictEqual(NOTHING)
  })

  it('an irregular gap is not a subscription', () => {
    // Gaps 30 and 50.
    expect(
      run(charges(['2026-07-01', '2026-07-31', '2026-09-19'])),
    ).toStrictEqual(NOTHING)
  })

  it('a pending row neither makes a subscription nor completes a third charge', () => {
    expect(
      run([
        ...charges(MONTHLY.slice(0, 2)),
        tx({ date: MONTHLY[2], status: 'pending' }),
      ]),
    ).toStrictEqual(NOTHING)
    expect(run(charges(MONTHLY, { status: 'pending' }))).toStrictEqual(NOTHING)
  })

  it('an inflow is not a charge, and a zero amount is not either', () => {
    expect(run(charges(MONTHLY, { amountCents: 1599 }))).toStrictEqual(NOTHING)
    expect(run(charges(MONTHLY, { amountCents: 0 }))).toStrictEqual(NOTHING)
  })

  it('a refund between charges does not break the cadence or count as a charge', () => {
    const result = run([
      ...charges(MONTHLY),
      tx({ date: '2026-07-15', amountCents: 1599 }),
    ])

    expect(
      result.subscriptions.map((r) => [r.chargeCount, r.cadence]),
    ).toStrictEqual([[3, 'monthly']])
  })

  it('a settled row with no key is skipped', () => {
    expect(
      run(charges(MONTHLY, { merchantId: null, description: '0000 1111' })),
    ).toStrictEqual(NOTHING)
  })

  it('the amount is the latest charge, whatever the input order (a price change)', () => {
    const result = run([
      tx({ date: MONTHLY[2], amountCents: -1799 }),
      tx({ date: MONTHLY[0], amountCents: -1599 }),
      tx({ date: MONTHLY[1], amountCents: -1599 }),
    ])

    expect(
      result.subscriptions.map((r) => [
        r.amountCents,
        r.perMonthCents,
        r.lastChargedOn,
      ]),
    ).toStrictEqual([[1799, 1799, '2026-08-30']])
  })

  it('two charges on the latest date: the last in input order is the latest', () => {
    const yes = [mark({ answer: 'subscription' })]
    const first = tx({
      date: '2026-07-31',
      amountCents: -1100,
      merchantName: 'Name one',
    })
    const second = tx({
      date: '2026-07-31',
      amountCents: -1200,
      merchantName: 'Name two',
    })

    const a = run(
      [tx({ date: '2026-07-01', amountCents: -1000 }), first, second],
      yes,
    )
    const b = run(
      [tx({ date: '2026-07-01', amountCents: -1000 }), second, first],
      yes,
    )

    expect(a.subscriptions.map((r) => [r.amountCents, r.name])).toStrictEqual([
      [1200, 'Name two'],
    ])
    expect(b.subscriptions.map((r) => [r.amountCents, r.name])).toStrictEqual([
      [1100, 'Name one'],
    ])
  })

  it('the name is the latest merchant name, else its description, else Unnamed merchant', () => {
    const named = run([
      ...charges(MONTHLY.slice(0, 2), { merchantName: 'Old name' }),
      tx({ date: MONTHLY[2], merchantName: ' New name ' }),
    ])
    const described = run(
      charges(MONTHLY, { merchantName: '  ', description: ' EXAMPLE 22 ' }),
    )
    const unnamed = run(
      charges(MONTHLY, { merchantName: null, description: null }),
    )

    expect(named.subscriptions.map((r) => r.name)).toStrictEqual(['New name'])
    expect(described.subscriptions.map((r) => r.name)).toStrictEqual([
      'EXAMPLE 22',
    ])
    expect(unnamed.subscriptions.map((r) => r.name)).toStrictEqual([
      'Unnamed merchant',
    ])
  })

  it('the description keys a merchant with no id, ignoring card and store numbers', () => {
    const result = run([
      tx({
        date: MONTHLY[0],
        merchantId: null,
        description: 'EXAMPLE GYM 0042 CARD 1111',
      }),
      tx({
        date: MONTHLY[1],
        merchantId: null,
        description: 'EXAMPLE GYM 0043 CARD 2222',
      }),
      tx({
        date: MONTHLY[2],
        merchantId: null,
        description: 'Example Gym 9 card-3',
      }),
      // Normalises to 'example gym': another merchant, one charge, no hint.
      tx({
        date: '2026-09-01',
        merchantId: null,
        description: 'Example Gym #44',
      }),
    ])

    expect(
      result.subscriptions.map((r) => [r.merchantKey, r.chargeCount]),
    ).toStrictEqual([['d:example gym card', 3]])
    expect(result.questions).toStrictEqual([])
  })
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('scope: a row of one scope never shows under the other', () => {
  const personal = charges(MONTHLY, {
    merchantId: 'merchant_fixture_p',
    merchantName: 'Personal one',
  })
  const strawb = charges(WEEKLY, {
    scope: 'strawb',
    merchantId: 'merchant_fixture_s',
    merchantName: 'Strawb one',
    amountCents: -1000,
  })
  const both = [...personal, ...strawb]

  it('personal sees only personal', () => {
    expect(
      run(both, [], 'personal').subscriptions.map((r) => [r.scope, r.name]),
    ).toStrictEqual([['personal', 'Personal one']])
  })

  it('strawb sees only strawb', () => {
    expect(
      run(both, [], 'strawb').subscriptions.map((r) => [r.scope, r.name]),
    ).toStrictEqual([['strawb', 'Strawb one']])
  })

  it('all sees both, and its totals are their sum', () => {
    const result = run(both, [], 'all')

    expect(result.subscriptions.map((r) => [r.scope, r.name])).toStrictEqual([
      ['personal', 'Personal one'],
      ['strawb', 'Strawb one'],
    ])
    // 1599 + weekly 1000 × 52 ÷ 12 = 4333.33 → 4333; 1599 + 4333 = 5932.
    expect(result.totals).toStrictEqual({
      perMonthCents: 5932,
      perYearCents: 71184,
      countedCount: 2,
      uncountedCount: 0,
    })
  })

  it('the same merchant in both scopes is two rows, each with its own mark', () => {
    const same = [...charges(MONTHLY), ...charges(MONTHLY, { scope: 'strawb' })]

    expect(
      run(same, [], 'all').subscriptions.map((r) => [r.scope, r.merchantKey]),
    ).toStrictEqual([
      ['personal', STREAM],
      ['strawb', STREAM],
    ])

    const result = run(same, [mark({ answer: 'not_subscription' })], 'all')
    expect(result.subscriptions.map((r) => r.scope)).toStrictEqual(['strawb'])
    expect(result.notSubscriptions.map((r) => r.scope)).toStrictEqual([
      'personal',
    ])
  })

  describe('a strawb mark on a key both scopes share is read under strawb only', () => {
    const same = [...charges(MONTHLY), ...charges(MONTHLY, { scope: 'strawb' })]

    it('a strawb not_subscription moves the strawb row, under strawb and under all', () => {
      const marks = [mark({ scope: 'strawb', answer: 'not_subscription' })]

      const strawb = run(same, marks, 'strawb')
      expect(strawb.subscriptions).toStrictEqual([])
      expect(
        strawb.notSubscriptions.map((r) => [r.scope, r.merchantKey]),
      ).toStrictEqual([['strawb', STREAM]])

      const all = run(same, marks, 'all')
      expect(
        all.subscriptions.map((r) => [r.scope, r.merchantKey]),
      ).toStrictEqual([['personal', STREAM]])
      expect(
        all.notSubscriptions.map((r) => [r.scope, r.merchantKey]),
      ).toStrictEqual([['strawb', STREAM]])

      expect(run(same, marks, 'personal')).toStrictEqual(
        run(same, [], 'personal'),
      )
    })

    it('a strawb cancel date cancels the strawb row, under strawb and under all', () => {
      const marks = [mark({ scope: 'strawb', cancelledOn: '2026-08-30' })]

      expect(
        run(same, marks, 'strawb').subscriptions.map((r) => [
          r.scope,
          r.status,
          r.cancelledOn,
        ]),
      ).toStrictEqual([['strawb', 'cancelled', '2026-08-30']])
      expect(
        run(same, marks, 'all').subscriptions.map((r) => [
          r.scope,
          r.status,
          r.cancelledOn,
        ]),
      ).toStrictEqual([
        ['personal', 'active', null],
        ['strawb', 'cancelled', '2026-08-30'],
      ])

      expect(run(same, marks, 'personal')).toStrictEqual(
        run(same, [], 'personal'),
      )
    })
  })

  it('a personal mark never changes the strawb row', () => {
    const strawbOnly = charges(MONTHLY, { scope: 'strawb' })
    const marks = [
      mark({ answer: 'not_subscription', cancelledOn: '2026-08-30' }),
    ]

    expect(run(strawbOnly, marks, 'strawb')).toStrictEqual(
      run(strawbOnly, [], 'strawb'),
    )
    expect(run(strawbOnly, marks, 'strawb').subscriptions).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Hannah's marks
// ---------------------------------------------------------------------------

describe('marks: Hannah’s answer wins both ways', () => {
  const CLOUD_ID = 'merchant_fixture_cloud'
  const CLOUD = `m:${CLOUD_ID}`
  const cloud = (dates: readonly string[]) =>
    charges(dates, {
      merchantId: CLOUD_ID,
      merchantName: 'Example Cloud Storage',
      amountCents: -299,
    })

  it('detected and unmarked: a subscription, detected, not marked', () => {
    expect(
      run(charges(MONTHLY)).subscriptions.map((r) => [r.detected, r.marked]),
    ).toStrictEqual([[true, false]])
  })

  it('detected and marked a subscription: detected and marked', () => {
    const result = run(charges(MONTHLY), [mark({ answer: 'subscription' })])

    expect(
      result.subscriptions.map((r) => [r.detected, r.marked, r.cadence]),
    ).toStrictEqual([[true, true, 'monthly']])
  })

  it('marked with one charge: listed with no cadence, left out of the totals, counted as uncounted', () => {
    const result = run([tx()], [mark({ answer: 'subscription' })])

    expect(result.subscriptions).toStrictEqual([
      {
        merchantKey: STREAM,
        scope: 'personal',
        name: 'Example Stream',
        chargeCount: 1,
        lastChargedOn: '2026-07-01',
        amountCents: 1599,
        cadence: null,
        detected: false,
        marked: true,
        status: 'active',
        cancelledOn: null,
        chargedAgainOn: null,
        perMonthCents: null,
        perYearCents: null,
      },
    ])
    expect(result.totals).toStrictEqual({
      perMonthCents: 0,
      perYearCents: 0,
      countedCount: 0,
      uncountedCount: 1,
    })
  })

  it('marked with two charges a month apart: monthly and counted, still not detected', () => {
    const result = run(charges(MONTHLY.slice(0, 2)), [
      mark({ answer: 'subscription' }),
    ])

    expect(
      result.subscriptions.map((r) => [
        r.cadence,
        r.detected,
        r.marked,
        r.perMonthCents,
      ]),
    ).toStrictEqual([['monthly', false, true, 1599]])
    expect(result.totals.countedCount).toBe(1)
  })

  it('marked with irregular charges: listed with no cadence', () => {
    const result = run(charges(['2026-07-01', '2026-07-31', '2026-09-19']), [
      mark({ answer: 'subscription' }),
    ])

    expect(
      result.subscriptions.map((r) => [r.cadence, r.perYearCents]),
    ).toStrictEqual([[null, null]])
    expect(result.totals.uncountedCount).toBe(1)
  })

  it('detected and marked not a subscription: only under notSubscriptions, never counted', () => {
    const result = run(charges(MONTHLY), [mark({ answer: 'not_subscription' })])

    expect(result.subscriptions).toStrictEqual([])
    expect(result.questions).toStrictEqual([])
    expect(result.notSubscriptions).toStrictEqual([
      {
        merchantKey: STREAM,
        scope: 'personal',
        name: 'Example Stream',
        chargeCount: 3,
        lastChargedOn: '2026-08-30',
        amountCents: 1599,
      },
    ])
    expect(keys(result.notSubscriptions[0])).toEqual(keys(MERCHANT_KEYS))
    expect(result.totals).toStrictEqual(NOTHING.totals)
  })

  it('a mark for a merchant with no charges in view lists nothing', () => {
    expect(run([], [mark({ answer: 'subscription' })])).toStrictEqual(NOTHING)
  })

  it('a cancel date with no answer leaves a detected merchant a subscription', () => {
    const result = run(charges(MONTHLY), [mark({ cancelledOn: '2026-08-30' })])

    expect(result.subscriptions.map((r) => [r.marked, r.status])).toStrictEqual(
      [[false, 'cancelled']],
    )
  })

  describe('questions: "Is this a subscription?"', () => {
    it.each([
      ['two charges', ['2026-07-01', '2026-07-31']],
      ['one charge', ['2026-07-01']],
    ])('a hint name with %s is asked, not counted', (_why, dates) => {
      const result = run(cloud(dates))

      expect(result.questions).toStrictEqual([
        {
          merchantKey: CLOUD,
          scope: 'personal',
          name: 'Example Cloud Storage',
          chargeCount: dates.length,
          lastChargedOn: dates[dates.length - 1],
          amountCents: 299,
        },
      ])
      expect(keys(result.questions[0])).toEqual(keys(MERCHANT_KEYS))
      expect(result.subscriptions).toStrictEqual([])
      expect(result.totals).toStrictEqual(NOTHING.totals)
    })

    it('a hint name with three irregular charges is not asked', () => {
      expect(
        run(cloud(['2026-07-01', '2026-07-31', '2026-09-19'])),
      ).toStrictEqual(NOTHING)
    })

    it('a name with no hint and one charge is not listed', () => {
      expect(run([tx()])).toStrictEqual(NOTHING)
    })

    it('Yes moves it to subscriptions, No to notSubscriptions, and clearing asks again', () => {
      const two = cloud(['2026-07-01', '2026-07-31'])

      const yes = run(two, [
        mark({ merchantKey: CLOUD, answer: 'subscription' }),
      ])
      expect(yes.questions).toStrictEqual([])
      expect(
        yes.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.perMonthCents,
        ]),
      ).toStrictEqual([[CLOUD, 'monthly', 299]])

      const no = run(two, [
        mark({ merchantKey: CLOUD, answer: 'not_subscription' }),
      ])
      expect(no.questions).toStrictEqual([])
      expect(no.subscriptions).toStrictEqual([])
      expect(no.notSubscriptions.map((r) => r.merchantKey)).toStrictEqual([
        CLOUD,
      ])

      const cleared = run(two, [mark({ merchantKey: CLOUD, answer: null })])
      expect(cleared.questions.map((r) => r.merchantKey)).toStrictEqual([CLOUD])
    })

    it.each<[string, Partial<SubscriptionTransaction>, boolean]>([
      [
        'a hint word in the merchant name',
        { merchantName: 'Example Software Ltd' },
        true,
      ],
      [
        'a hint word in the description when there is no name',
        { merchantName: null, description: 'EXAMPLE VPN 2231' },
        true,
      ],
      [
        'a hint word in the description behind a name',
        { merchantName: 'Example Co', description: 'EXAMPLE VPN 2231' },
        false,
      ],
      ['a plural not in the list', { merchantName: 'Example Clouds' }, false],
      [
        'a hint inside a longer word',
        { merchantName: 'EXAMPLESOFTWARE' },
        false,
      ],
      [
        'a hint in capitals between punctuation',
        { merchantName: 'EXAMPLE*PREMIUM-ACCESS' },
        true,
      ],
    ])('%s: asked is %s', (_why, fields, asked) => {
      const result = run([tx(fields)])

      expect(result.questions).toHaveLength(asked ? 1 : 0)
      expect(
        nameLooksLikeSubscription(
          fields.merchantName?.trim() || fields.description || '',
        ),
      ).toBe(asked)
    })
  })
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('cancel marks, it never acts', () => {
  const FOUR = [...MONTHLY, '2026-09-29']

  it('cancelled on the last charge date: cancelled, listed, out of the totals', () => {
    const result = run(charges(MONTHLY), [mark({ cancelledOn: '2026-08-30' })])

    expect(
      result.subscriptions.map((r) => [
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
        r.perMonthCents,
      ]),
    ).toStrictEqual([['cancelled', '2026-08-30', null, 1599]])
    expect(result.totals).toStrictEqual(NOTHING.totals)
  })

  it('a charge after the cancel date: active again, charged again on the earliest later charge', () => {
    const result = run(charges(FOUR), [mark({ cancelledOn: '2026-08-01' })])

    expect(
      result.subscriptions.map((r) => [
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
      ]),
    ).toStrictEqual([['active', '2026-08-01', '2026-08-30']])
    expect(result.totals).toStrictEqual({
      perMonthCents: 1599,
      perYearCents: 19188,
      countedCount: 1,
      uncountedCount: 0,
    })
  })

  it('cancelling again after a charge-again is cancelled again', () => {
    const result = run(charges(FOUR), [mark({ cancelledOn: '2026-09-29' })])

    expect(
      result.subscriptions.map((r) => [r.status, r.chargedAgainOn]),
    ).toStrictEqual([['cancelled', null]])
  })

  describe('a charge-again off the cadence (Done-when 4)', () => {
    // Gaps 31 and 28 are monthly; the 92-day gap to the charge-again is not.
    const BEFORE = ['2026-01-05', '2026-02-05', '2026-03-05']
    const AGAIN = '2026-06-05'
    const CANCEL = '2026-03-10'

    it('is detected from the charges up to the cancel: active, charged again, monthly, counted at the latest amount', () => {
      const result = run(
        [...charges(BEFORE), tx({ date: AGAIN, amountCents: -1799 })],
        [mark({ cancelledOn: CANCEL })],
      )

      expect(result.subscriptions).toHaveLength(1)
      const [row] = result.subscriptions
      expect(keys(row)).toStrictEqual(keys(ROW_KEYS))
      expect(row).toStrictEqual({
        merchantKey: STREAM,
        scope: 'personal',
        name: 'Example Stream',
        chargeCount: 4,
        lastChargedOn: AGAIN,
        amountCents: 1799,
        cadence: 'monthly',
        detected: true,
        marked: false,
        status: 'active',
        cancelledOn: CANCEL,
        chargedAgainOn: AGAIN,
        perMonthCents: 1799,
        perYearCents: 21588,
      })
      expect(result.totals).toStrictEqual({
        perMonthCents: 1799,
        perYearCents: 21588,
        countedCount: 1,
        uncountedCount: 0,
      })
    })

    it('a charge on the cancel date counts as before the cancel', () => {
      const result = run(charges([...BEFORE, AGAIN]), [
        mark({ cancelledOn: BEFORE[BEFORE.length - 1] }),
      ])

      expect(
        result.subscriptions.map((r) => [r.status, r.chargedAgainOn]),
      ).toStrictEqual([['active', AGAIN]])
    })

    it('the same dates with no cancel date are not detected', () => {
      expect(run(charges([...BEFORE, AGAIN]))).toStrictEqual(NOTHING)
      expect(
        run(charges([...BEFORE, AGAIN]), [mark({ cancelledOn: null })]),
      ).toStrictEqual(NOTHING)
    })

    it('fewer than MIN_CHARGES charges up to the cancel are not detected', () => {
      const upToCancel = BEFORE.slice(0, MIN_CHARGES - 1)
      expect(upToCancel.length).toBeLessThan(MIN_CHARGES)
      const result = run(
        [...charges(upToCancel), tx({ date: AGAIN })],
        [mark({ cancelledOn: '2026-02-10' })],
      )

      expect(result).toStrictEqual(NOTHING)
    })

    it('a cancel date that cuts the off-cadence gap out still needs the charges up to it to fit one band', () => {
      // 2026-01-05 → 2026-01-08 is a three-day gap: no band.
      const result = run(
        charges(['2026-01-05', '2026-01-08', '2026-02-05', AGAIN]),
        [mark({ cancelledOn: CANCEL })],
      )

      expect(result).toStrictEqual(NOTHING)
    })

    it('a marked subscription takes the cadence up to the cancel when all its charges show none', () => {
      const result = run(charges(['2026-01-05', '2026-02-05', AGAIN]), [
        mark({ answer: 'subscription', cancelledOn: CANCEL }),
      ])

      expect(
        result.subscriptions.map((r) => [
          r.detected,
          r.cadence,
          r.status,
          r.chargedAgainOn,
          r.perMonthCents,
        ]),
      ).toStrictEqual([[false, 'monthly', 'active', AGAIN, 1599]])
      expect(result.totals.countedCount).toBe(1)
    })
  })

  it('a cancelled row with no cadence is in neither count', () => {
    const result = run(
      [tx()],
      [mark({ answer: 'subscription', cancelledOn: '2026-07-01' })],
    )

    expect(result.subscriptions.map((r) => r.status)).toStrictEqual([
      'cancelled',
    ])
    expect(result.totals).toStrictEqual(NOTHING.totals)
  })
})

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe('totals: integer cents, rounded half-up once per subscription', () => {
  const CASES = [
    // Passes through.
    {
      name: 'monthly 1599',
      cadence: 'monthly',
      amount: 1599,
      perMonth: 1599,
      perYear: 19188,
    },
    // 1250 × 52 = 65000; ÷ 12 = 5416.67 → 5417; × 12 = 65004, not 65000.
    {
      name: 'weekly 1250',
      cadence: 'weekly',
      amount: 1250,
      perMonth: 5417,
      perYear: 65004,
    },
    // 52000 ÷ 12 = 4333.33 → 4333; × 12 = 51996.
    {
      name: 'weekly 1000',
      cadence: 'weekly',
      amount: 1000,
      perMonth: 4333,
      perYear: 51996,
    },
    // 78000 ÷ 12 = 6500 exactly.
    {
      name: 'weekly 1500',
      cadence: 'weekly',
      amount: 1500,
      perMonth: 6500,
      perYear: 78000,
    },
    // 52 ÷ 12 = 4.33 → 4.
    {
      name: 'weekly 1',
      cadence: 'weekly',
      amount: 1,
      perMonth: 4,
      perYear: 48,
    },
    // 1806 ÷ 12 = 150.5 exactly: half rounds up.
    {
      name: 'yearly 1806',
      cadence: 'yearly',
      amount: 1806,
      perMonth: 151,
      perYear: 1812,
    },
    // 149.5 → 150.
    {
      name: 'yearly 1794',
      cadence: 'yearly',
      amount: 1794,
      perMonth: 150,
      perYear: 1800,
    },
    // 999.5 → 1000.
    {
      name: 'yearly 11994',
      cadence: 'yearly',
      amount: 11994,
      perMonth: 1000,
      perYear: 12000,
    },
    // 999.42 → 999.
    {
      name: 'yearly 11993',
      cadence: 'yearly',
      amount: 11993,
      perMonth: 999,
      perYear: 11988,
    },
    // 825 exactly.
    {
      name: 'yearly 9900',
      cadence: 'yearly',
      amount: 9900,
      perMonth: 825,
      perYear: 9900,
    },
    // 0.08 → 0.
    { name: 'yearly 1', cadence: 'yearly', amount: 1, perMonth: 0, perYear: 0 },
  ] as const

  const DATES = { weekly: WEEKLY, monthly: MONTHLY, yearly: YEARLY }

  it.each(CASES)('$name: perMonthCents', ({ cadence, amount, perMonth }) => {
    expect(perMonthCents(cadence, amount)).toBe(perMonth)
  })

  it.each(CASES)(
    '$name: through detection, the row and the totals',
    ({ cadence, amount, perMonth, perYear }) => {
      const result = run(charges(DATES[cadence], { amountCents: -amount }))

      expect(
        result.subscriptions.map((r) => [
          r.cadence,
          r.perMonthCents,
          r.perYearCents,
        ]),
      ).toStrictEqual([[cadence, perMonth, perYear]])
      expect(result.totals).toStrictEqual({
        perMonthCents: perMonth,
        perYearCents: perYear,
        countedCount: 1,
        uncountedCount: 0,
      })
    },
  )

  it.each(CASES)(
    '$name: every number in the response is an integer',
    ({ cadence, amount }) => {
      for (const n of numbersIn(
        run(charges(DATES[cadence], { amountCents: -amount })),
      )) {
        expect(Number.isSafeInteger(n), String(n)).toBe(true)
      }
    },
  )

  it.each<[number, number, number]>([
    [0, 12, 0],
    [5, 12, 0], // 0.42
    [6, 12, 1], // 0.5 rounds up
    [7, 2, 4], // 3.5
    [65000, 12, 5417],
    [1806, 12, 151],
    [1794, 12, 150],
    [11993, 12, 999],
    [1, 1, 1],
  ])('roundHalfUpDiv(%i, %i) is %i', (n, d, expected) => {
    expect(roundHalfUpDiv(n, d)).toBe(expected)
  })

  it('monthly 1599, weekly 1250 and yearly 1806: 7167 a month, 86004 a year, both ways', () => {
    const result = run(
      [
        ...charges(MONTHLY, {
          merchantId: 'merchant_fixture_m',
          merchantName: 'A monthly',
        }),
        ...charges(WEEKLY, {
          merchantId: 'merchant_fixture_w',
          merchantName: 'B weekly',
          amountCents: -1250,
        }),
        ...charges(YEARLY, {
          merchantId: 'merchant_fixture_y',
          merchantName: 'C yearly',
          amountCents: -1806,
        }),
      ],
      [],
    )

    // 1599 + 5417 + 151 = 7167; 12 × 7167 = 86004.
    expect(result.totals).toStrictEqual({
      perMonthCents: 7167,
      perYearCents: 86004,
      countedCount: 3,
      uncountedCount: 0,
    })
    // 19188 + 65004 + 1812 = 86004: the row figures sum to the same total.
    expect(result.subscriptions.map((r) => r.perYearCents)).toStrictEqual([
      19188, 65004, 1812,
    ])
    for (const n of numbersIn(result))
      expect(Number.isSafeInteger(n), String(n)).toBe(true)
  })

  it('a marked row with no cadence is uncounted beside counted ones', () => {
    const result = run(
      [
        ...charges(MONTHLY),
        tx({
          merchantId: 'merchant_fixture_one',
          merchantName: 'One-off',
          amountCents: -5000,
        }),
      ],
      [mark({ merchantKey: 'm:merchant_fixture_one', answer: 'subscription' })],
    )

    expect(result.totals).toStrictEqual({
      perMonthCents: 1599,
      perYearCents: 19188,
      countedCount: 1,
      uncountedCount: 1,
    })
  })

  it('questions and not-a-subscription merchants are never summed', () => {
    const result = run(
      [
        ...charges(MONTHLY),
        tx({
          merchantId: 'merchant_fixture_q',
          merchantName: 'Example Hosting',
          amountCents: -900,
        }),
      ],
      [mark({ answer: 'not_subscription' })],
    )

    expect(result.questions).toHaveLength(1)
    expect(result.notSubscriptions).toHaveLength(1)
    expect(result.totals).toStrictEqual(NOTHING.totals)
  })
})

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('by lowercase name, then scope, then merchant key', () => {
    const result = run(
      [
        ...charges(MONTHLY, {
          merchantId: 'merchant_fixture_b',
          merchantName: 'beta',
        }),
        ...charges(MONTHLY, {
          scope: 'strawb',
          merchantId: 'merchant_fixture_a2',
          merchantName: 'Alpha',
        }),
        ...charges(MONTHLY, {
          merchantId: 'merchant_fixture_a3',
          merchantName: 'alpha',
        }),
        ...charges(MONTHLY, {
          merchantId: 'merchant_fixture_a1',
          merchantName: 'ALPHA',
        }),
      ],
      [],
      'all',
    )

    expect(
      result.subscriptions.map((r) => [r.name, r.scope, r.merchantKey]),
    ).toStrictEqual([
      ['ALPHA', 'personal', 'm:merchant_fixture_a1'],
      ['alpha', 'personal', 'm:merchant_fixture_a3'],
      ['Alpha', 'strawb', 'm:merchant_fixture_a2'],
      ['beta', 'personal', 'm:merchant_fixture_b'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Refusals and purity
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it.each<[string, () => unknown, ErrorConstructor, RegExp]>([
    [
      'a float amount',
      () => run([tx({ amountCents: -15.99 })]),
      TypeError,
      /transactions\[0\]\.amountCents/,
    ],
    [
      'a NaN amount',
      () => run([tx({ amountCents: Number.NaN })]),
      TypeError,
      /transactions\[0\]\.amountCents/,
    ],
    [
      'a float amount on a pending row of the other scope',
      () => run([tx({ scope: 'strawb', status: 'pending', amountCents: 1.5 })]),
      TypeError,
      /transactions\[0\]\.amountCents/,
    ],
    [
      'an impossible date',
      () => run([tx({ date: '2026-02-30' })]),
      RangeError,
      /transactions\[0\]\.date/,
    ],
    [
      'an instant instead of a date',
      () => run([tx({ date: '2026-10-05T20:00:00Z' })]),
      RangeError,
      /transactions\[0\]\.date/,
    ],
    [
      'a transaction scope of all',
      () => run([tx({ scope: 'all' as unknown as RowScope })]),
      RangeError,
      /transactions\[0\]\.scope/,
    ],
    [
      'a view scope that is not one',
      () => run([], [], 'everyone' as unknown as Scope),
      RangeError,
      /scope must be/,
    ],
    [
      'a mark with a bad key',
      () => run([], [mark({ merchantKey: 'x:abc' })]),
      RangeError,
      /marks\[0\]\.merchantKey/,
    ],
    [
      'a mark with a bad answer',
      () =>
        run([], [mark({ answer: 'maybe' as unknown as SubscriptionAnswer })]),
      RangeError,
      /marks\[0\]\.answer/,
    ],
    [
      'a mark with a bad cancel date',
      () => run([], [mark({ cancelledOn: '2026-13-01' })]),
      RangeError,
      /marks\[0\]\.cancelledOn/,
    ],
    [
      'a mark with a bad scope',
      () => run([], [mark({ scope: 'all' as unknown as RowScope })]),
      RangeError,
      /marks\[0\]\.scope/,
    ],
    [
      'roundHalfUpDiv of a negative',
      () => roundHalfUpDiv(-1, 12),
      RangeError,
      /non-negative integer/,
    ],
    [
      'roundHalfUpDiv of a fraction',
      () => roundHalfUpDiv(1.5, 12),
      RangeError,
      /non-negative integer/,
    ],
    [
      'roundHalfUpDiv by zero',
      () => roundHalfUpDiv(5, 0),
      RangeError,
      /positive integer divisor/,
    ],
    [
      'roundHalfUpDiv by a negative',
      () => roundHalfUpDiv(5, -12),
      RangeError,
      /positive integer divisor/,
    ],
    [
      'roundHalfUpDiv by a fraction',
      () => roundHalfUpDiv(5, 1.5),
      RangeError,
      /positive integer divisor/,
    ],
    [
      'roundHalfUpDiv past safe integers',
      () => roundHalfUpDiv(Number.MAX_SAFE_INTEGER, 12),
      RangeError,
      /too large/,
    ],
    [
      'perMonthCents of a negative',
      () => perMonthCents('monthly', -1),
      RangeError,
      /must not be negative/,
    ],
    [
      'perMonthCents of a fraction',
      () => perMonthCents('weekly', 1.5),
      TypeError,
      /integer number of cents/,
    ],
  ])('%s throws', (_why, call, type, message) => {
    expect(call).toThrow(type)
    expect(call).toThrow(message)
  })
})

describe('no clock', () => {
  it('gives the same result whatever the time is', () => {
    const input = [
      ...charges(MONTHLY),
      ...charges(['2026-07-01'], {
        merchantId: 'merchant_fixture_c',
        merchantName: 'Example Cloud',
      }),
    ]
    const marks = [mark({ cancelledOn: '2026-07-31' })]
    const real = run(input, marks)

    vi.useFakeTimers({ toFake: ['Date'] })
    for (const at of [
      '2000-01-01T00:00:00Z',
      '2026-07-15T12:00:00Z',
      '2099-12-31T23:59:59Z',
    ]) {
      vi.setSystemTime(at)
      expect(run(input, marks)).toStrictEqual(real)
    }
  })
})

// ---------------------------------------------------------------------------
// #391 regression
// ---------------------------------------------------------------------------

// Written before the detector changes (#391), green on the all-history rule
// as it is today. Each case is something the change must NOT alter: a
// merchant the all-history rule detects keeps its bare key, its one row and
// its figures. Every expected value is worked by hand and written as a
// literal; invented merchants only.
describe('#391 regression: what detection today must keep', () => {
  const BISTRO = {
    merchantId: 'merchant_fixture_bistro',
    merchantName: 'Example Bistro',
    description: 'EXAMPLE BISTRO 2210 AKL',
  }
  // Eight visits a week or so apart, in order, each at its own price.
  const VISIT_AMOUNTS = [1850, 4200, 2900, 3600, 2200, 4500, 3100, 2750]
  // Gaps 8, 6, 6, 8, 8, 6, 7: every one in the weekly band (5 to 9).
  const VISIT_DATES = [
    '2026-06-01',
    '2026-06-09',
    '2026-06-15',
    '2026-06-21',
    '2026-06-29',
    '2026-07-07',
    '2026-07-13',
    '2026-07-20',
  ]
  // The same visits with a skipped week: gaps 8, 6, 6, 16, 8, 6, 7.
  const SKIPPED_DATES = [
    '2026-06-01',
    '2026-06-09',
    '2026-06-15',
    '2026-06-21',
    '2026-07-07',
    '2026-07-15',
    '2026-07-21',
    '2026-07-28',
  ]
  const visits = (dates: readonly string[]) =>
    dates.map((date, i) =>
      tx({ date, amountCents: -VISIT_AMOUNTS[i], ...BISTRO }),
    )

  describe('a merchant detected today keeps its bare key and one exact row', () => {
    it('monthly: one row, the bare m: key', () => {
      const result = run(charges(MONTHLY))

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_stream',
      ])
      expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
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
          // 12 × 1599 = 19188
          perYearCents: 19188,
        },
      ])
      expect(result.questions).toStrictEqual([])
      expect(result.notSubscriptions).toStrictEqual([])
    })

    it('weekly: one row, the bare m: key', () => {
      const result = run(charges(WEEKLY, { amountCents: -1250 }))

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_stream',
      ])
      expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 3,
          lastChargedOn: '2026-08-17',
          amountCents: 1250,
          cadence: 'weekly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          // 1250 × 52 = 65000; ÷ 12 = 5416.67 → 5417
          perMonthCents: 5417,
          // 12 × 5417 = 65004
          perYearCents: 65004,
        },
      ])
      expect(result.totals).toStrictEqual({
        perMonthCents: 5417,
        perYearCents: 65004,
        countedCount: 1,
        uncountedCount: 0,
      })
    })

    it('yearly: one row, the bare m: key', () => {
      const result = run(charges(YEARLY, { amountCents: -1806 }))

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_stream',
      ])
      expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 3,
          lastChargedOn: '2026-03-01',
          amountCents: 1806,
          cadence: 'yearly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          // 1806 ÷ 12 = 150.5 → 151
          perMonthCents: 151,
          // 12 × 151 = 1812
          perYearCents: 1812,
        },
      ])
      expect(result.totals).toStrictEqual({
        perMonthCents: 151,
        perYearCents: 1812,
        countedCount: 1,
        uncountedCount: 0,
      })
    })

    it('a merchant keyed by description: one row, the bare d: key', () => {
      const gym = (date: string, description: string) =>
        tx({
          date,
          merchantId: null,
          merchantName: 'Example Gym',
          amountCents: -2000,
          description,
        })
      const result = run([
        gym('2026-07-01', 'EXAMPLE GYM 0042 CARD 1111'),
        gym('2026-07-31', 'EXAMPLE GYM 0043 CARD 2222'),
        gym('2026-08-30', 'Example Gym 9 card-3'),
      ])

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'd:example gym card',
      ])
      expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'd:example gym card',
          scope: 'personal',
          name: 'Example Gym',
          chargeCount: 3,
          lastChargedOn: '2026-08-30',
          amountCents: 2000,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          perMonthCents: 2000,
          // 12 × 2000 = 24000
          perYearCents: 24000,
        },
      ])
    })

    it('four merchants at once: four rows, four bare keys, in name order', () => {
      const result = run([
        ...charges(MONTHLY, {
          merchantId: 'merchant_fixture_m',
          merchantName: 'A monthly',
        }),
        ...charges(WEEKLY, {
          merchantId: 'merchant_fixture_w',
          merchantName: 'B weekly',
          amountCents: -1250,
        }),
        ...charges(YEARLY, {
          merchantId: 'merchant_fixture_y',
          merchantName: 'C yearly',
          amountCents: -1806,
        }),
        ...charges(MONTHLY, {
          merchantId: null,
          merchantName: 'D gym',
          description: 'EXAMPLE GYM 0042 CARD 1111',
          amountCents: -2000,
        }),
      ])

      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.chargeCount,
          r.perMonthCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_m', 'monthly', 3, 1599],
        ['m:merchant_fixture_w', 'weekly', 3, 5417],
        ['m:merchant_fixture_y', 'yearly', 3, 151],
        ['d:example gym card', 'monthly', 3, 2000],
      ])
      // 1599 + 5417 + 151 + 2000 = 9167; 12 × 9167 = 110004.
      expect(result.totals).toStrictEqual({
        perMonthCents: 9167,
        perYearCents: 110004,
        countedCount: 4,
        uncountedCount: 0,
      })
    })
  })

  describe('a price change on regular gaps stays one row with the bare key', () => {
    it('four monthly charges, three prices: one row at the latest price', () => {
      // Gaps 30, 31, 30: all monthly. Prices 1299, 1299, 1499, 1799.
      const result = run([
        tx({ date: '2026-05-01', amountCents: -1299 }),
        tx({ date: '2026-05-31', amountCents: -1299 }),
        tx({ date: '2026-07-01', amountCents: -1499 }),
        tx({ date: '2026-07-31', amountCents: -1799 }),
      ])

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_stream',
      ])
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 4,
          lastChargedOn: '2026-07-31',
          amountCents: 1799,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          perMonthCents: 1799,
          // 12 × 1799 = 21588
          perYearCents: 21588,
        },
      ])
      expect(result.totals).toStrictEqual({
        perMonthCents: 1799,
        perYearCents: 21588,
        countedCount: 1,
        uncountedCount: 0,
      })
    })

    it('a price change on every charge is still one row', () => {
      const result = run([
        tx({ date: MONTHLY[0], amountCents: -999 }),
        tx({ date: MONTHLY[1], amountCents: -1199 }),
        tx({ date: MONTHLY[2], amountCents: -1399 }),
      ])

      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.chargeCount,
          r.amountCents,
          r.cadence,
        ]),
      ).toStrictEqual([['m:merchant_fixture_stream', 3, 1399, 'monthly']])
    })
  })

  describe('#393 baseline: weekly visits at varying prices', () => {
    it('eight visits a week or so apart are one weekly row with the bare key', () => {
      const result = run(visits(VISIT_DATES))

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_bistro',
      ])
      expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_bistro',
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
          // 2750 × 52 = 143000; ÷ 12 = 11916.67 → 11917
          perMonthCents: 11917,
          // 12 × 11917 = 143004
          perYearCents: 143004,
        },
      ])
      expect(result.questions).toStrictEqual([])
      expect(result.notSubscriptions).toStrictEqual([])
      expect(result.totals).toStrictEqual({
        perMonthCents: 11917,
        perYearCents: 143004,
        countedCount: 1,
        uncountedCount: 0,
      })
    })

    it('the same visits with one skipped week (a 16-day gap) are not detected', () => {
      const result = run(visits(SKIPPED_DATES))

      expect(result.subscriptions).toStrictEqual([])
    })
  })

  describe('cancel paths keep the bare key and the status', () => {
    it('cancelled on the last charge date: cancelled, bare key, out of the totals', () => {
      const result = run(charges(MONTHLY), [
        mark({ cancelledOn: '2026-08-30' }),
      ])

      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 3,
          lastChargedOn: '2026-08-30',
          amountCents: 1599,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'cancelled',
          cancelledOn: '2026-08-30',
          chargedAgainOn: null,
          perMonthCents: 1599,
          perYearCents: 19188,
        },
      ])
      expect(result.totals).toStrictEqual(NOTHING.totals)
    })

    it('a charge after the cancel date: active again on the bare key', () => {
      // Gaps 30, 30, 30; cancelled 1 Aug, charged again on 30 Aug.
      const result = run(charges([...MONTHLY, '2026-09-29']), [
        mark({ cancelledOn: '2026-08-01' }),
      ])

      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 4,
          lastChargedOn: '2026-09-29',
          amountCents: 1599,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: '2026-08-01',
          chargedAgainOn: '2026-08-30',
          perMonthCents: 1599,
          perYearCents: 19188,
        },
      ])
    })

    it('a charge-again off the cadence is still detected from the charges up to the cancel, on the bare key', () => {
      // Gaps 31 and 28 up to the cancel; then 92 days to the charge-again.
      const result = run(
        [
          ...charges(['2026-01-05', '2026-02-05', '2026-03-05']),
          tx({ date: '2026-06-05', amountCents: -1799 }),
        ],
        [mark({ cancelledOn: '2026-03-10' })],
      )

      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_stream',
          scope: 'personal',
          name: 'Example Stream',
          chargeCount: 4,
          lastChargedOn: '2026-06-05',
          amountCents: 1799,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: '2026-03-10',
          chargedAgainOn: '2026-06-05',
          perMonthCents: 1799,
          perYearCents: 21588,
        },
      ])
    })

    it('a not_subscription mark on the bare key moves the merchant to notSubscriptions under that key', () => {
      const result = run(charges(MONTHLY), [
        mark({
          merchantKey: 'm:merchant_fixture_stream',
          answer: 'not_subscription',
        }),
      ])

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
      expect(result.totals).toStrictEqual(NOTHING.totals)
    })

    it('a subscription mark on the bare key of a detected merchant is marked on that one row', () => {
      const result = run(charges(MONTHLY), [
        mark({
          merchantKey: 'm:merchant_fixture_stream',
          answer: 'subscription',
        }),
      ])

      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.detected,
          r.marked,
          r.status,
        ]),
      ).toStrictEqual([['m:merchant_fixture_stream', true, true, 'active']])
    })
  })
})

// ---------------------------------------------------------------------------
// #391 lanes (prd-02 Ruling 16)
// ---------------------------------------------------------------------------

// A merchant the all-history rule misses is read again as lanes. Every key,
// count and figure below is worked by hand from the dealing the header
// describes: charges dealt oldest first, a lane taking a charge 26 to 34
// days (monthly) or 355 to 375 days (yearly) after its last, within 3 days
// of its expected billing day (its anchor day of the month in the next
// month, cut to month end), its gaps within 5 days of each other. "Exp"
// below is that expected gap. Gaps were counted on a calendar. Merchants
// and amounts are invented.
describe('#391 lanes (prd-02 Ruling 16)', () => {
  const TOOLS_ID = 'merchant_fixture_tools'
  const TOOLS = `m:${TOOLS_ID}`
  const at = (
    merchantId: string,
    merchantName: string,
  ): ((date: string, cents: number) => SubscriptionTransaction) => {
    return (date, cents) =>
      tx({
        date,
        amountCents: -cents,
        merchantId,
        merchantName,
        description: 'EXAMPLE CO 0001',
      })
  }
  /** One charge on `day` of each month in `months`, 2026. */
  const monthly = (
    charge: (date: string, cents: number) => SubscriptionTransaction,
    day: string,
    cents: number,
    months: readonly string[],
  ) => months.map((m) => charge(`2026-${m}-${day}`, cents))
  const JAN_TO = (last: number) =>
    ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].slice(0, last)

  /** A read after each distinct charge date, oldest first. */
  const readsOverTime = (
    transactions: readonly SubscriptionTransaction[],
    marks: readonly SubscriptionMark[] = [],
  ): { date: string; result: SubscriptionsResponse }[] =>
    [...new Set(transactions.map((t) => t.date))].sort().map((date) => ({
      date,
      result: run(
        transactions.filter((t) => t.date <= date),
        marks,
      ),
    }))

  /**
   * For each subscription (named by `labelOf` from a row), every key its
   * rows were listed under across the reads, and how many reads listed it.
   */
  const keysPerLabel = (
    reads: readonly { result: SubscriptionsResponse }[],
    labelOf: (row: SubscriptionRow) => string,
  ): Record<string, { keys: string[]; reads: number }> => {
    const out: Record<string, { keys: string[]; reads: number }> = {}
    for (const { result } of reads) {
      for (const row of result.subscriptions) {
        const entry = (out[labelOf(row)] ??= { keys: [], reads: 0 })
        if (!entry.keys.includes(row.merchantKey))
          entry.keys.push(row.merchantKey)
        entry.reads++
      }
    }
    return out
  }

  // P1: three subscriptions billed on the 1st, January to May, at 2000,
  // 2000 and 4620, in that input order each month, and a one-off on 17
  // March. Month-to-month gaps 31, 28, 31, 30, each the expected gap.
  // The one-off is 16 days after 1 March and 15 before 1 April: in no lane.
  const p1 = (merchantId = TOOLS_ID): SubscriptionTransaction[] => {
    const tools = at(merchantId, 'Example Tools')
    const out: SubscriptionTransaction[] = []
    for (const month of ['01', '02', '03', '04', '05']) {
      out.push(
        tools(`2026-${month}-01`, 2000),
        tools(`2026-${month}-01`, 2000),
        tools(`2026-${month}-01`, 4620),
      )
    }
    out.push(tools('2026-03-17', 1500))
    return out
  }

  // P2: A on the 5th, a little each side of 1000, January to July; B at
  // 2310, signed up 8 January, then on the month's last day.
  const studio = at('merchant_fixture_studio', 'Example Studio')
  const P2 = [
    studio('2026-01-05', 1000),
    studio('2026-02-05', 1040),
    studio('2026-03-05', 970),
    studio('2026-04-05', 1050),
    studio('2026-05-05', 1000),
    studio('2026-06-05', 960),
    studio('2026-07-05', 1020),
    studio('2026-01-08', 2310),
    studio('2026-01-31', 2310),
    studio('2026-02-28', 2310),
    studio('2026-03-31', 2310),
    studio('2026-04-30', 2310),
    studio('2026-05-31', 2310),
    studio('2026-06-30', 2310),
    studio('2026-07-31', 2310),
  ]

  // P3: one subscription whose billing day moved 20th → 7th → 13th, at
  // amounts from 500 to 5000, with one-offs on 3 February and 13 June.
  // Dealt: 20 Jan, 20 Feb (31, exp 31), 20 Mar (28, exp 28): lane L0,
  // formed 20 March. 3 Feb starts a lane and takes nothing. 7 Apr is 18
  // days after 20 Mar: a new lane, which takes 7 May (30, exp 30) and
  // stops (13 May is 6 days on, 13 Jun 37). 13 May starts L3; on 13 June
  // L3 (31, exp 31) takes 3000, 500 from its 2500, over 1900, 600 away;
  // 1900 starts a lane. On 13 July, L3 (30, exp 30) and the 1900 lane
  // (30, exp 30) both reach 800: L3 has two charges, so it goes first.
  // L3, formed 13 July, is 13 May, 13 June (3000), 13 July: one stray in
  // its span (1900), 2 × 1 ≤ 3, clear. L0 formed first and holds the bare
  // key, but 20 March is 115 days before 13 July, past 34: not listed.
  const p3 = (
    merchantId = 'merchant_fixture_desk',
  ): SubscriptionTransaction[] => {
    const desk = at(merchantId, 'Example Desk')
    return [
      desk('2026-01-20', 500),
      desk('2026-02-20', 900),
      desk('2026-03-20', 5000),
      desk('2026-04-07', 1200),
      desk('2026-05-07', 700),
      desk('2026-05-13', 2500),
      desk('2026-06-13', 3000),
      desk('2026-07-13', 800),
      desk('2026-06-13', 1900),
      desk('2026-02-03', 1500),
    ]
  }

  it('the constants are the Ruling’s', () => {
    expect(LANE_CADENCES).toStrictEqual(['monthly', 'yearly'])
    expect(LANE_MAX_GAP_SPREAD_DAYS).toBe(5)
    expect(LANE_MAX_DEVIATION_DAYS).toBe(3)
    expect(LANE_DEVIATION_SLACK_DAYS).toBe(2)
    expect(LANE_MIN_CHARGES_SHARED).toBe(4)
    expect(LANE_MAX_CONCURRENT).toBe(3)
    expect(LANE_KEY_SEPARATOR).toBe('#')
    expect(LANE_KEY_HEADROOM).toBe(40)
  })

  describe('P1, P2 and P3', () => {
    it('P1: three monthly subscriptions billed the same day are three rows; the one-off is in none', () => {
      const result = run(p1())

      // Each 1st, the three lanes take the three charges by cents: 2000
      // with 2000 (the earlier lane the earlier charge), 4620 with 4620.
      // All three form on 1 March; the first in lane order holds the bare
      // key; the others are <bare>#2026-01-01:<cents>. Three lanes overlap,
      // so each needs 4 charges: each has 5. One stray (17 March) in each
      // span: 2 ≤ 5.
      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.chargeCount,
          r.lastChargedOn,
          r.amountCents,
          r.perMonthCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_tools', 'monthly', 5, '2026-05-01', 2000, 2000],
        [
          'm:merchant_fixture_tools#2026-01-01:2000',
          'monthly',
          5,
          '2026-05-01',
          2000,
          2000,
        ],
        [
          'm:merchant_fixture_tools#2026-01-01:4620',
          'monthly',
          5,
          '2026-05-01',
          4620,
          4620,
        ],
      ])
      // 2000 + 2000 + 4620 = 8620; 12 × 8620 = 103440.
      expect(result.totals).toStrictEqual({
        perMonthCents: 8620,
        perYearCents: 103440,
        countedCount: 3,
        uncountedCount: 0,
      })
      expect(result.questions).toStrictEqual([])
      expect(result.notSubscriptions).toStrictEqual([])
    })

    it('a lane row has exactly the row keys and every field', () => {
      const result = run(p1())
      const lane = result.subscriptions.find(
        (r) => r.merchantKey === 'm:merchant_fixture_tools#2026-01-01:4620',
      )

      expect(lane).toBeDefined()
      expect(keys(lane ?? {})).toEqual(keys(ROW_KEYS))
      expect(lane).toStrictEqual({
        merchantKey: 'm:merchant_fixture_tools#2026-01-01:4620',
        scope: 'personal',
        name: 'Example Tools',
        chargeCount: 5,
        lastChargedOn: '2026-05-01',
        amountCents: 4620,
        cadence: 'monthly',
        detected: true,
        marked: false,
        status: 'active',
        cancelledOn: null,
        chargedAgainOn: null,
        perMonthCents: 4620,
        // 12 × 4620 = 55440
        perYearCents: 55440,
      })
    })

    it('P2: two monthly subscriptions days apart, one with an odd first gap, are two rows', () => {
      const result = run(P2)

      // A: 5 Jan, then 5 Feb (31, exp 31), 5 Mar (28, exp 28), 5 Apr, 5 May,
      // 5 Jun, 5 Jul (each its expected gap): formed 5 March.
      // B: 8 Jan starts a lane; 31 Jan is 26 days after 5 Jan, but A expects
      // 5 Feb (31): 5 off, refused; 23 after 8 Jan: no band. So 31 Jan
      // starts a lane, which takes 28 Feb (28, exp 28 as 31 Feb is cut to
      // 28 Feb), 31 Mar (31), 30 Apr, 31 May, 30 Jun, 31 Jul: formed 31
      // March. The 8 Jan lane takes 5 Feb only if A does not: A is on its
      // day (0 off), the 8 Jan lane 3 off, so A takes it. 8 Jan is in no
      // row. A formed first: the bare key.
      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.chargeCount,
          r.lastChargedOn,
          r.amountCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_studio', 'monthly', 7, '2026-07-05', 1020],
        [
          'm:merchant_fixture_studio#2026-01-31:2310',
          'monthly',
          7,
          '2026-07-31',
          2310,
        ],
      ])
      // 1020 + 2310 = 3330; 12 × 3330 = 39960.
      expect(result.totals).toStrictEqual({
        perMonthCents: 3330,
        perYearCents: 39960,
        countedCount: 2,
        uncountedCount: 0,
      })
    })

    it('P3: a subscription whose billing day moved twice, beside one-offs, is one row under its lane key', () => {
      const result = run(p3())

      expect(result.subscriptions).toHaveLength(1)
      expect(keys(result.subscriptions[0])).toEqual(keys(ROW_KEYS))
      expect(result.subscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_desk#2026-05-13:2500',
          scope: 'personal',
          name: 'Example Desk',
          chargeCount: 3,
          lastChargedOn: '2026-07-13',
          amountCents: 800,
          cadence: 'monthly',
          detected: true,
          marked: false,
          status: 'active',
          cancelledOn: null,
          chargedAgainOn: null,
          perMonthCents: 800,
          // 12 × 800 = 9600
          perYearCents: 9600,
        },
      ])
      expect(result.totals).toStrictEqual({
        perMonthCents: 800,
        perYearCents: 9600,
        countedCount: 1,
        uncountedCount: 0,
      })
    })
  })

  describe('dealing', () => {
    const rowsOf = (result: SubscriptionsResponse) =>
      result.subscriptions.map((r) => [
        r.merchantKey,
        r.name,
        r.chargeCount,
        r.lastChargedOn,
        r.amountCents,
      ])

    it('a lane waits for its own day rather than take a sibling’s first charge just before it', () => {
      const app = at('merchant_fixture_app', 'Example App')
      // A on the 10th at 1000, January to June; B on the 8th at 1200,
      // February to June. On 8 Feb A's lane (one charge, 10 Jan) could take
      // B's first charge, 29 days on, 2 off its expected 31; but 10 Feb, in
      // its band, lands on the day and is nearer in cents (0 against 200),
      // so it waits, and 8 Feb starts B. Each month after, A's lane passes
      // over the 8th the same way and B's lane takes it on its day. A forms
      // on 10 March (the bare key), B on 8 April.
      const result = run([
        ...monthly(app, '10', 1000, JAN_TO(6)),
        ...monthly(app, '08', 1200, JAN_TO(6).slice(1)),
      ])

      expect(rowsOf(result)).toStrictEqual([
        ['m:merchant_fixture_app', 'Example App', 6, '2026-06-10', 1000],
        [
          'm:merchant_fixture_app#2026-02-08:1200',
          'Example App',
          5,
          '2026-06-08',
          1200,
        ],
      ])
    })

    it('a charge within 2 days of two lanes’ expected days goes to the established lane', () => {
      const app = at('merchant_fixture_app', 'Example App')
      // A on the 10th at 1500, billed on 12 March; a one-off at 4500 on 12
      // Feb. On 12 Mar A's lane (10 Jan, 10 Feb) expects 10 Mar: 30 days
      // against 28, 2 off. The one-off's lane expects 12 Mar: 0 off. Both
      // are within 2 days, which counts as on the day, so the lane with two
      // charges takes it. Then 10 Apr (29 against 31 to 12 Apr) and 10 May
      // (30 against 32), each 2 off. Gaps 31, 30, 29, 30. One stray (12
      // Feb): 2 ≤ 5.
      const result = run([
        app('2026-01-10', 1500),
        app('2026-02-10', 1500),
        app('2026-02-12', 4500),
        app('2026-03-12', 1500),
        app('2026-04-10', 1500),
        app('2026-05-10', 1500),
      ])

      expect(rowsOf(result)).toStrictEqual([
        ['m:merchant_fixture_app', 'Example App', 5, '2026-05-10', 1500],
      ])
    })

    it('two subscriptions at near-equal prices on one day keep their own charges by name', () => {
      // One merchant id, two names. January and March both at 2000;
      // February and April X at 2010, Y at 1990. On 1 Feb both charges are
      // 10 from both lanes' 2000: the same name breaks the tie. On 1 Mar
      // each 2000 is 10 from both lanes again. Both form on 1 March, X first
      // in lane order (same cents, then name): the bare key.
      const x = at(TOOLS_ID, 'Example X')
      const y = at(TOOLS_ID, 'Example Y')
      const result = run([
        ...['01', '03'].flatMap((m) => [
          x(`2026-${m}-01`, 2000),
          y(`2026-${m}-01`, 2000),
        ]),
        ...['02', '04'].flatMap((m) => [
          x(`2026-${m}-01`, 2010),
          y(`2026-${m}-01`, 1990),
        ]),
      ])

      expect(rowsOf(result)).toStrictEqual([
        ['m:merchant_fixture_tools', 'Example X', 4, '2026-04-01', 2010],
        [
          'm:merchant_fixture_tools#2026-01-01:2000',
          'Example Y',
          4,
          '2026-04-01',
          1990,
        ],
      ])
    })

    it('the same two subscriptions with Y’s rows first on each date: X still holds the bare key', () => {
      // As above, but every date's rows arrive Y first. On 1 January both
      // are 2000, so lane order falls to the name: X before Y, and X's
      // charge starts the first lane whatever the input order. Dealt by
      // input order instead, Y would start it and take the bare key.
      const x = at(TOOLS_ID, 'Example X')
      const y = at(TOOLS_ID, 'Example Y')
      const result = run([
        ...['01', '03'].flatMap((m) => [
          y(`2026-${m}-01`, 2000),
          x(`2026-${m}-01`, 2000),
        ]),
        ...['02', '04'].flatMap((m) => [
          y(`2026-${m}-01`, 1990),
          x(`2026-${m}-01`, 2010),
        ]),
      ])

      expect(rowsOf(result)).toStrictEqual([
        ['m:merchant_fixture_tools', 'Example X', 4, '2026-04-01', 2010],
        [
          'm:merchant_fixture_tools#2026-01-01:2000',
          'Example Y',
          4,
          '2026-04-01',
          1990,
        ],
      ])
    })

    describe('a lane’s gaps stay within 5 days of each other', () => {
      const app = at('merchant_fixture_app', 'Example App')
      // 10 Jan, then 7 Feb: 28 days against the expected 31, 3 off, the
      // most allowed. A one-off on 20 Jan keeps the all-history rule out.
      const START = [
        app('2026-01-10', 1500),
        app('2026-01-20', 4500),
        app('2026-02-07', 1500),
      ]

      it('a third charge 33 days on (spread 5) joins', () => {
        // 7 Feb to 12 Mar is 33 days, expected 31 (to 10 Mar), 2 off; gaps
        // 28 and 33. One stray (20 Jan): 2 ≤ 3.
        expect(rowsOf(run([...START, app('2026-03-12', 1500)]))).toStrictEqual([
          ['m:merchant_fixture_app', 'Example App', 3, '2026-03-12', 1500],
        ])
      })

      it('a third charge 34 days on (spread 6) does not', () => {
        // 7 Feb to 13 Mar is 34 days, 3 off: in the band and near enough
        // the day, but gaps 28 and 34 spread 6.
        expect(run([...START, app('2026-03-13', 1500)])).toStrictEqual(NOTHING)
      })
    })
  })

  describe('a subscription keeps one key as charges arrive', () => {
    it('P2: A always under the bare key, B always under its lane key', () => {
      const reads = readsOverTime(P2)

      // A forms on 5 March but its span then holds 8 Jan, 31 Jan and 28
      // Feb, in no formed lane: 3 strays, 6 > 3. From 31 March B has
      // formed too, the two overlap, and each needs 4 charges. A has 4 on
      // 5 April: listed from then, 8 reads to 31 July. B has 4 on 30 April:
      // 7 reads.
      expect(
        keysPerLabel(reads, (r) => (r.amountCents === 2310 ? 'B' : 'A')),
      ).toStrictEqual({
        A: { keys: ['m:merchant_fixture_studio'], reads: 8 },
        B: { keys: ['m:merchant_fixture_studio#2026-01-31:2310'], reads: 7 },
      })
    })

    it('two clean monthly subscriptions on the 5th and the 20th', () => {
      const club = at('merchant_fixture_club', 'Example Club')
      const reads = readsOverTime([
        ...monthly(club, '05', 1000, JAN_TO(10)),
        ...monthly(club, '20', 2500, JAN_TO(10)),
      ])

      // The 5th forms on 5 March, the 20th on 20 March; they overlap, so
      // each is listed from its 4th charge: the 5th from 5 April, 14 reads
      // to 20 October; the 20th from 20 April, 13 reads.
      expect(
        keysPerLabel(reads, (r) => (r.amountCents === 2500 ? '20th' : '5th')),
      ).toStrictEqual({
        '5th': { keys: ['m:merchant_fixture_club'], reads: 14 },
        '20th': {
          keys: ['m:merchant_fixture_club#2026-01-20:2500'],
          reads: 13,
        },
      })
    })

    // P1 for seven months, the three told apart by name (one merchant id).
    const named = (z: (month: number) => number) => {
      const out: SubscriptionTransaction[] = []
      JAN_TO(7).forEach((m, i) => {
        out.push(
          at(TOOLS_ID, 'Example X')(`2026-${m}-01`, 2000),
          at(TOOLS_ID, 'Example Y')(`2026-${m}-01`, 2000),
          at(TOOLS_ID, 'Example Z')(`2026-${m}-01`, z(i)),
        )
      })
      out.push(at(TOOLS_ID, 'Example Tools')('2026-03-17', 1500))
      return out
    }

    it('P1 with Z repriced from 2000 to 4620 in April', () => {
      const reads = readsOverTime(named((i) => (i >= 3 ? 4620 : 2000)))

      // Up to March all three are 2000 and each lane takes the charge of
      // its own name (cents tie; the same name goes first). On 1 April Z's
      // lane, last 2000, still takes the 4620: the 2000s are taken first by
      // X's and Y's lanes, nearer in cents. All form on 1 March; X first in
      // lane order (cents tie, then name) holds the bare key; Y and Z both
      // build #2026-01-01:2000 and Z, later in lane order, gets .2. Three
      // overlap, so each is listed from its 4th charge, 1 April: 4 reads.
      expect(keysPerLabel(reads, (r) => r.name)).toStrictEqual({
        'Example X': { keys: ['m:merchant_fixture_tools'], reads: 4 },
        'Example Y': {
          keys: ['m:merchant_fixture_tools#2026-01-01:2000'],
          reads: 4,
        },
        'Example Z': {
          keys: ['m:merchant_fixture_tools#2026-01-01:2000.2'],
          reads: 4,
        },
      })
    })

    it('P1 with the order rows arrive in on each date shuffled', () => {
      const inOrder: SubscriptionTransaction[] = []
      const shuffled: SubscriptionTransaction[] = []
      const tools = at(TOOLS_ID, 'Example Tools')
      // January's rows arrive 4620 first, so lanes started in arrival
      // order would give the 4620 lane the bare key.
      const orders = [
        [2, 0, 1],
        [1, 2, 0],
        [0, 2, 1],
        [2, 1, 0],
        [1, 0, 2],
        [0, 1, 2],
        [2, 0, 1],
      ]
      JAN_TO(7).forEach((m, i) => {
        const day = [2000, 2000, 4620].map((c) => tools(`2026-${m}-01`, c))
        inOrder.push(...day)
        shuffled.push(...orders[i].map((k) => day[k]))
      })
      const oneOff = tools('2026-03-17', 1500)
      const reads = readsOverTime([...shuffled, oneOff])

      // Every read is the same as with the rows in order: lanes deal one
      // date's charges by cents, then name, then input order, and the two
      // 2000 charges are alike.
      expect(reads).toStrictEqual(readsOverTime([...inOrder, oneOff]))
      expect(
        keysPerLabel(reads, (r) => (r.amountCents === 4620 ? 'Z' : '2000')),
      ).toStrictEqual({
        '2000': {
          keys: [
            'm:merchant_fixture_tools',
            'm:merchant_fixture_tools#2026-01-01:2000',
          ],
          reads: 8,
        },
        Z: { keys: ['m:merchant_fixture_tools#2026-01-01:4620'], reads: 4 },
      })
    })
  })

  it('a cancelled bare-key lane that stops stays listed as cancelled; its sibling keeps its key', () => {
    const app = at('merchant_fixture_app', 'Example App')
    const A = monthly(app, '05', 1000, JAN_TO(5))
    const B = monthly(app, '20', 2500, JAN_TO(10).slice(1))
    const cancelA = mark({
      merchantKey: 'm:merchant_fixture_app',
      cancelledOn: '2026-05-06',
    })

    // A, the 5th from January to May, forms on 5 March: the bare key. B,
    // the 20th from February to October, forms on 20 April. Both have 4
    // charges or more; no strays. On 20 October A's last charge, 5 May, is
    // 168 days back: stale, but her cancel date pins it, so it is listed
    // though not detected (with no mark it would not be listed). No A
    // charge follows 6 May: cancelled.
    const result = run([...A, ...B], [cancelA])
    expect(
      result.subscriptions.map((r) => [
        r.merchantKey,
        r.chargeCount,
        r.lastChargedOn,
        r.detected,
        r.status,
        r.cancelledOn,
      ]),
    ).toStrictEqual([
      [
        'm:merchant_fixture_app',
        5,
        '2026-05-05',
        false,
        'cancelled',
        '2026-05-06',
      ],
      [
        'm:merchant_fixture_app#2026-02-20:2500',
        9,
        '2026-10-20',
        true,
        'active',
        null,
      ],
    ])
    // A cancelled row counts nothing: 2500.
    expect(result.totals).toStrictEqual({
      perMonthCents: 2500,
      perYearCents: 30000,
      countedCount: 1,
      uncountedCount: 0,
    })
    // B never takes the bare key, at any read.
    expect(
      keysPerLabel(readsOverTime([...A, ...B], [cancelA]), (r) =>
        r.amountCents === 2500 ? 'B' : 'A',
      ),
    ).toStrictEqual({
      // The cancel pins A, so it is listed from the read it forms on, 5
      // March: 11 reads to 20 October.
      A: { keys: ['m:merchant_fixture_app'], reads: 11 },
      // B forms on 20 April with 3 charges while overlapping A, so it is
      // listed from its 4th, 20 May: 6 reads.
      B: { keys: ['m:merchant_fixture_app#2026-02-20:2500'], reads: 6 },
    })

    // Without the cancel, nothing pins A: only B is listed, under its key.
    expect(
      run([...A, ...B]).subscriptions.map((r) => r.merchantKey),
    ).toStrictEqual(['m:merchant_fixture_app#2026-02-20:2500'])
  })

  it('a marked bare-key lane that moves its billing day keeps the mark; the new run gets a new key', () => {
    const app = at('merchant_fixture_app', 'Example App')
    // A on the 5th, January to May, then on the 15th, June to October; B
    // on the 25th, March to October.
    const result = run(
      [
        ...monthly(app, '05', 1000, JAN_TO(5)),
        ...monthly(app, '15', 1000, JAN_TO(10).slice(5)),
        ...monthly(app, '25', 2500, JAN_TO(10).slice(2)),
      ],
      [mark({ merchantKey: 'm:merchant_fixture_app', answer: 'subscription' })],
    )

    // A's 5th lane forms on 5 March: the bare key. 15 June is 41 days
    // after 5 May: a new lane, formed 15 August, key #2026-06-15:1000. B
    // forms on 25 May, key #2026-03-25:2500. On 25 October the 5th lane is
    // stale, but her answer pins it: listed, marked, not detected, so the
    // screen offers Unmark on it rather than Not a subscription.
    expect(
      result.subscriptions.map((r) => [
        r.merchantKey,
        r.chargeCount,
        r.lastChargedOn,
        r.detected,
        r.marked,
      ]),
    ).toStrictEqual([
      ['m:merchant_fixture_app', 5, '2026-05-05', false, true],
      ['m:merchant_fixture_app#2026-03-25:2500', 8, '2026-10-25', true, false],
      ['m:merchant_fixture_app#2026-06-15:1000', 5, '2026-10-15', true, false],
    ])
    // 1000 + 2500 + 1000 = 4500.
    expect(result.totals.perMonthCents).toBe(4500)
  })

  it('a key listed at one read is listed at the next, unless its row went stale', () => {
    const app = at('merchant_fixture_app', 'Example App')
    const fixtures: SubscriptionTransaction[][] = [
      P2,
      p1(),
      p3(),
      [
        ...monthly(app, '05', 1000, JAN_TO(5)),
        ...monthly(app, '15', 1000, JAN_TO(10).slice(5)),
        ...monthly(app, '25', 2500, JAN_TO(10).slice(2)),
      ],
    ]

    for (const fixture of fixtures) {
      const reads = readsOverTime(fixture)
      for (let n = 1; n < reads.length; n++) {
        const next = reads[n]
        const listed = new Set(
          next.result.subscriptions.map((r) => r.merchantKey),
        )
        for (const row of reads[n - 1].result.subscriptions) {
          // Stale: its last charge more than 34 days before the read's
          // latest charge (the monthly band's high edge).
          if (daysBetween(row.lastChargedOn, next.date) > 34) continue
          expect([
            next.date,
            row.merchantKey,
            listed.has(row.merchantKey),
          ]).toStrictEqual([next.date, row.merchantKey, true])
        }
      }
    }
  })

  describe('not worse for irregular and frequent visits (#393)', () => {
    it('a merchant visited every 10 to 20 days is not detected', () => {
      const cafe = at('merchant_fixture_cafe', 'Example Cafe')
      // Gaps 10, 13, 19, 18, 11, 12, 20, 17, 10, 14, 19. The pairs 26 to 34
      // days apart are 13 Jan–14 Feb (32), 14 Feb–15 Mar (29), 15 Mar–16
      // Apr (32), 16 Apr–13 May (27) and 13 May–15 Jun (33). The first four
      // chain into one lane, each within 3 of its expected gap (31, 28,
      // 31, 30); 15 Jun would spread its gaps 27 to 33, 6 > 5. That lane's
      // span holds 26 Jan, 4 Mar, 27 Mar and 3 May, in no lane: 4 strays,
      // 2 × 4 = 8 > 5, so it is not clear.
      const dates = datesWithGaps(
        '2026-01-03',
        [10, 13, 19, 18, 11, 12, 20, 17, 10, 14, 19],
      )
      expect(dates).toStrictEqual([
        '2026-01-03',
        '2026-01-13',
        '2026-01-26',
        '2026-02-14',
        '2026-03-04',
        '2026-03-15',
        '2026-03-27',
        '2026-04-16',
        '2026-05-03',
        '2026-05-13',
        '2026-05-27',
        '2026-06-15',
      ])

      expect(run(dates.map((d, i) => cafe(d, 1500 + 311 * i)))).toStrictEqual(
        NOTHING,
      )
    })

    it('a weekly diner with one skipped week is still not detected', () => {
      const diner = at('merchant_fixture_diner', 'Example Diner')
      // Tuesdays from 3 March to 2 June without 21 April: every gap 7 but
      // one of 14, so the all-history rule misses it, and weekly is never a
      // lane. Monthly lanes step 28 days. 3 Mar takes 31 Mar (exp 31, 3
      // off) and 28 Apr (exp 30, as 31 Apr is cut to 30 Apr, 2 off); 26
      // May is 5 off its 31 May: it stops at three. 10 Mar and 7 Apr, 17
      // Mar and 14 Apr, 5 May and 2 Jun reach two; every other step is 5
      // off or out of the band. The one lane of three holds 10, 17 and 24
      // Mar, 7 and 14 Apr in its span: 5 strays, 10 > 3. Nothing is kept.
      const dates = [
        '2026-03-03',
        '2026-03-10',
        '2026-03-17',
        '2026-03-24',
        '2026-03-31',
        '2026-04-07',
        '2026-04-14',
        '2026-04-28',
        '2026-05-05',
        '2026-05-12',
        '2026-05-19',
        '2026-05-26',
        '2026-06-02',
      ]
      const cents = [
        1850, 4200, 2900, 3600, 2200, 4500, 3100, 2750, 1990, 3350, 2600, 4100,
        2450,
      ]

      expect(run(dates.map((d, i) => diner(d, cents[i])))).toStrictEqual(
        NOTHING,
      )
    })

    it('a merchant visited every three days is not detected', () => {
      const market = at('merchant_fixture_market', 'Example Market')
      // 21 visits, 3 days apart, from 1 June to 31 July. A lane can step
      // only 27, 30 or 33 days and must land within 3 of its expected day;
      // worked through, one lane forms (1 June, 28 June, 25 July, 27 days a
      // step) and its span holds 16 other visits: refused.
      const dates = datesWithGaps('2026-06-01', Array(20).fill(3))
      expect(dates[dates.length - 1]).toBe('2026-07-31')

      expect(run(dates.map((d, i) => market(d, 4000 + 37 * i)))).toStrictEqual(
        NOTHING,
      )
    })

    it('a weekly subscription beside a one-off is not dealt as lanes', () => {
      // 3, 10, 17 and 24 August with a one-off on 12 August: gaps 7, 2, 5,
      // 7, so the all-history rule misses it; no two charges are 26 to 34
      // or 355 to 375 days apart, and weekly is never a lane.
      const result = run([
        ...charges(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']),
        tx({ date: '2026-08-12', amountCents: -2500 }),
      ])

      expect(result).toStrictEqual(NOTHING)
    })
  })

  it('a fortnightly merchant shows as one monthly row for a while, then none (a named limit)', () => {
    const club = at('merchant_fixture_club', 'Example Club')
    // Every 14 days from 2 January to 8 May: ten charges of 4500.
    // 2 Jan takes 30 Jan (28, exp 31), 27 Feb (28, exp 29 as 30 Feb is cut
    // to 28 Feb), 27 Mar (28, exp 31), and stops: 24 Apr is 6 off its 30
    // Apr. 16 Jan takes 13 Feb (exp 31) and 13 Mar (exp 31) and stops: 10
    // Apr is 6 off its 16 Apr. 10 Apr takes 8 May. The 2 Jan lane forms
    // first (27 Feb): the bare key. The two overlap, so each needs 4
    // charges: only the 2 Jan lane is clear.
    const dates = datesWithGaps('2026-01-02', Array(9).fill(14))
    expect(dates[dates.length - 1]).toBe('2026-05-08')
    const club14 = dates.map((d) => club(d, 4500))

    // Read on 24 April, 27 March is 28 days back: live.
    expect(
      run(club14.filter((t) => t.date <= '2026-04-24')).subscriptions.map(
        (r) => [r.merchantKey, r.chargeCount, r.lastChargedOn, r.perMonthCents],
      ),
    ).toStrictEqual([['m:merchant_fixture_club', 4, '2026-03-27', 4500]])
    // Read on 8 May it is 42 days back: stale, and nothing is listed.
    expect(run(club14)).toStrictEqual(NOTHING)
  })

  describe('the noise guard: strays inside a lane’s span', () => {
    const shop = at('merchant_fixture_shop', 'Example Shop')
    // A lane of 10 Jan, 9 Feb, 11 Mar and 10 Apr (gaps 30, 30, 30; exp 31,
    // 29, 31) at 999, with one-offs inside its span. No one-off is 26 to
    // 34 days from any other charge, so each starts a lane that never
    // grows.
    const LANE = [
      shop('2026-01-10', 999),
      shop('2026-02-09', 999),
      shop('2026-03-11', 999),
      shop('2026-04-10', 999),
    ]

    it('one stray for every two lane charges: kept', () => {
      const result = run([
        ...LANE,
        shop('2026-01-20', 3100),
        shop('2026-03-01', 2780),
      ])

      // 2 × 2 = 4 ≤ 4.
      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.chargeCount,
          r.amountCents,
        ]),
      ).toStrictEqual([['m:merchant_fixture_shop', 4, 999]])
    })

    it('one stray more: refused', () => {
      const result = run([
        ...LANE,
        shop('2026-01-20', 3100),
        shop('2026-02-25', 1720),
        shop('2026-03-01', 2780),
      ])

      // 2 × 3 = 6 > 4.
      expect(result).toStrictEqual(NOTHING)
    })
  })

  describe('a lane that stopped', () => {
    const app = at('merchant_fixture_app', 'Example App')
    // A: the 1st at 2000. B: the 15th at 1000. They overlap, so each
    // needs 4 charges once both have formed.
    const aTo = (last: number) => monthly(app, '01', 2000, JAN_TO(last))
    const bTo = (last: number) => monthly(app, '15', 1000, JAN_TO(last))

    it('two overlapping lanes of three charges list nothing yet', () => {
      // A forms on 1 March, B on 15 March, each with 3 charges.
      expect(run([...aTo(3), ...bTo(3)])).toStrictEqual(NOTHING)
    })

    it('while both are live, the lane that formed first holds the bare key', () => {
      // January to April: 4 charges each. A formed on 1 March, first.
      const result = run([...aTo(4), ...bTo(4)])

      expect(
        result.subscriptions.map((r) => [r.merchantKey, r.amountCents]),
      ).toStrictEqual([
        ['m:merchant_fixture_app', 2000],
        ['m:merchant_fixture_app#2026-01-15:1000', 1000],
      ])
    })

    it('once the bare-key lane is stale it is not shown, and the live lane keeps its own key (a named limit)', () => {
      // B runs on to 15 June: six charges. A's last, 1 April, is 75 days
      // before 15 June, past 34: stale and unpinned. The bare key stays
      // with A, so B is listed under its lane key.
      const result = run([...aTo(4), ...bTo(6)])

      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.chargeCount,
          r.lastChargedOn,
          r.amountCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_app#2026-01-15:1000', 6, '2026-06-15', 1000],
      ])
    })
  })

  describe('yearly lanes', () => {
    it('a yearly subscription beside a one-off is one yearly row', () => {
      // 1 March 2024, 2025, 2026 (365 and 365, each its expected gap) and
      // a one-off on 10 July 2025: the all-history rule misses it. One
      // stray in its span, 2 ≤ 3.
      const result = run([
        ...charges(YEARLY, { amountCents: -1806 }),
        tx({ date: '2025-07-10', amountCents: -4999 }),
      ])

      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.chargeCount,
          r.amountCents,
          r.perMonthCents,
        ]),
      ).toStrictEqual([['m:merchant_fixture_stream', 'yearly', 3, 1806, 151]])
    })

    it('two yearly subscriptions and a leap-day one on one merchant are three rows', () => {
      const host = at('merchant_fixture_host', 'Example Host')
      const result = run([
        // 14 March 2022 to 2026: gaps 365, 366, 365, 365; formed 2024.
        ...['2022', '2023', '2024', '2025', '2026'].map((y) =>
          host(`${y}-03-14`, 9900),
        ),
        // 2 September 2023 to 2026: gaps 366, 365, 365; formed 2025.
        ...['2023', '2024', '2025', '2026'].map((y) =>
          host(`${y}-09-02`, 15900),
        ),
        // 29 February 2024, then 28 February 2025 and 2026: the 29th is cut
        // to the 28th, so each gap (365) is its expected gap; formed 2026.
        host('2024-02-29', 4900),
        host('2025-02-28', 4900),
        host('2026-02-28', 4900),
      ])

      // No two charges of different runs are 26 to 34 or 355 to 375 days
      // apart (14 days, 351, 352 and 379 at the nearest). Three overlap at
      // most, and the shared rule's 4 charges is for monthly lanes only.
      // On 2 September 2026, 14 March is 172 days back and 28 February
      // 186: both within 375, live.
      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.chargeCount,
          r.lastChargedOn,
          r.perMonthCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_host', 'yearly', 5, '2026-03-14', 825],
        [
          'm:merchant_fixture_host#2023-09-02:15900',
          'yearly',
          4,
          '2026-09-02',
          1325,
        ],
        [
          'm:merchant_fixture_host#2024-02-29:4900',
          'yearly',
          3,
          '2026-02-28',
          408,
        ],
      ])
      // 9900 ÷ 12 = 825; 15900 ÷ 12 = 1325; 4900 ÷ 12 = 408.33 → 408.
      // 825 + 1325 + 408 = 2558; 12 × 2558 = 30696.
      expect(result.totals).toStrictEqual({
        perMonthCents: 2558,
        perYearCents: 30696,
        countedCount: 3,
        uncountedCount: 0,
      })
    })

    it('a monthly and a yearly subscription on one merchant are two rows', () => {
      const host = at('merchant_fixture_host', 'Example Host')
      const result = run([
        ...monthly(host, '05', 1500, JAN_TO(9)),
        host('2024-06-10', 9900),
        host('2025-06-10', 9900),
        host('2026-06-10', 9900),
      ])

      // 5 June 2026 is 360 days after 10 June 2025, but 5 off its expected
      // 365: the yearly lane waits for 10 June. The monthly lane forms on 5
      // March 2026, the yearly on 10 June 2026: the monthly lane holds the
      // bare key. They overlap; the monthly lane has 9 charges, and the
      // yearly needs only 3.
      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.cadence,
          r.chargeCount,
          r.perMonthCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_host', 'monthly', 9, 1500],
        ['m:merchant_fixture_host#2024-06-10:9900', 'yearly', 3, 825],
      ])
      // 1500 + 825 = 2325.
      expect(result.totals.perMonthCents).toBe(2325)
    })
  })

  describe('too many subscriptions at once', () => {
    const gym = at('merchant_fixture_gym', 'Example Gym')
    // Four monthly subscriptions on the 3rd, 10th, 17th and 24th, January
    // to June. Their days are 7, 14 or 21 apart, so charges of two lanes
    // are 7 to 24 days apart or 35 or more: never in the band. Each lane
    // is clean, 6 charges, forming on 3, 10, 17 and 24 March.
    const lanes = [
      ...monthly(gym, '03', 1100, JAN_TO(6)),
      ...monthly(gym, '10', 2200, JAN_TO(6)),
      ...monthly(gym, '17', 3300, JAN_TO(6)),
    ]
    const fourth = monthly(gym, '24', 4400, JAN_TO(6))
    const pin = mark({
      merchantKey: 'm:merchant_fixture_gym#2026-01-10:2200',
      answer: 'subscription',
    })
    const rowsOf = (result: SubscriptionsResponse) =>
      result.subscriptions.map((r) => [r.merchantKey, r.detected, r.marked])

    it('four at once list nothing', () => {
      // Four overlap: more than 3, so no lane is clear.
      expect(run([...lanes, ...fourth])).toStrictEqual(NOTHING)
    })

    it('three at once list all three', () => {
      expect(rowsOf(run(lanes))).toStrictEqual([
        ['m:merchant_fixture_gym', true, false],
        ['m:merchant_fixture_gym#2026-01-10:2200', true, false],
        ['m:merchant_fixture_gym#2026-01-17:3300', true, false],
      ])
    })

    it('a marked lane is listed either way, detected only when clear', () => {
      expect(rowsOf(run([...lanes, ...fourth], [pin]))).toStrictEqual([
        ['m:merchant_fixture_gym#2026-01-10:2200', false, true],
      ])
      expect(rowsOf(run(lanes, [pin]))).toStrictEqual([
        ['m:merchant_fixture_gym', true, false],
        ['m:merchant_fixture_gym#2026-01-10:2200', true, true],
        ['m:merchant_fixture_gym#2026-01-17:3300', true, false],
      ])
    })
  })

  describe('keys that cannot be split', () => {
    const shop = at('merchant#fixture', 'Example Shop')

    it('an m: id holding # is never split: P1 lists nothing', () => {
      expect(run(p1('merchant#fixture'))).toStrictEqual(NOTHING)
    })

    it('a merchant with one lane needs no lane key, so # in its id does not matter', () => {
      // The noise-guard lane: one formed lane, listed under the bare key.
      const result = run([
        shop('2026-01-10', 999),
        shop('2026-02-09', 999),
        shop('2026-03-11', 999),
        shop('2026-04-10', 999),
      ])
      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant#fixture',
      ])
    })

    it('a bare key leaving exactly the headroom splits; one character longer does not', () => {
      // 'm:' + 213 letters is 215; 215 + 40 = 255, the longest key.
      const fits = 'a'.repeat(213)
      expect(
        run(p1(fits)).subscriptions.map((r) => r.merchantKey),
      ).toStrictEqual([
        `m:${fits}`,
        `m:${fits}#2026-01-01:2000`,
        `m:${fits}#2026-01-01:4620`,
      ])
      // 'm:' + 214 letters is 216; 216 + 40 = 256.
      expect(run(p1('a'.repeat(214)))).toStrictEqual(NOTHING)
    })

    it('a lane key that is another merchant’s bare key is never used', () => {
      const result = run([
        ...p1(),
        tx({
          date: '2026-05-02',
          merchantId: 'merchant_fixture_tools#2026-01-01:4620',
          merchantName: 'Example Other',
        }),
      ])

      expect(result).toStrictEqual(NOTHING)
    })
  })

  describe('marks on lanes', () => {
    const lanesOf = (result: SubscriptionsResponse) =>
      result.subscriptions.map((r) => [
        r.merchantKey,
        r.marked,
        r.status,
        r.cancelledOn,
        r.chargedAgainOn,
      ])

    it('not_subscription on the bare key hides every lane: one entry, all its charges', () => {
      const result = run(p1(), [
        mark({ merchantKey: TOOLS, answer: 'not_subscription' }),
      ])

      expect(result.subscriptions).toStrictEqual([])
      // Sixteen charges; the latest is the last on 1 May in input order,
      // the 4620.
      expect(result.notSubscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_tools',
          scope: 'personal',
          name: 'Example Tools',
          chargeCount: 16,
          lastChargedOn: '2026-05-01',
          amountCents: 4620,
        },
      ])
      expect(result.totals).toStrictEqual(NOTHING.totals)
    })

    it('clearing that answer brings every lane back', () => {
      const result = run(p1(), [mark({ merchantKey: TOOLS, answer: null })])

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_tools',
        'm:merchant_fixture_tools#2026-01-01:2000',
        'm:merchant_fixture_tools#2026-01-01:4620',
      ])
    })

    it('not_subscription on a lane key moves that lane only', () => {
      const result = run(p1(), [
        mark({
          merchantKey: 'm:merchant_fixture_tools#2026-01-01:4620',
          answer: 'not_subscription',
        }),
      ])

      expect(result.subscriptions.map((r) => r.merchantKey)).toStrictEqual([
        'm:merchant_fixture_tools',
        'm:merchant_fixture_tools#2026-01-01:2000',
      ])
      expect(result.notSubscriptions).toStrictEqual([
        {
          merchantKey: 'm:merchant_fixture_tools#2026-01-01:4620',
          scope: 'personal',
          name: 'Example Tools',
          chargeCount: 5,
          lastChargedOn: '2026-05-01',
          amountCents: 4620,
        },
      ])
      // 2000 + 2000 = 4000; 12 × 4000 = 48000.
      expect(result.totals).toStrictEqual({
        perMonthCents: 4000,
        perYearCents: 48000,
        countedCount: 2,
        uncountedCount: 0,
      })
    })

    it('a subscription answer on a lane key marks that lane only', () => {
      const result = run(p1(), [
        mark({
          merchantKey: 'm:merchant_fixture_tools#2026-01-01:2000',
          answer: 'subscription',
        }),
      ])

      expect(lanesOf(result)).toStrictEqual([
        ['m:merchant_fixture_tools', false, 'active', null, null],
        [
          'm:merchant_fixture_tools#2026-01-01:2000',
          true,
          'active',
          null,
          null,
        ],
        [
          'm:merchant_fixture_tools#2026-01-01:4620',
          false,
          'active',
          null,
          null,
        ],
      ])
    })

    it('a cancel on a lane key cancels that lane; a later charge in it is a charge-again', () => {
      const cancelled = run(p1(), [
        mark({
          merchantKey: 'm:merchant_fixture_tools#2026-01-01:4620',
          cancelledOn: '2026-05-01',
        }),
      ])
      expect(lanesOf(cancelled)).toStrictEqual([
        ['m:merchant_fixture_tools', false, 'active', null, null],
        [
          'm:merchant_fixture_tools#2026-01-01:2000',
          false,
          'active',
          null,
          null,
        ],
        [
          'm:merchant_fixture_tools#2026-01-01:4620',
          false,
          'cancelled',
          '2026-05-01',
          null,
        ],
      ])
      expect(cancelled.totals.perMonthCents).toBe(4000)

      const again = run(p1(), [
        mark({
          merchantKey: 'm:merchant_fixture_tools#2026-01-01:4620',
          cancelledOn: '2026-04-15',
        }),
      ])
      expect(lanesOf(again)[2]).toStrictEqual([
        'm:merchant_fixture_tools#2026-01-01:4620',
        false,
        'active',
        '2026-04-15',
        '2026-05-01',
      ])
    })

    it('an answer and a cancel on the bare key belong to the bare-key lane only', () => {
      const result = run(p1(), [
        mark({
          merchantKey: TOOLS,
          answer: 'subscription',
          cancelledOn: '2026-05-01',
        }),
      ])

      expect(lanesOf(result)).toStrictEqual([
        ['m:merchant_fixture_tools', true, 'cancelled', '2026-05-01', null],
        [
          'm:merchant_fixture_tools#2026-01-01:2000',
          false,
          'active',
          null,
          null,
        ],
        [
          'm:merchant_fixture_tools#2026-01-01:4620',
          false,
          'active',
          null,
          null,
        ],
      ])
      // 2000 + 4620 = 6620.
      expect(result.totals.perMonthCents).toBe(6620)
    })

    it('a subscription answer on the bare key of P3 lists its stale bare-key lane beside the live one', () => {
      const result = run(p3(), [
        mark({
          merchantKey: 'm:merchant_fixture_desk',
          answer: 'subscription',
        }),
      ])

      // The 20th lane (20 Jan, 20 Feb, 20 Mar at 5000) holds the bare key;
      // her answer pins it. Its span holds 3 Feb, a stray: 2 ≤ 3, clear;
      // but 20 March is 115 days before 13 July, stale: not detected.
      expect(
        result.subscriptions.map((r) => [
          r.merchantKey,
          r.detected,
          r.marked,
          r.chargeCount,
          r.lastChargedOn,
          r.amountCents,
        ]),
      ).toStrictEqual([
        ['m:merchant_fixture_desk', false, true, 3, '2026-03-20', 5000],
        [
          'm:merchant_fixture_desk#2026-05-13:2500',
          true,
          false,
          3,
          '2026-07-13',
          800,
        ],
      ])
    })
  })

  describe('chargeKeys: every key a write may name', () => {
    const OTHER = tx({
      date: '2026-04-09',
      merchantId: 'merchant_fixture_other',
      merchantName: 'Example Other',
    })

    it('every charge’s bare key and every listed lane key, in the scope, sorted', () => {
      expect(
        chargeKeys({
          scope: 'personal',
          transactions: [
            ...p1(),
            OTHER,
            tx({ scope: 'strawb', merchantId: 'merchant_fixture_strawb' }),
            tx({ status: 'pending', merchantId: 'merchant_fixture_pending' }),
            tx({ amountCents: 500, merchantId: 'merchant_fixture_refund' }),
          ],
          marks: [],
        }),
      ).toStrictEqual([
        'm:merchant_fixture_other',
        'm:merchant_fixture_tools',
        'm:merchant_fixture_tools#2026-01-01:2000',
        'm:merchant_fixture_tools#2026-01-01:4620',
      ])
    })

    it('a stale lane’s key is one only while a mark pins it', () => {
      const app = at('merchant_fixture_app', 'Example App')
      // A, the 5th from January to October, forms on 5 March: the bare
      // key. B, the 20th from February to May, forms on 20 April. On 5
      // October B's last charge, 20 May, is 138 days back: stale.
      const transactions = [
        ...monthly(app, '05', 1000, JAN_TO(10)),
        ...monthly(app, '20', 2500, JAN_TO(5).slice(1)),
      ]
      const B = 'm:merchant_fixture_app#2026-02-20:2500'

      expect(
        chargeKeys({ scope: 'personal', transactions, marks: [] }),
      ).toStrictEqual(['m:merchant_fixture_app'])
      expect(
        chargeKeys({
          scope: 'personal',
          transactions,
          marks: [mark({ merchantKey: B, cancelledOn: '2026-05-21' })],
        }),
      ).toStrictEqual(['m:merchant_fixture_app', B])
      // A mark row with neither an answer nor a cancel date pins nothing.
      expect(
        chargeKeys({
          scope: 'personal',
          transactions,
          marks: [mark({ merchantKey: B })],
        }),
      ).toStrictEqual(['m:merchant_fixture_app'])
    })

    it('a lane hidden by not_subscription on its bare key is not one', () => {
      expect(
        chargeKeys({
          scope: 'personal',
          transactions: p1(),
          marks: [mark({ merchantKey: TOOLS, answer: 'not_subscription' })],
        }),
      ).toStrictEqual(['m:merchant_fixture_tools'])
    })

    it('a lane listed under notSubscriptions is one, so it can be undone', () => {
      expect(
        chargeKeys({
          scope: 'personal',
          transactions: p1(),
          marks: [
            mark({
              merchantKey: 'm:merchant_fixture_tools#2026-01-01:4620',
              answer: 'not_subscription',
            }),
          ],
        }),
      ).toContain('m:merchant_fixture_tools#2026-01-01:4620')
    })

    it('a merchant the all-history rule detects has only its bare key', () => {
      expect(
        chargeKeys({
          scope: 'personal',
          transactions: charges(MONTHLY),
          marks: [],
        }),
      ).toStrictEqual(['m:merchant_fixture_stream'])
    })

    it('a scope that is not a row scope is refused', () => {
      expect(() =>
        chargeKeys({
          scope: 'all' as unknown as RowScope,
          transactions: [],
          marks: [],
        }),
      ).toThrow(/^scope must be personal or strawb, got "all"$/)
    })
  })
})

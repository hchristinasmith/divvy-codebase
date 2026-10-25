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

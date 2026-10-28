// Safe-to-spend's inputs from stored rows (#472, prd-02 Ruling 1): the
// gathering the overview and prd-03's `get_safe_to_spend` share. The figures
// themselves are shared/__tests__/safe-to-spend.test.ts's; this file pins
// only what rows become which inputs, and which rows are refused. Every
// value below is invented; money is integer cents.

import { describe, expect, it } from 'vitest'
import {
  SAFE_TO_SPEND_SETTING_KEYS,
  SafeToSpendInputError,
  drawingIdsFromCandidates,
  gatherSafeToSpendInputs,
  safeToSpendWindowStart,
  type DrawingCandidateRow,
  type InputAccountRow,
  type InputBillRow,
  type InputTransactionRow,
  type SafeToSpendRows,
} from '../safe-to-spend-inputs.ts'
import { MAX_UNPAID_OCCURRENCES } from '../nz-dates.ts'

// 23:30 UTC on Tuesday 27 October is 12:30 NZDT on Wednesday the 28th. With
// payday on Tuesdays (the default) the last payday is 10-27, the next is
// 11-03, and the window query starts on 10-26.
const NOW = new Date('2026-10-27T23:30:00Z')

function rows(fields: Partial<SafeToSpendRows> = {}): SafeToSpendRows {
  return {
    accounts: [],
    accountRoles: [],
    settings: [],
    bills: [],
    billPayments: [],
    budgets: [],
    windowTransactions: [],
    drawingCandidates: [],
    ...fields,
  }
}

function account(fields: Partial<InputAccountRow> & { id: number }) {
  return {
    akahu_id: `acc_${fields.id}`,
    name: `Invented ${fields.id}`,
    scope: 'personal' as const,
    balance_cents: 10000,
    ...fields,
  }
}

function bill(fields: Partial<InputBillRow> & { id: number }): InputBillRow {
  return {
    scope: 'personal',
    name: `Bill ${fields.id}`,
    amount_cents: 2000,
    repeat: 'weekly',
    first_due_date: '2026-10-07',
    ...fields,
  }
}

function tx(
  fields: Partial<InputTransactionRow> & { id: number },
): InputTransactionRow {
  return {
    account_id: 'acc_1',
    date: '2026-10-27T03:00:00.000Z',
    amount_cents: -500,
    category: 'Groceries',
    category_source: 'akahu',
    status: 'settled',
    ...fields,
  }
}

function errorOf(run: () => unknown): unknown {
  try {
    run()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

function expectRefused(run: () => unknown, text: string) {
  const err = errorOf(run)
  expect(err).toBeInstanceOf(SafeToSpendInputError)
  expect((err as SafeToSpendInputError).message).toBe(text)
  expect((err as SafeToSpendInputError).reason).toBe(text)
}

const settingsOf = (r: ReturnType<typeof gatherSafeToSpendInputs>) => ({
  taxRateBasisPoints: r.taxRateBasisPoints,
  profitCents: r.profitCents,
  paydayWeekday: r.paydayWeekday,
  personalTaxOwedCents: r.personalTaxOwedCents,
})

describe('settings', () => {
  it('names exactly the four stored keys the gathering reads', () => {
    expect([...SAFE_TO_SPEND_SETTING_KEYS].sort()).toStrictEqual(
      [
        'payday_weekday',
        'personal_tax_owed_cents',
        'profit_cents',
        'tax_rate_bp',
      ].sort(),
    )
  })

  it('takes every default when no setting is stored', () => {
    expect(settingsOf(gatherSafeToSpendInputs(rows(), NOW))).toStrictEqual({
      taxRateBasisPoints: 2500,
      profitCents: 0,
      paydayWeekday: 2,
      personalTaxOwedCents: 0,
    })
  })

  it('uses stored values, the first row per key winning, and ignores other keys', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        settings: [
          { key: 'currency', value: 'not a number' },
          { key: 'payday_weekday', value: '5' },
          { key: 'personal_tax_owed_cents', value: '4321' },
          { key: 'profit_cents', value: '-300' },
          { key: 'profit_cents', value: 'older, never read' },
          { key: 'tax_rate_bp', value: '1050' },
        ],
      }),
      NOW,
    )
    expect(settingsOf(got)).toStrictEqual({
      taxRateBasisPoints: 1050,
      profitCents: -300,
      paydayWeekday: 5,
      personalTaxOwedCents: 4321,
    })
  })

  it.each<[string, unknown]>([
    ['a decimal', '12.5'],
    ['blank', ''],
    ['not a number', 'sentinel-bad-1234'],
    ['beyond a safe integer', '9007199254740993'],
    ['not text', 12],
  ])('a stored value that is %s is refused, never defaulted', (_why, value) => {
    const r = rows({ settings: [{ key: 'profit_cents', value }] })
    expectRefused(
      () => gatherSafeToSpendInputs(r, NOW),
      'a stored setting is not valid',
    )
    expectRefused(
      () => safeToSpendWindowStart(r.settings, NOW),
      'a stored setting is not valid',
    )
  })

  it('a whole-number payday the date code refuses is input invalid, not its message', () => {
    const r = rows({ settings: [{ key: 'payday_weekday', value: '9' }] })
    expectRefused(
      () => gatherSafeToSpendInputs(r, NOW),
      'safe-to-spend input invalid',
    )
    expectRefused(
      () => safeToSpendWindowStart(r.settings, NOW),
      'safe-to-spend input invalid',
    )
  })

  it('a `now` that is not an instant is a transaction-is-incomplete refusal', () => {
    expectRefused(
      () => gatherSafeToSpendInputs(rows(), new Date('not a date')),
      'a transaction is incomplete',
    )
  })
})

describe('safeToSpendWindowStart', () => {
  it('is the day before the last payday', () => {
    expect(safeToSpendWindowStart([], NOW)).toBe('2026-10-26')
  })

  it('follows the stored payday: Friday paydays put the last one on 10-23', () => {
    expect(
      safeToSpendWindowStart([{ key: 'payday_weekday', value: '5' }], NOW),
    ).toBe('2026-10-22')
  })

  it('reads today in NZ: payday starts at NZ midnight, not UTC midnight', () => {
    // 2026-10-26T10:59Z is 23:59 NZDT on Monday the 26th: last payday 10-20.
    expect(safeToSpendWindowStart([], new Date('2026-10-26T10:59:00Z'))).toBe(
      '2026-10-19',
    )
    // 2026-10-26T11:00Z is 00:00 NZDT on Tuesday the 27th: payday.
    expect(safeToSpendWindowStart([], new Date('2026-10-26T11:00:00Z'))).toBe(
      '2026-10-26',
    )
  })
})

describe('accounts', () => {
  it('every account in order, its role row or none, and a card picked field by field', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        accounts: [
          account({ id: 1, name: 'Everyday', balance_cents: 250000 }),
          account({ id: 2, scope: 'strawb', balance_cents: -4500 }),
          account({ id: 3, akahu_id: null, balance_cents: 0 }),
        ],
        accountRoles: [
          { account_id: 1, role: 'current' },
          { account_id: 2, role: 'credit_card' },
          { account_id: 99, role: 'savings' },
        ],
      }),
      NOW,
    )
    expect(got.accounts).toStrictEqual([
      { id: '1', scope: 'personal', role: 'current', balanceCents: 250000 },
      { id: '2', scope: 'strawb', role: 'credit_card', balanceCents: -4500 },
      { id: '3', scope: 'personal', role: null, balanceCents: 0 },
    ])
    expect(got.cards[0]).toStrictEqual({
      id: '1',
      name: 'Everyday',
      scope: 'personal',
      role: 'current',
      balanceCents: 250000,
    })
    for (const card of got.cards) {
      expect(Object.keys(card).sort()).toStrictEqual(
        ['balanceCents', 'id', 'name', 'role', 'scope'].sort(),
      )
    }
    expect(got.cards.map((c) => c.role)).toStrictEqual([
      'current',
      'credit_card',
      null,
    ])
  })

  it('an account with no balance is refused, never 0', () => {
    expectRefused(
      () =>
        gatherSafeToSpendInputs(
          rows({ accounts: [account({ id: 1, balance_cents: null })] }),
          NOW,
        ),
      'an account has no balance',
    )
  })
})

describe('bills', () => {
  it('every unpaid occurrence through the next payday, overdue ones included, and the paid one is none', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        bills: [
          bill({ id: 1, name: 'Flat rent', amount_cents: 20000 }),
          bill({
            id: 2,
            scope: 'strawb',
            name: 'Hosting',
            repeat: 'none',
            amount_cents: 12000,
            first_due_date: '2026-11-04',
          }),
        ],
        billPayments: [
          { bill_id: 1, due_date: '2026-10-07' },
          // Another bill's payment on the same date pays nothing here.
          { bill_id: 2, due_date: '2026-10-21' },
        ],
      }),
      NOW,
    )
    expect(got.bills).toStrictEqual(
      ['2026-10-14', '2026-10-21', '2026-10-28'].map((dueDate) => ({
        id: `1:${dueDate}`,
        scope: 'personal',
        amountCents: 20000,
        dueDate,
        paid: false,
      })),
    )
    expect(got.occurrences).toStrictEqual(
      ['2026-10-14', '2026-10-21', '2026-10-28'].map((dueDate) => ({
        billId: 1,
        name: 'Flat rent',
        scope: 'personal',
        amountCents: 20000,
        dueDate,
      })),
    )
    expect(got.leftOutBills).toStrictEqual([])
  })

  // Weekly from an anchor `weeks` weeks before the next payday (11-03) has
  // weeks + 1 occurrences through it, none paid. Worked with Date.UTC, not
  // the code under test.
  const anchorWeeksBefore = (weeks: number) =>
    new Date(Date.UTC(2026, 10, 3) - weeks * 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)

  it(`a bill with exactly ${MAX_UNPAID_OCCURRENCES} unpaid occurrences is read`, () => {
    const got = gatherSafeToSpendInputs(
      rows({
        bills: [
          bill({
            id: 7,
            first_due_date: anchorWeeksBefore(MAX_UNPAID_OCCURRENCES - 1),
          }),
        ],
      }),
      NOW,
    )
    expect(got.bills).toHaveLength(MAX_UNPAID_OCCURRENCES)
    expect(got.occurrences).toHaveLength(MAX_UNPAID_OCCURRENCES)
    expect(got.leftOutBills).toStrictEqual([])
  })

  it(`a bill past ${MAX_UNPAID_OCCURRENCES} unpaid occurrences is left out whole and named; the others stay`, () => {
    const got = gatherSafeToSpendInputs(
      rows({
        bills: [
          bill({ id: 1, name: 'Flat rent', amount_cents: 20000 }),
          bill({
            id: 7,
            scope: 'strawb',
            name: 'Ancient lease',
            amount_cents: 3300,
            first_due_date: anchorWeeksBefore(MAX_UNPAID_OCCURRENCES),
          }),
        ],
        billPayments: [{ bill_id: 1, due_date: '2026-10-07' }],
      }),
      NOW,
    )
    expect(got.leftOutBills).toStrictEqual([
      { id: 7, name: 'Ancient lease', scope: 'strawb', amount_cents: 3300 },
    ])
    expect(got.bills.map((b) => b.id)).toStrictEqual([
      '1:2026-10-14',
      '1:2026-10-21',
      '1:2026-10-28',
    ])
    expect(got.occurrences.every((o) => o.billId === 1)).toBe(true)
  })

  it('paying one occurrence brings a bill back under the limit', () => {
    const anchor = anchorWeeksBefore(MAX_UNPAID_OCCURRENCES)
    const got = gatherSafeToSpendInputs(
      rows({
        bills: [bill({ id: 7, first_due_date: anchor })],
        billPayments: [{ bill_id: 7, due_date: anchor }],
      }),
      NOW,
    )
    expect(got.leftOutBills).toStrictEqual([])
    expect(got.bills).toHaveLength(MAX_UNPAID_OCCURRENCES)
  })

  it('a bill the date code refuses is input invalid, not its message', () => {
    expectRefused(
      () =>
        gatherSafeToSpendInputs(
          rows({ bills: [bill({ id: 1, first_due_date: '2026-02-30' })] }),
          NOW,
        ),
      'safe-to-spend input invalid',
    )
  })
})

describe('budgets', () => {
  it('each row as a budget input, in the order given', () => {
    expect(
      gatherSafeToSpendInputs(
        rows({
          budgets: [
            {
              id: 1,
              scope: 'personal',
              category: 'Groceries',
              limit_cents: 20000,
            },
            {
              id: 3,
              scope: 'strawb',
              category: 'Software',
              limit_cents: 10000,
            },
          ],
        }),
        NOW,
      ).budgets,
    ).toStrictEqual([
      { id: '1', scope: 'personal', category: 'Groceries', limitCents: 20000 },
      { id: '3', scope: 'strawb', category: 'Software', limitCents: 10000 },
    ])
  })
})

describe('window transactions', () => {
  const stored = [account({ id: 1 }), account({ id: 2, scope: 'strawb' })]

  it('each row on a stored account, on its NZ date, against the account id', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        accounts: stored,
        windowTransactions: [
          // 12:00 UTC on the 26th is 01:00 NZDT on the 27th.
          tx({ id: 1, date: '2026-10-26T12:00:00.000Z', amount_cents: -8000 }),
          tx({
            id: 2,
            account_id: 'acc_2',
            status: 'pending',
            category: null,
            amount_cents: -3000,
          }),
        ],
      }),
      NOW,
    )
    expect(got.transactions).toStrictEqual([
      {
        accountId: '1',
        date: '2026-10-27',
        amountCents: -8000,
        category: 'Groceries',
        status: 'settled',
      },
      {
        accountId: '2',
        date: '2026-10-27',
        amountCents: -3000,
        category: null,
        status: 'pending',
      },
    ])
  })

  it('skips a row on an account that is not stored, or on none, even when incomplete', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        accounts: stored,
        windowTransactions: [
          tx({
            id: 1,
            account_id: 'acc_nobody',
            date: null,
            amount_cents: null,
          }),
          tx({ id: 2, account_id: null, date: null }),
          tx({ id: 3 }),
        ],
      }),
      NOW,
    )
    expect(got.transactions.map((t) => t.amountCents)).toStrictEqual([-500])
  })

  it.each<[string, Partial<InputTransactionRow>]>([
    ['no date', { date: null }],
    ['no amount', { amount_cents: null }],
    ['a date that is not a date', { date: 'garbage-date-sentinel' }],
  ])('a stored row with %s is refused', (_why, fields) => {
    expectRefused(
      () =>
        gatherSafeToSpendInputs(
          rows({
            accounts: stored,
            windowTransactions: [tx({ id: 1, ...fields })],
          }),
          NOW,
        ),
      'a transaction is incomplete',
    )
  })
})

describe('drawings (prd-02 Ruling 15)', () => {
  const pair: DrawingCandidateRow[] = [
    {
      id: 101,
      scope: 'strawb',
      date: '2026-10-27T05:00:00.000Z',
      amount_cents: -30000,
    },
    {
      id: 102,
      scope: 'personal',
      date: '2026-10-27T20:00:00.000Z',
      amount_cents: 30000,
    },
  ]

  it('a half not categorised by hand is handed over as Drawings; one set by hand keeps hers', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        accounts: [account({ id: 1 }), account({ id: 2, scope: 'strawb' })],
        drawingCandidates: pair,
        windowTransactions: [
          tx({
            id: 101,
            account_id: 'acc_2',
            amount_cents: -30000,
            category: 'Software',
          }),
          tx({
            id: 102,
            amount_cents: 30000,
            category: 'Salary',
            category_source: 'user',
          }),
          tx({ id: 103 }),
        ],
      }),
      NOW,
    )
    expect([...got.drawingIds].sort((a, b) => a - b)).toStrictEqual([101, 102])
    expect(
      got.transactions.map((t) => [t.amountCents, t.category]),
    ).toStrictEqual([
      [-30000, 'Drawings'],
      [30000, 'Salary'],
      [-500, 'Groceries'],
    ])
  })

  it('a 1-cent short inflow is no drawing, so the outflow keeps its category', () => {
    const got = gatherSafeToSpendInputs(
      rows({
        accounts: [account({ id: 2, scope: 'strawb' })],
        drawingCandidates: [pair[0], { ...pair[1], amount_cents: 29999 }],
        windowTransactions: [
          tx({
            id: 101,
            account_id: 'acc_2',
            amount_cents: -30000,
            category: 'Software',
          }),
        ],
      }),
      NOW,
    )
    expect(got.drawingIds.size).toBe(0)
    expect(got.transactions[0].category).toBe('Software')
  })

  it.each<[string, DrawingCandidateRow]>([
    [
      'a date that is not an instant',
      { id: 5, scope: 'strawb', date: 'not a date', amount_cents: -30000 },
    ],
    [
      'a date past year 9999',
      {
        id: 5,
        scope: 'strawb',
        date: '+275760-09-13T00:00:00.000Z',
        amount_cents: -30000,
      },
    ],
    [
      'an amount that is not whole cents',
      {
        id: 5,
        scope: 'strawb',
        date: '2026-10-27T05:00:00.000Z',
        amount_cents: -30000.5,
      },
    ],
    [
      'an amount beyond a safe integer',
      {
        id: 5,
        scope: 'strawb',
        date: '2026-10-27T05:00:00.000Z',
        amount_cents: -(2 ** 53),
      },
    ],
  ])(
    'skips a candidate with %s and still finds the pair beside it',
    (_why, odd) => {
      expect(
        [...drawingIdsFromCandidates([...pair, odd])].sort((a, b) => a - b),
      ).toStrictEqual([101, 102])
    },
  )

  it('places a candidate on its NZ date: 3 NZ days apart pairs, though 4 UTC days', () => {
    expect(
      [
        ...drawingIdsFromCandidates([
          // 00:30 NZDT on the 28th, and 23:30 NZDT on the 31st.
          {
            id: 1,
            scope: 'strawb',
            date: '2026-10-27T11:30:00.000Z',
            amount_cents: -30000,
          },
          {
            id: 2,
            scope: 'personal',
            date: '2026-10-31T10:30:00.000Z',
            amount_cents: 30000,
          },
        ]),
      ].sort((a, b) => a - b),
    ).toStrictEqual([1, 2])
  })

  it("the matcher's own refusal leaves drawingIdsFromCandidates as it is, and the gathering as input invalid", () => {
    const twice: DrawingCandidateRow[] = [pair[0], { ...pair[0] }]
    expect(() => drawingIdsFromCandidates(twice)).toThrow(RangeError)
    expectRefused(
      () => gatherSafeToSpendInputs(rows({ drawingCandidates: twice }), NOW),
      'safe-to-spend input invalid',
    )
  })
})

describe('which refusal comes first', () => {
  it('a bad setting before an account with no balance', () => {
    expectRefused(
      () =>
        gatherSafeToSpendInputs(
          rows({
            settings: [{ key: 'tax_rate_bp', value: '1.5' }],
            accounts: [account({ id: 1, balance_cents: null })],
          }),
          NOW,
        ),
      'a stored setting is not valid',
    )
  })

  it('an account with no balance before a bad bill, a bad drawing candidate or an incomplete row', () => {
    expectRefused(
      () =>
        gatherSafeToSpendInputs(
          rows({
            accounts: [account({ id: 1, balance_cents: null })],
            bills: [bill({ id: 1, first_due_date: '2026-02-30' })],
            drawingCandidates: [
              {
                id: 1,
                scope: 'strawb',
                date: '2026-10-27T05:00:00.000Z',
                amount_cents: -1,
              },
              {
                id: 1,
                scope: 'strawb',
                date: '2026-10-27T05:00:00.000Z',
                amount_cents: -1,
              },
            ],
            windowTransactions: [tx({ id: 1, date: null })],
          }),
          NOW,
        ),
      'an account has no balance',
    )
  })

  it('a bad drawing candidate before an incomplete window row', () => {
    expectRefused(
      () =>
        gatherSafeToSpendInputs(
          rows({
            accounts: [account({ id: 1 })],
            drawingCandidates: [
              {
                id: 1,
                scope: 'strawb',
                date: '2026-10-27T05:00:00.000Z',
                amount_cents: -1,
              },
              {
                id: 1,
                scope: 'strawb',
                date: '2026-10-27T05:00:00.000Z',
                amount_cents: -1,
              },
            ],
            windowTransactions: [tx({ id: 2, date: null })],
          }),
          NOW,
        ),
      'safe-to-spend input invalid',
    )
  })
})

describe('the gathered inputs', () => {
  it('carry exactly the SafeToSpendInput fields but scope, and what the alerts read', () => {
    expect(
      Object.keys(gatherSafeToSpendInputs(rows(), NOW)).sort(),
    ).toStrictEqual(
      [
        'today',
        'paydayWeekday',
        'taxRateBasisPoints',
        'profitCents',
        'personalTaxOwedCents',
        'accounts',
        'bills',
        'budgets',
        'transactions',
        'cards',
        'occurrences',
        'leftOutBills',
        'drawingIds',
      ].sort(),
    )
    expect(gatherSafeToSpendInputs(rows(), NOW).today).toBe('2026-10-28')
  })
})

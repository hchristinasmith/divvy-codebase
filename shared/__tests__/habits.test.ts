import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { AccountRole, RowScope, Scope } from '../contracts.ts'
import {
  TRAILING_DAYS,
  TRANSFER_WINDOW_DAYS,
  VERDICT_LIST_LIMIT,
  VERDICT_WINDOW_DAYS,
  findOwnTransfers,
  habitStreaks,
  habitsReadFrom,
  noOverdraftDays,
  recentSpendingIds,
  runwayAssetsCents,
  runwayTenths,
  trailingSpendCents,
  type HabitAccount,
  type HabitTransaction,
  type HabitsInput,
} from '../habits.ts'

// Hand-worked integer-cent fixtures for shared/habits.ts (issue #52). Today
// is 2026-10-28 in NZ throughout; `ago(n)` is the NZ date n days before.
// Every value is invented.

const TODAY = '2026-10-28'

function ago(n: number, from = TODAY): string {
  const [y, m, d] = from.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(y, m - 1, d - n)
  return date.toISOString().slice(0, 10)
}

function acct(
  id: string,
  scope: RowScope,
  role: AccountRole | null,
  balanceCents: number,
): HabitAccount {
  return { id, scope, role, balanceCents }
}

let nextId = 1
function tx(
  accountId: string,
  date: string,
  amountCents: number,
  fields: Partial<HabitTransaction> = {},
): HabitTransaction {
  return {
    id: String(nextId++),
    accountId,
    date,
    amountCents,
    status: 'settled',
    balanceCents: 1000,
    ...fields,
  }
}

function input(
  accounts: HabitAccount[],
  transactions: HabitTransaction[],
  scope: Scope = 'all',
): HabitsInput {
  return { scope, today: TODAY, accounts, transactions }
}

const EVERYDAY = acct('1', 'personal', 'current', 1_000_000)
const SAVER = acct('2', 'personal', 'savings', 0)
const CARD = acct('3', 'personal', 'credit_card', 0)
const TRADING = acct('4', 'strawb', 'current', 0)
const STRAWB_SAVER = acct('5', 'strawb', 'savings', 0)

describe('constants', () => {
  it('are the windows the module documents', () => {
    expect(TRAILING_DAYS).toBe(30)
    expect(VERDICT_WINDOW_DAYS).toBe(90)
    expect(VERDICT_LIST_LIMIT).toBe(50)
    expect(TRANSFER_WINDOW_DAYS).toBe(2)
  })

  it('habitsReadFrom is the 90-day window start less the transfer window', () => {
    // today − 89 − 2 = today − 91
    expect(habitsReadFrom(TODAY)).toBe(ago(91))
    expect(habitsReadFrom(TODAY)).toBe('2026-07-29')
  })

  it('dates are built without the two-digit-year trap', () => {
    // Date.UTC(50, …) would be 1950.
    expect(habitsReadFrom('0050-03-01')).toBe('0049-11-30')
  })
})

describe('runwayTenths: floor(assets × 10 ÷ trailing spend)', () => {
  const runway = (assets: number, spend: number) =>
    runwayTenths(
      input(
        [acct('1', 'personal', 'current', assets)],
        spend === 0 ? [] : [tx('1', TODAY, -spend)],
      ),
    )

  it.each([
    // 10,000,000 ÷ 128,000 = 78.125
    [1_000_000, 128_000, 78],
    // 10,000,000 ÷ 127,000 = 78.74…: half-up would give 79
    [1_000_000, 127_000, 78],
    // 9,999,990 ÷ 100,000 = 99.9999
    [999_999, 100_000, 99],
    // exact
    [500_000, 100_000, 50],
    // less than a tenth
    [1, 100_000, 0],
  ])('%i ÷ %i → %i', (assets, spend, expected) => {
    expect(runway(assets, spend)).toBe(expected)
  })

  it('no spend is unbounded: null', () => {
    expect(runway(1_000_000, 0)).toBeNull()
  })

  it('assets of 0 or less are 0, even with no spend', () => {
    expect(runway(0, 0)).toBe(0)
    expect(runway(-5_000, 100_000)).toBe(0)
  })

  it('a float balance throws rather than drifting', () => {
    expect(() => runway(1000.5, 100)).toThrow(TypeError)
  })

  it('a float amount throws', () => {
    expect(() =>
      runwayTenths(input([EVERYDAY], [tx('1', TODAY, -100.5)])),
    ).toThrow(TypeError)
  })

  it('assets × 10 past the safe integers throws a RangeError', () => {
    expect(() => runway(1_000_000_000_000_000, 100)).toThrow(RangeError)
  })

  it('assets are current + savings in scope', () => {
    const accounts = [
      acct('1', 'personal', 'current', 600_000),
      acct('2', 'personal', 'savings', 400_000),
      acct('4', 'strawb', 'current', 9_000_000),
    ]
    const rows = [tx('1', TODAY, -128_000)]
    // (600,000 + 400,000) × 10 ÷ 128,000 = 78.125
    expect(runwayTenths(input(accounts, rows, 'personal'))).toBe(78)
  })
})

describe('runwayAssetsCents (decision pending: card debt)', () => {
  // Provisional: Σ current + savings in scope; card debt not subtracted.
  const accounts = [
    acct('1', 'personal', 'current', 300_000),
    acct('2', 'personal', 'savings', 200_000),
    acct('3', 'personal', 'credit_card', -150_000),
    acct('6', 'personal', 'tax_pot', 700_000),
    acct('7', 'personal', null, 50_000),
    acct('4', 'strawb', 'current', 80_000),
    acct('5', 'strawb', 'savings', 20_000),
  ]

  it('personal: current + savings only', () => {
    expect(runwayAssetsCents(accounts, 'personal')).toBe(500_000)
  })

  it('strawb: its own current + savings', () => {
    expect(runwayAssetsCents(accounts, 'strawb')).toBe(100_000)
  })

  it('all: both scopes', () => {
    expect(runwayAssetsCents(accounts, 'all')).toBe(600_000)
  })

  it('a card owing money does not reduce assets (provisional)', () => {
    expect(
      runwayAssetsCents(
        [
          acct('1', 'personal', 'current', 100),
          CARD,
          acct('8', 'personal', 'credit_card', -999),
        ],
        'personal',
      ),
    ).toBe(100)
  })
})

describe('trailingSpendCents', () => {
  it('counts day −29 and not day −30', () => {
    const rows = [
      tx('1', ago(TRAILING_DAYS - 1), -1_000),
      tx('1', ago(TRAILING_DAYS), -20_000),
    ]
    expect(trailingSpendCents(input([EVERYDAY], rows))).toBe(1_000)
  })

  it('counts settled and pending, any role, never nets money in', () => {
    const rows = [
      tx('1', TODAY, -1_000),
      tx('1', TODAY, -200, { status: 'pending', balanceCents: null }),
      tx('3', ago(3), -30),
      // A refund on the same account: not a transfer, never netted.
      tx('1', ago(1), 5_000),
    ]
    expect(trailingSpendCents(input([EVERYDAY, CARD], rows))).toBe(1_230)
  })

  it('ignores a row dated after today', () => {
    const rows = [tx('1', '2026-10-29', -1_000)]
    expect(trailingSpendCents(input([EVERYDAY], rows))).toBe(0)
  })

  it('scope isolation: the other scope adds nothing', () => {
    const rows = [tx('1', TODAY, -1_000), tx('4', TODAY, -7_000)]
    expect(
      trailingSpendCents(input([EVERYDAY, TRADING], rows, 'personal')),
    ).toBe(1_000)
    expect(trailingSpendCents(input([EVERYDAY, TRADING], rows, 'strawb'))).toBe(
      7_000,
    )
    expect(trailingSpendCents(input([EVERYDAY, TRADING], rows, 'all'))).toBe(
      8_000,
    )
  })

  it('a row on an unknown account throws', () => {
    expect(() =>
      trailingSpendCents(input([EVERYDAY], [tx('9', TODAY, -1)])),
    ).toThrow(RangeError)
  })
})

describe('findOwnTransfers (decision pending: transfer detection)', () => {
  // Provisional option A: −X and +X on two different accounts within
  // TRANSFER_WINDOW_DAYS, one to one, nearest dates first, lowest id on ties.
  const spend = (
    rows: HabitTransaction[],
    scope: Scope = 'all',
    accounts = [EVERYDAY, SAVER, TRADING],
  ) => trailingSpendCents(input(accounts, rows, scope))

  it('pairs an outflow and inflow two days apart, and drops both from spend', () => {
    const out = tx('1', ago(5), -50_000)
    const inn = tx('2', ago(3), 50_000)
    const pairs = findOwnTransfers([out, inn])
    expect(pairs.get(out.id)).toBe(inn.id)
    expect(pairs.get(inn.id)).toBe(out.id)
    expect(spend([out, inn])).toBe(0)
  })

  it('does not pair at three days apart', () => {
    const rows = [tx('1', ago(5), -50_000), tx('2', ago(2), 50_000)]
    expect(findOwnTransfers(rows).size).toBe(0)
    expect(spend(rows)).toBe(50_000)
  })

  it('does not pair on the same account', () => {
    const rows = [tx('1', ago(5), -50_000), tx('1', ago(5), 50_000)]
    expect(findOwnTransfers(rows).size).toBe(0)
    expect(spend(rows)).toBe(50_000)
  })

  it('does not pair different amounts', () => {
    const rows = [tx('1', ago(5), -50_000), tx('2', ago(5), 50_001)]
    expect(findOwnTransfers(rows).size).toBe(0)
  })

  it('one inflow cannot cancel two outflows', () => {
    const rows = [
      tx('1', ago(5), -50_000),
      tx('1', ago(4), -50_000),
      tx('2', ago(4), 50_000),
    ]
    expect(findOwnTransfers(rows).size).toBe(2)
    expect(spend(rows)).toBe(50_000)
  })

  it('takes the nearest date first, then the lowest id', () => {
    const far = tx('1', ago(6), -100)
    const near = tx('1', ago(4), -100)
    const inn = tx('2', ago(4), 100)
    expect(findOwnTransfers([far, near, inn]).get(inn.id)).toBe(near.id)

    const a = tx('1', ago(4), -100)
    const b = tx('1', ago(4), -100)
    const inn2 = tx('2', ago(4), 100)
    expect(findOwnTransfers([b, a, inn2]).get(inn2.id)).toBe(a.id)
  })

  it('compares ids as integers, so 9 is lower than 10', () => {
    const rows: HabitTransaction[] = [
      { ...tx('1', ago(4), -100), id: '10' },
      { ...tx('1', ago(4), -100), id: '9' },
      { ...tx('2', ago(4), 100), id: '11' },
    ]
    expect(findOwnTransfers(rows).get('11')).toBe('9')
  })

  it('a pending leg pairs', () => {
    const rows = [
      tx('1', ago(1), -2_500, { status: 'pending', balanceCents: null }),
      tx('2', TODAY, 2_500),
    ]
    expect(findOwnTransfers(rows).size).toBe(2)
    expect(spend(rows)).toBe(0)
  })

  it('Strawb → Personal is not spend in All, and is Strawb spend in Strawb', () => {
    const rows = [tx('4', ago(2), -40_000), tx('1', ago(2), 40_000)]
    expect(spend(rows, 'all')).toBe(0)
    expect(spend(rows, 'strawb')).toBe(40_000)
    // Personal sees only the inflow, which is never spend.
    expect(spend(rows, 'personal')).toBe(0)
  })

  it('scope isolation: a Strawb row cannot take a Personal leg’s partner', () => {
    // Personal everyday → Personal saver. A Strawb inflow of the same amount
    // that day, with a lower id than the saver leg, must not move Personal.
    const out = { ...tx('1', ago(8), -50_000), id: '10' }
    const strawbIn = { ...tx('4', ago(8), 50_000), id: '11' }
    const saverIn = { ...tx('2', ago(8), 50_000), id: '12' }
    const personalOnly = [out, saverIn]
    const withStrawb = [out, strawbIn, saverIn]
    expect(spend(personalOnly, 'personal')).toBe(0)
    expect(spend(withStrawb, 'personal')).toBe(0)
    const accounts = [EVERYDAY, SAVER, TRADING]
    expect(recentSpendingIds(input(accounts, withStrawb, 'personal'))).toEqual(
      [],
    )
  })

  it('a pair straddling the trailing window start still pairs', () => {
    const rows = [
      tx('1', ago(TRAILING_DAYS - 1), -9_000),
      tx('2', ago(TRAILING_DAYS + 1), 9_000),
    ]
    expect(spend(rows)).toBe(0)
  })

  it('a pair straddling the verdict window start still pairs', () => {
    const rows = [
      tx('1', ago(VERDICT_WINDOW_DAYS - 1), -9_000),
      tx('2', ago(VERDICT_WINDOW_DAYS + 1), 9_000),
    ]
    expect(recentSpendingIds(input([EVERYDAY, SAVER], rows))).toEqual([])
  })

  it('older history passed in changes nothing (pairing reads from habitsReadFrom)', () => {
    // habitsReadFrom(today) is ago(91). An older outflow on ago(92) would be
    // the nearer partner (1 day) for the inflow on ago(91), and leave the
    // window's outflow on ago(89) (2 days) unpaired and listed; it is not
    // read, so the inflow pairs with ago(89).
    const out = tx('1', ago(VERDICT_WINDOW_DAYS - 1), -9_000)
    const inflow = tx('2', ago(VERDICT_WINDOW_DAYS + 1), 9_000)
    const older = tx('5', ago(VERDICT_WINDOW_DAYS + 2), -9_000)
    const accounts = [EVERYDAY, SAVER, STRAWB_SAVER]
    expect(recentSpendingIds(input(accounts, [out, inflow]))).toEqual([])
    expect(recentSpendingIds(input(accounts, [out, inflow, older]))).toEqual([])
  })
})

describe('noOverdraftDays: days from start to today, both counted', () => {
  const streak = (
    rows: HabitTransaction[],
    accounts: HabitAccount[] = [EVERYDAY],
    scope: Scope = 'all',
  ) => noOverdraftDays(input(accounts, rows, scope))

  it('never overdrawn: bounded by the first settled row, today counted', () => {
    // ago(9) … today is 10 days.
    expect(streak([tx('1', ago(9), -1, { balanceCents: 500 })])).toBe(10)
  })

  it('overdrawn today → 0', () => {
    expect(
      streak([
        tx('1', ago(9), -1, { balanceCents: 500 }),
        tx('1', TODAY, -1, { balanceCents: -1 }),
      ]),
    ).toBe(0)
  })

  it('last overdrawn yesterday, back above 0 today → 1', () => {
    expect(
      streak([
        tx('1', ago(9), -1, { balanceCents: 500 }),
        tx('1', ago(1), -1, { balanceCents: -1 }),
        tx('1', TODAY, 10, { balanceCents: 9 }),
      ]),
    ).toBe(1)
  })

  it('one negative row makes its whole day overdrawn', () => {
    expect(
      streak([
        tx('1', ago(9), -1, { balanceCents: 500 }),
        tx('1', ago(1), -1, { balanceCents: -1 }),
        tx('1', ago(1), 10, { balanceCents: 9 }),
        tx('1', TODAY, 10, { balanceCents: 19 }),
      ]),
    ).toBe(1)
  })

  it('a rowless day keeps the overdrawn state of the row day before it', () => {
    // Overdrawn on ago(5); no rows on ago(4), ago(3); back above on ago(2).
    // Last overdrawn day ago(3); start ago(2); ago(2)…today = 3 days.
    expect(
      streak([
        tx('1', ago(9), -1, { balanceCents: 500 }),
        tx('1', ago(5), -1, { balanceCents: -1 }),
        tx('1', ago(2), 10, { balanceCents: 9 }),
      ]),
    ).toBe(3)
  })

  it('an overdraft with no later row day runs through today → 0', () => {
    // The balance now is non-negative, but no row says when it recovered.
    expect(streak([tx('1', ago(5), -1, { balanceCents: -1 })])).toBe(0)
  })

  it('a balance below 0 now → 0', () => {
    expect(
      streak(
        [tx('1', ago(9), -1, { balanceCents: 500 })],
        [acct('1', 'personal', 'current', -1)],
      ),
    ).toBe(0)
  })

  it('a row with no balance: known from the next day whose row carries one', () => {
    // NULL balance on ago(4); ago(3) has no row, so it carries ago(4)'s
    // unknown state. Known from ago(2); ago(2)…today = 3 days.
    expect(
      streak([
        tx('1', ago(9), -1, { balanceCents: 500 }),
        tx('1', ago(4), -1, { balanceCents: null }),
        tx('1', ago(2), -1, { balanceCents: 600 }),
      ]),
    ).toBe(3)
  })

  it('a row with no balance yesterday and none after → null, not 1', () => {
    // ago(5) is evidenced and clean, but ago(1) moved the balance by an
    // unknown amount and no later row says what it is.
    expect(
      streak([
        tx('1', ago(5), -1, { balanceCents: 500 }),
        tx('1', ago(1), -1, { balanceCents: null }),
      ]),
    ).toBeNull()
  })

  it('a row with no balance today → null, not 0 (no overdraft is evidenced)', () => {
    const rows = [
      tx('1', ago(9), -1, { balanceCents: 500 }),
      tx('1', TODAY, -1, { balanceCents: null }),
    ]
    expect(streak(rows)).toBeNull()
    expect(habitStreaks(input([EVERYDAY], rows))).toEqual([])
  })

  it('a row with a balance the same day as one without is not evidence', () => {
    // Rows within a day have no order: the NULL row may be the later one.
    expect(
      streak([
        tx('1', ago(9), -1, { balanceCents: 500 }),
        tx('1', ago(2), -1, { balanceCents: 400 }),
        tx('1', ago(2), -1, { balanceCents: null }),
      ]),
    ).toBeNull()
  })

  it('every settled row with no balance → null, not days since the last', () => {
    expect(
      streak([
        tx('1', ago(4), -1, { balanceCents: null }),
        tx('1', ago(2), -1, { balanceCents: null }),
      ]),
    ).toBeNull()
  })

  it('a row with no balance does not end an overdraft', () => {
    expect(
      streak([
        tx('1', ago(6), -1, { balanceCents: -1 }),
        tx('1', ago(4), 1, { balanceCents: null }),
      ]),
    ).toBe(0)
  })

  it('no settled rows → null, though the balance now is not below 0', () => {
    // The balance now is one moment, not a day of evidence.
    expect(streak([])).toBeNull()
    expect(
      streak([tx('1', TODAY, -1, { status: 'pending', balanceCents: null })]),
    ).toBeNull()
  })

  it('two accounts: the later bound and the later overdraft win', () => {
    const a = acct('1', 'personal', 'current', 100)
    const b = acct('8', 'personal', 'current', 100)
    // a: data from ago(20), never overdrawn. b: data from ago(6).
    expect(
      streak(
        [
          tx('1', ago(20), -1, { balanceCents: 5 }),
          tx('8', ago(6), -1, { balanceCents: 5 }),
        ],
        [a, b],
      ),
    ).toBe(7)
    // b overdrawn on ago(3), back on ago(2): start ago(2) → 3 days.
    expect(
      streak(
        [
          tx('1', ago(20), -1, { balanceCents: 5 }),
          tx('8', ago(6), -1, { balanceCents: 5 }),
          tx('8', ago(3), -1, { balanceCents: -5 }),
          tx('8', ago(2), 9, { balanceCents: 4 }),
        ],
        [a, b],
      ),
    ).toBe(3)
  })

  it('two accounts: one with no evidence makes the streak null', () => {
    const a = acct('1', 'personal', 'current', 100)
    const b = acct('8', 'personal', 'current', 100)
    expect(
      streak(
        [
          tx('1', ago(20), -1, { balanceCents: 5 }),
          tx('8', ago(3), -1, { balanceCents: null }),
        ],
        [a, b],
      ),
    ).toBeNull()
    // b has no settled rows at all.
    expect(
      streak([tx('1', ago(20), -1, { balanceCents: 5 })], [a, b]),
    ).toBeNull()
  })

  it('two accounts: an evidenced overdraft today wins over no evidence → 0', () => {
    const a = acct('1', 'personal', 'current', 100)
    const b = acct('8', 'personal', 'current', 100)
    // b, with no rows, is listed first so the order cannot hide the 0.
    expect(
      streak(
        [
          tx('1', ago(20), -1, { balanceCents: 5 }),
          tx('1', ago(2), -1, { balanceCents: -5 }),
        ],
        [b, a],
      ),
    ).toBe(0)
  })

  it('credit-card and savings balances are not read', () => {
    const rows = [
      tx('1', ago(9), -1, { balanceCents: 500 }),
      tx('3', ago(1), -1, { balanceCents: -90_000 }),
      tx('2', ago(1), -1, { balanceCents: -1 }),
    ]
    expect(
      streak(rows, [
        EVERYDAY,
        SAVER,
        acct('3', 'personal', 'credit_card', -90_000),
      ]),
    ).toBe(10)
  })

  it('pending rows are not read', () => {
    const rows = [
      tx('1', ago(9), -1, { balanceCents: 500 }),
      tx('1', TODAY, -1, { status: 'pending', balanceCents: -1 }),
      tx('1', ago(3), -1, { status: 'pending', balanceCents: null }),
    ]
    expect(streak(rows)).toBe(10)
  })

  it('scope isolation: the other scope’s overdraft does not break this one', () => {
    const accounts = [EVERYDAY, acct('4', 'strawb', 'current', 100)]
    const rows = [
      tx('1', ago(9), -1, { balanceCents: 500 }),
      tx('4', ago(9), -1, { balanceCents: 500 }),
      tx('4', TODAY, -1, { balanceCents: -1 }),
    ]
    expect(streak(rows, accounts, 'personal')).toBe(10)
    expect(streak(rows, accounts, 'strawb')).toBe(0)
    expect(streak(rows, accounts, 'all')).toBe(0)
  })

  it('no current account in scope → null, and habitStreaks omits it', () => {
    const accounts = [EVERYDAY, STRAWB_SAVER]
    expect(streak([], accounts, 'strawb')).toBeNull()
    expect(habitStreaks(input(accounts, [], 'strawb'))).toEqual([])
  })

  it('habitStreaks holds only no_overdraft, with its days', () => {
    const streaks = habitStreaks(
      input([EVERYDAY], [tx('1', ago(9), -1, { balanceCents: 500 })]),
    )
    expect(streaks).toStrictEqual([
      { key: 'no_overdraft', label: 'No overdraft', days: 10 },
    ])
    expect(Object.keys(streaks[0]).sort()).toEqual(['days', 'key', 'label'])
  })
})

describe('recentSpendingIds', () => {
  const ids = (rows: HabitTransaction[], scope: Scope = 'all') =>
    recentSpendingIds(input([EVERYDAY, CARD, TRADING], rows, scope))

  it('settled outflows only, newest date first, then highest id', () => {
    const older = tx('1', ago(3), -100)
    const pending = tx('1', TODAY, -100, {
      status: 'pending',
      balanceCents: null,
    })
    // 150, so it pairs with nothing.
    const inflow = tx('1', TODAY, 150)
    const a = tx('3', TODAY, -100)
    const b = tx('1', TODAY, -200)
    expect(ids([older, pending, inflow, a, b])).toEqual([b.id, a.id, older.id])
  })

  it('orders ids as integers: 10 before 9 on the same day', () => {
    const rows: HabitTransaction[] = [
      { ...tx('1', TODAY, -1), id: '9' },
      { ...tx('1', TODAY, -1), id: '10' },
    ]
    expect(ids(rows)).toEqual(['10', '9'])
  })

  it('day −89 is in, day −90 is out', () => {
    const inside = tx('1', ago(VERDICT_WINDOW_DAYS - 1), -100)
    const outside = tx('1', ago(VERDICT_WINDOW_DAYS), -100)
    expect(ids([inside, outside])).toEqual([inside.id])
  })

  it('caps the list at VERDICT_LIST_LIMIT, keeping the newest', () => {
    const rows = Array.from({ length: VERDICT_LIST_LIMIT + 5 }, (_, i) =>
      tx('1', ago(i), -100),
    )
    const listed = ids(rows)
    expect(listed).toHaveLength(VERDICT_LIST_LIMIT)
    expect(listed[0]).toBe(rows[0].id)
    expect(listed.at(-1)).toBe(rows[VERDICT_LIST_LIMIT - 1].id)
  })

  it('scope isolation both ways', () => {
    const p = tx('1', TODAY, -100)
    const s = tx('4', TODAY, -100)
    expect(ids([p, s], 'personal')).toEqual([p.id])
    expect(ids([p, s], 'strawb')).toEqual([s.id])
  })

  it('a transfer leg is not listed', () => {
    const out = tx('1', TODAY, -7_700)
    const inn = tx('4', TODAY, 7_700)
    expect(ids([out, inn], 'all')).toEqual([])
    // Personal → Strawb is Personal's spend in its own view.
    expect(ids([out, inn], 'personal')).toEqual([out.id])
  })
})

describe('the module source', () => {
  it('imports only from shared/, so prd-03 can load it without server/', () => {
    const source = readFileSync(
      Path.join(
        Path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'habits.ts',
      ),
      'utf8',
    )
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    expect(specifiers).toEqual([
      './contracts.ts',
      './money.ts',
      './safe-to-spend.ts',
    ])
  })
})

describe('input checks', () => {
  it('a duplicate transaction id throws', () => {
    const row = tx('1', TODAY, -1)
    expect(() =>
      recentSpendingIds(input([EVERYDAY], [row, { ...row }])),
    ).toThrow(RangeError)
  })

  it('a non-numeric id throws', () => {
    expect(() =>
      recentSpendingIds(
        input([EVERYDAY], [{ ...tx('1', TODAY, -1), id: 'abc' }]),
      ),
    ).toThrow(RangeError)
  })

  it('a bad date throws', () => {
    expect(() =>
      recentSpendingIds(input([EVERYDAY], [tx('1', '2026-02-30', -1)])),
    ).toThrow(RangeError)
  })

  it('a bad scope throws', () => {
    expect(() =>
      runwayTenths({ ...input([EVERYDAY], []), scope: 'both' as Scope }),
    ).toThrow(RangeError)
  })
})

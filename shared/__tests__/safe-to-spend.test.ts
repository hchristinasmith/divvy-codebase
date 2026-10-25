// The fixed test table for safe-to-spend: the contract prd-02 says to hold
// ("The one risk worth watching"). Every expected number below is worked by
// hand in the comment above it, from the rows in this file, and written as a
// literal. None is computed by the code under test. To check a case, redo
// the arithmetic in its comment. Weekdays were checked against a calendar,
// not against the code under test.
//
//   safe = liquid − unpaid bills − remaining budget − tax hold − card debt
//   (prd-02 Ruling 2, amended by Rulings 9, 10, 11 and 12;
//   shared/safe-to-spend.ts)
//
// Payday is weekly (Ruling 9). Each scope holds its own tax against its own
// pot, and All holds the sum of both (Ruling 11). Strawb's bills are paid
// from the Strawb pot first: buffer = max(0, min(Strawb pot, Strawb unpaid
// bills)), the Strawb hold nets only `pot − buffer`, and only Strawb's bills
// beyond the buffer come out of liquid (Ruling 12). Card debt is what is
// owed on a credit card, `max(0, −balance)` (Ruling 10): Akahu reports owed
// as a negative balance, a convention confirmed against live data on
// 2026-10-25.

import { describe, expect, it } from 'vitest'
import {
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type BudgetLine,
  type SafeToSpendResult,
  type SettingsResponse,
} from '../contracts.ts'
import {
  budgetSpentCents,
  daysBetween,
  daysInMonth,
  lastPayday,
  nextPayday,
  safeToSpend,
  type SafeToSpendAccount,
  type SafeToSpendBill,
  type SafeToSpendBudget,
  type SafeToSpendInput,
  type SafeToSpendTransaction,
} from '../safe-to-spend.ts'

// ---------------------------------------------------------------------------
// The base fixture. Today is Fri 23 Oct 2026, payday is Tuesday (2):
//   last payday Tue 2026-10-20, next payday Tue 2026-10-27, 4 days to go.
// Strawb tax: 28% (2800 bp) of $10,000.00 profit = 1000000 × 2800 / 10000
//   = 280000. Personal tax owed: 0 unless a case sets it.
// Strawb bills buffer: the supplier bill 40000 is Strawb's only bill due by
//   payday; the Strawb pot s-tax is 30000, so buffer = min(30000, 40000)
//   = 30000 and the pot counts as 0 against tax.
// ---------------------------------------------------------------------------

const ACCOUNTS: SafeToSpendAccount[] = [
  { id: 'p-cur', scope: 'personal', role: 'current', balanceCents: 300000 },
  { id: 'p-sav', scope: 'personal', role: 'savings', balanceCents: 500000 },
  { id: 'p-new', scope: 'personal', role: null, balanceCents: 7000 },
  { id: 's-cur', scope: 'strawb', role: 'current', balanceCents: 200000 },
  { id: 's-tax', scope: 'strawb', role: 'tax_pot', balanceCents: 30000 },
]

const BILLS: SafeToSpendBill[] = [
  // due before payday, unpaid: counts
  { id: 'rent', scope: 'personal', amountCents: 100000, dueDate: '2026-10-25', paid: false },
  // due ON payday, unpaid: counts ("on or before the next payday")
  { id: 'supplier', scope: 'strawb', amountCents: 40000, dueDate: '2026-10-27', paid: false },
  // due the day AFTER payday: excluded
  { id: 'gym', scope: 'personal', amountCents: 5000, dueDate: '2026-10-28', paid: false },
  // overdue and unpaid: counts
  { id: 'power', scope: 'personal', amountCents: 12000, dueDate: '2026-10-01', paid: false },
  // paid: excluded
  { id: 'phone', scope: 'personal', amountCents: 8000, dueDate: '2026-10-20', paid: true },
]

const BUDGETS: SafeToSpendBudget[] = [
  { id: 'groceries', scope: 'personal', category: 'Groceries', limitCents: 60000 },
  { id: 'software', scope: 'strawb', category: 'Software', limitCents: 20000 },
]

const TRANSACTIONS: SafeToSpendTransaction[] = [
  // Personal Groceries, in the window 2026-10-20..2026-10-23:
  { accountId: 'p-cur', date: '2026-10-21', amountCents: -30000, category: 'Groceries', status: 'settled' },
  { accountId: 'p-cur', date: '2026-10-22', amountCents: -15000, category: 'Groceries', status: 'pending' },
  // on the last payday itself: counts
  { accountId: 'p-cur', date: '2026-10-20', amountCents: -1000, category: 'Groceries', status: 'settled' },
  // a refund is money in: not spend, and does not offset spend
  { accountId: 'p-cur', date: '2026-10-21', amountCents: 5000, category: 'Groceries', status: 'settled' },
  // the day before the last payday (Mon 10-19): previous week, excluded
  { accountId: 'p-cur', date: '2026-10-19', amountCents: -9999, category: 'Groceries', status: 'settled' },
  // dated after today: excluded
  { accountId: 'p-cur', date: '2026-10-24', amountCents: -7000, category: 'Groceries', status: 'pending' },
  // a Strawb account buying groceries: not the personal budget's spend
  { accountId: 's-cur', date: '2026-10-21', amountCents: -2000, category: 'Groceries', status: 'settled' },
  // income, and an uncategorised spend: no budget
  { accountId: 'p-cur', date: '2026-10-20', amountCents: 400000, category: 'Salary', status: 'settled' },
  { accountId: 'p-cur', date: '2026-10-22', amountCents: -3000, category: null, status: 'settled' },
  // Strawb Software, over its 20000 limit
  { accountId: 's-cur', date: '2026-10-21', amountCents: -25000, category: 'Software', status: 'settled' },
]

function base(overrides: Partial<SafeToSpendInput> = {}): SafeToSpendInput {
  return {
    scope: 'all',
    today: '2026-10-23',
    paydayWeekday: 2,
    taxRateBasisPoints: 2800,
    profitCents: 1000000,
    personalTaxOwedCents: 0,
    accounts: ACCOUNTS,
    bills: BILLS,
    budgets: BUDGETS,
    transactions: TRANSACTIONS,
    ...overrides,
  }
}

// Extra accounts some cases add to ACCOUNTS.
const P_TAX = (balanceCents: number): SafeToSpendAccount => ({
  id: 'p-tax',
  scope: 'personal',
  role: 'tax_pot',
  balanceCents,
})
const P_CARD = (balanceCents: number): SafeToSpendAccount => ({
  id: 'p-card',
  scope: 'personal',
  role: 'credit_card',
  balanceCents,
})
const S_CARD = (balanceCents: number): SafeToSpendAccount => ({
  id: 's-card',
  scope: 'strawb',
  role: 'credit_card',
  balanceCents,
})
const S_TAX = (balanceCents: number): SafeToSpendAccount => ({
  id: 's-tax',
  scope: 'strawb',
  role: 'tax_pot',
  balanceCents,
})
// ACCOUNTS without s-tax, so a case can give Strawb a different pot or none.
const ACCOUNTS_NO_S_TAX = ACCOUNTS.filter((a) => a.id !== 's-tax')

// Groceries spent = 30000 + 15000 + 1000 = 46000 (refund, 10-19, 10-24 and
//   the Strawb row excluded); remaining = 60000 − 46000 = 14000.
const GROCERIES: BudgetLine = {
  id: 'groceries',
  scope: 'personal',
  category: 'Groceries',
  limitCents: 60000,
  spentCents: 46000,
  remainingCents: 14000,
  overCents: 0,
}

// Software spent = 25000; remaining = max(0, 20000 − 25000) = 0, never −5000;
//   over = 25000 − 20000 = 5000.
const SOFTWARE: BudgetLine = {
  id: 'software',
  scope: 'strawb',
  category: 'Software',
  limitCents: 20000,
  spentCents: 25000,
  remainingCents: 0,
  overCents: 5000,
}

const PAYDAY_WEEK = { today: '2026-10-23', lastPayday: '2026-10-20', nextPayday: '2026-10-27', daysToPayday: 4 }

// Every tax part 0, for cases that hold no tax in either scope.
const NO_TAX = {
  strawbTaxOwedCents: 0,
  strawbTaxPotCents: 0,
  strawbBillsBufferCents: 0,
  strawbTaxHoldCents: 0,
  personalTaxOwedCents: 0,
  personalTaxPotCents: 0,
  personalTaxHoldCents: 0,
  taxHoldCents: 0,
}

// The base results, one per scope. Cases below that change one thing spread
// one of these and restate only the figures that move.

// liquid  = p-cur 300000 + s-cur 200000 = 500000
//           (savings 500000, no-role 7000 and the tax pot 30000 are not liquid)
// bills   = rent 100000 + supplier 40000 + power 12000 = 152000 due
//           (gym due 10-28 is after payday; phone is paid), less the
//           Strawb buffer 30000 the pot pays = 122000
// budgets = groceries 14000 + software 0 = 14000
// tax     = Strawb: owed 280000 − (pot 30000 − buffer 30000) = hold 280000
//           Personal: owed 0 − pot 0 = hold 0
//           hold = 280000 + 0 = 280000
// card    = 0 (no credit card)
// safe    = 500000 − 122000 − 14000 − 280000 − 0 = 84000
// per day = 84000 ÷ 4 = 21000
const EXPECT_ALL: SafeToSpendResult = {
  scope: 'all',
  ...PAYDAY_WEEK,
  liquidCents: 500000,
  unpaidBillsCents: 122000,
  remainingBudgetCents: 14000,
  strawbTaxOwedCents: 280000,
  strawbTaxPotCents: 30000,
  strawbBillsBufferCents: 30000,
  strawbTaxHoldCents: 280000,
  personalTaxOwedCents: 0,
  personalTaxPotCents: 0,
  personalTaxHoldCents: 0,
  taxHoldCents: 280000,
  cardDebtCents: 0,
  safeCents: 84000,
  shortByCents: 0,
  perDayCents: 21000,
  budgets: [GROCERIES, SOFTWARE],
}

// liquid  = p-cur 300000
// bills   = rent 100000 + power 12000 = 112000
// budgets = groceries 14000
// tax     = Personal: owed 0 − pot 0 = hold 0. Strawb parts, the buffer
//           among them, are 0 in Personal, though profit is set.
// card    = 0
// safe    = 300000 − 112000 − 14000 − 0 − 0 = 174000
// per day = 174000 ÷ 4 = 43500
const EXPECT_PERSONAL: SafeToSpendResult = {
  scope: 'personal',
  ...PAYDAY_WEEK,
  liquidCents: 300000,
  unpaidBillsCents: 112000,
  remainingBudgetCents: 14000,
  ...NO_TAX,
  cardDebtCents: 0,
  safeCents: 174000,
  shortByCents: 0,
  perDayCents: 43500,
  budgets: [GROCERIES],
}

// liquid  = s-cur 200000
// bills   = supplier 40000 (due on payday counts) − buffer 30000 = 10000
// budgets = software 0 (over its limit; adds nothing, takes nothing extra)
// tax     = Strawb: owed 280000 − (pot 30000 − buffer 30000) = hold 280000.
//           Personal parts 0.
// card    = 0
// safe    = 200000 − 10000 − 0 − 280000 − 0 = −90000   (negative, not clamped)
// short   = 90000
// per day = −90000 ÷ 4 = −22500
const EXPECT_STRAWB: SafeToSpendResult = {
  scope: 'strawb',
  ...PAYDAY_WEEK,
  liquidCents: 200000,
  unpaidBillsCents: 10000,
  remainingBudgetCents: 0,
  ...NO_TAX,
  strawbTaxOwedCents: 280000,
  strawbTaxPotCents: 30000,
  strawbBillsBufferCents: 30000,
  strawbTaxHoldCents: 280000,
  taxHoldCents: 280000,
  cardDebtCents: 0,
  safeCents: -90000,
  shortByCents: 90000,
  perDayCents: -22500,
  budgets: [SOFTWARE],
}

interface Case {
  name: string
  input: SafeToSpendInput
  expected: SafeToSpendResult
}

const CASES: Case[] = [
  {
    // Worked above EXPECT_ALL.
    name: 'all scope: every term from both sides',
    input: base({ scope: 'all' }),
    expected: EXPECT_ALL,
  },
  {
    // Worked above EXPECT_PERSONAL.
    name: 'personal scope: personal rows only, no Strawb tax',
    input: base({ scope: 'personal' }),
    expected: EXPECT_PERSONAL,
  },
  {
    // Worked above EXPECT_STRAWB.
    name: 'strawb scope: negative result is returned signed, with short-by',
    input: base({ scope: 'strawb' }),
    expected: EXPECT_STRAWB,
  },

  // --- Strawb tax hold (Ruling 11) ----------------------------------------
  {
    // Profit 0 (Xero not connected): owed = 2800 × 0 / 10000 = 0;
    //   buffer = min(pot 30000, bills 40000) = 30000;
    //   hold = max(0, 0 − (30000 − 30000)) = 0. The pot pays 30000 of the
    //   supplier bill, so only 10000 of it comes out of liquid.
    // safe    = 200000 − 10000 − 0 − 0 − 0 = 190000
    // per day = 190000 ÷ 4 = 47500
    name: 'strawb, profit 0 with money in the tax pot: hold is 0',
    input: base({ scope: 'strawb', profitCents: 0 }),
    expected: {
      ...EXPECT_STRAWB,
      strawbTaxOwedCents: 0,
      strawbTaxHoldCents: 0,
      taxHoldCents: 0,
      safeCents: 190000,
      shortByCents: 0,
      perDayCents: 47500,
    },
  },
  {
    // Profit 100000: owed = 2800 × 100000 / 10000 = 28000. The pot is
    //   70000, so after the bills buffer min(70000, 40000) = 40000 it still
    //   counts 30000 against tax (the pot of this row before Ruling 12):
    //   hold = max(0, 28000 − (70000 − 40000)) = 0, not −2000 (the pot covers
    //   it and is not liquid). bills = 40000 − 40000 = 0.
    // safe    = 200000 − 0 − 0 − 0 − 0 = 200000
    // per day = 200000 ÷ 4 = 50000
    name: 'strawb, tax pot above the tax owed: hold is 0, not negative',
    input: base({ scope: 'strawb', profitCents: 100000, accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(70000)] }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 0,
      strawbTaxOwedCents: 28000,
      strawbTaxPotCents: 70000,
      strawbBillsBufferCents: 40000,
      strawbTaxHoldCents: 0,
      taxHoldCents: 0,
      safeCents: 200000,
      shortByCents: 0,
      perDayCents: 50000,
    },
  },
  {
    // No Strawb tax pot at all: buffer = min(0, 40000) = 0, so the whole
    //   supplier bill 40000 comes out of liquid;
    //   hold = max(0, 280000 − 0) = 280000, the full owed amount.
    // safe    = 200000 − 40000 − 0 − 280000 − 0 = −120000; short 120000
    // per day = −120000 ÷ 4 = −30000
    name: 'strawb, no tax pot: the whole tax owed is held',
    input: base({ scope: 'strawb', accounts: ACCOUNTS_NO_S_TAX }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 40000,
      strawbTaxPotCents: 0,
      strawbBillsBufferCents: 0,
      strawbTaxHoldCents: 280000,
      taxHoldCents: 280000,
      safeCents: -120000,
      shortByCents: 120000,
      perDayCents: -30000,
    },
  },
  {
    // A loss: profit −500000 owes nothing; hold 0. The buffer is 30000 as in
    //   the base row, so bills = 40000 − 30000 = 10000.
    // safe = 200000 − 10000 − 0 − 0 − 0 = 190000; per day 190000 ÷ 4 = 47500
    name: 'strawb, negative profit: nothing owed',
    input: base({ scope: 'strawb', profitCents: -500000 }),
    expected: {
      ...EXPECT_STRAWB,
      strawbTaxOwedCents: 0,
      strawbTaxHoldCents: 0,
      taxHoldCents: 0,
      safeCents: 190000,
      shortByCents: 0,
      perDayCents: 47500,
    },
  },
  {
    // A personal tax pot seen from Strawb: it is not Strawb's.
    // tax = Strawb owed 280000 − (pot 30000 − buffer 30000) = hold 280000;
    //       the pot is s-tax only (p-tax 50000 is personal and out of view,
    //       and pays no Strawb bill). Personal parts 0.
    // safe = 200000 − 10000 − 0 − 280000 − 0 = −90000; short 90000
    // per day = −90000 ÷ 4 = −22500
    name: 'strawb scope with a personal tax pot: only the Strawb pot nets',
    input: base({ scope: 'strawb', accounts: [...ACCOUNTS, P_TAX(50000)] }),
    expected: EXPECT_STRAWB,
  },
  {
    // Personal tax owed 100000 is set, but Strawb holds only its own tax:
    //   every personal part is 0 in Strawb, so the result is the base one.
    // safe = 200000 − 10000 − 0 − 280000 − 0 = −90000; per day −22500
    name: 'strawb scope ignores personal tax owed',
    input: base({ scope: 'strawb', personalTaxOwedCents: 100000 }),
    expected: EXPECT_STRAWB,
  },
  {
    // A 100% tax rate is allowed: owed = 10000 × 1000000 / 10000 = 1000000.
    // hold = 1000000 − (30000 − buffer 30000) = 1000000; bills 10000
    // safe = 200000 − 10000 − 0 − 1000000 − 0 = −810000; short 810000
    // per day = −810000 ÷ 4 = −202500
    name: 'strawb, tax rate 10000 bp (100%) is the upper bound, accepted',
    input: base({ scope: 'strawb', taxRateBasisPoints: 10000 }),
    expected: {
      ...EXPECT_STRAWB,
      strawbTaxOwedCents: 1000000,
      strawbTaxHoldCents: 1000000,
      taxHoldCents: 1000000,
      safeCents: -810000,
      shortByCents: 810000,
      perDayCents: -202500,
    },
  },

  // --- Personal tax hold (Ruling 11) --------------------------------------
  {
    // Owed 100000, personal pot 120000: hold = max(0, 100000 − 120000) = 0,
    //   not −20000. The pot is not liquid: liquid stays p-cur 300000.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal, tax pot above the tax owed: hold is 0, not negative',
    input: base({ scope: 'personal', personalTaxOwedCents: 100000, accounts: [...ACCOUNTS, P_TAX(120000)] }),
    expected: { ...EXPECT_PERSONAL, personalTaxOwedCents: 100000, personalTaxPotCents: 120000 },
  },
  {
    // Owed 100000, personal pot 30000: hold = 100000 − 30000 = 70000.
    // safe = 300000 − 112000 − 14000 − 70000 − 0 = 104000
    // per day = 104000 ÷ 4 = 26000
    name: 'personal, tax pot short of the tax owed: the gap is held',
    input: base({ scope: 'personal', personalTaxOwedCents: 100000, accounts: [...ACCOUNTS, P_TAX(30000)] }),
    expected: {
      ...EXPECT_PERSONAL,
      personalTaxOwedCents: 100000,
      personalTaxPotCents: 30000,
      personalTaxHoldCents: 70000,
      taxHoldCents: 70000,
      safeCents: 104000,
      perDayCents: 26000,
    },
  },
  {
    // Owed 100000, no personal pot: hold = 100000 − 0 = 100000. s-tax 30000
    //   is Strawb's and does not net a personal hold.
    // safe = 300000 − 112000 − 14000 − 100000 − 0 = 74000
    // per day = 74000 ÷ 4 = 18500
    name: 'personal, no tax pot: the whole tax owed is held',
    input: base({ scope: 'personal', personalTaxOwedCents: 100000 }),
    expected: {
      ...EXPECT_PERSONAL,
      personalTaxOwedCents: 100000,
      personalTaxHoldCents: 100000,
      taxHoldCents: 100000,
      safeCents: 74000,
      perDayCents: 18500,
    },
  },
  {
    // Owed 0 with a personal pot of 30000: hold = max(0, 0 − 30000) = 0.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal, tax owed 0 with money in the tax pot: hold is 0',
    input: base({ scope: 'personal', accounts: [...ACCOUNTS, P_TAX(30000)] }),
    expected: { ...EXPECT_PERSONAL, personalTaxPotCents: 30000 },
  },
  {
    // Owed typed as −0, a zero with a sign: reported as 0, never −0.
    //   hold = max(0, 0 − 0) = 0, so the result is the base one.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal, tax owed −0 is reported as 0, not −0',
    input: base({ scope: 'personal', personalTaxOwedCents: -0 }),
    expected: EXPECT_PERSONAL,
  },
  {
    // Profit 5000000 at 100%: Strawb would owe 5000000, but Personal holds
    //   only the personal tax (owed 0 here), so the result is the base one.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal scope ignores profit and the tax rate',
    input: base({ scope: 'personal', profitCents: 5000000, taxRateBasisPoints: 10000 }),
    expected: EXPECT_PERSONAL,
  },

  // --- All: the sum of both holds, never cross-netted (Ruling 11) ---------
  {
    // Strawb: owed 280000 − (pot 30000 − buffer 30000) = hold 280000
    // Personal: owed 100000 − pot 30000 = hold 70000 (the personal pot pays
    //   no bill)
    // hold = 280000 + 70000 = 350000
    // liquid 500000; bills 152000 − buffer 30000 = 122000; budgets 14000
    // safe = 500000 − 122000 − 14000 − 350000 − 0 = 14000
    // per day = 14000 ÷ 4 = 3500
    name: 'all scope: the tax hold is the Strawb hold plus the personal hold',
    input: base({ scope: 'all', personalTaxOwedCents: 100000, accounts: [...ACCOUNTS, P_TAX(30000)] }),
    expected: {
      ...EXPECT_ALL,
      personalTaxOwedCents: 100000,
      personalTaxPotCents: 30000,
      personalTaxHoldCents: 70000,
      taxHoldCents: 350000,
      safeCents: 14000,
      perDayCents: 3500,
    },
  },
  {
    // A Strawb pot bigger than Strawb's tax does not cover personal tax.
    //   The pot is 340000: after the bills buffer min(340000, 40000) = 40000
    //   it counts 300000 against tax (the pot of this row before Ruling 12).
    // Strawb: owed 280000 − (340000 − 40000) → hold max(0, −20000) = 0
    // Personal: owed 100000 − no pot → hold 100000
    // hold = 0 + 100000 = 100000, not (280000 + 100000) − 300000 = 80000
    // bills = 152000 − 40000 = 112000 (the personal 112000 in full)
    // safe = 500000 − 112000 − 14000 − 100000 − 0 = 274000
    // per day = 274000 ÷ 4 = 68500
    name: 'all scope: a Strawb surplus pot never reduces the personal hold',
    input: base({ scope: 'all', personalTaxOwedCents: 100000, accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(340000)] }),
    expected: {
      ...EXPECT_ALL,
      unpaidBillsCents: 112000,
      strawbTaxPotCents: 340000,
      strawbBillsBufferCents: 40000,
      strawbTaxHoldCents: 0,
      personalTaxOwedCents: 100000,
      personalTaxHoldCents: 100000,
      taxHoldCents: 100000,
      safeCents: 274000,
      perDayCents: 68500,
    },
  },
  {
    // The mirror: a personal pot bigger than personal tax does not cover
    //   Strawb's.
    // Strawb: owed 280000 − (pot 30000 − buffer 30000) → hold 280000
    // Personal: owed 100000 − pot 120000 → hold max(0, −20000) = 0
    // hold = 280000 + 0 = 280000, not (280000 + 100000) − (0 + 120000)
    //   = 260000
    // safe = 500000 − 122000 − 14000 − 280000 − 0 = 84000; per day 21000
    name: 'all scope: a personal surplus pot never reduces the Strawb hold',
    input: base({ scope: 'all', personalTaxOwedCents: 100000, accounts: [...ACCOUNTS, P_TAX(120000)] }),
    expected: { ...EXPECT_ALL, personalTaxOwedCents: 100000, personalTaxPotCents: 120000 },
  },

  // --- The Strawb bills buffer (Ruling 12) --------------------------------
  // The base rows have the pot partly covering the bills (30000 of 40000).
  {
    // Pot 100000 covers the supplier bill 40000. Two more Strawb bills do
    //   not size the buffer: 'ads' 50000 is due 10-28, after payday, and
    //   'hosting' 20000 is paid.
    // buffer = min(100000, 40000) = 40000; bills = 40000 − 40000 = 0, so the
    //   bill is not taken from liquid as well as from the pot.
    // hold = 280000 − (100000 − 40000) = 220000: the pot counted against tax
    //   is 60000, not 100000.
    // safe = 200000 − 0 − 0 − 220000 − 0 = −20000; short 20000
    // per day = −20000 ÷ 4 = −5000
    name: 'strawb, the pot covers the bills: no bill subtracted twice, hold on pot − bills',
    input: base({
      scope: 'strawb',
      accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(100000)],
      bills: [
        ...BILLS,
        { id: 'ads', scope: 'strawb', amountCents: 50000, dueDate: '2026-10-28', paid: false },
        { id: 'hosting', scope: 'strawb', amountCents: 20000, dueDate: '2026-10-22', paid: true },
      ],
    }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 0,
      strawbTaxPotCents: 100000,
      strawbBillsBufferCents: 40000,
      strawbTaxHoldCents: 220000,
      taxHoldCents: 220000,
      safeCents: -20000,
      shortByCents: 20000,
      perDayCents: -5000,
    },
  },
  {
    // Pot 10000 covers part of the supplier bill 40000.
    // buffer = min(10000, 40000) = 10000; bills = 40000 − 10000 = 30000
    // hold = 280000 − (10000 − 10000) = 280000
    // safe = 200000 − 30000 − 0 − 280000 − 0 = −110000; short 110000
    // per day = −110000 ÷ 4 = −27500
    name: 'strawb, the pot partly covers the bills: the pot is all buffer, the rest is subtracted',
    input: base({ scope: 'strawb', accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(10000)] }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 30000,
      strawbTaxPotCents: 10000,
      strawbBillsBufferCents: 10000,
      safeCents: -110000,
      shortByCents: 110000,
      perDayCents: -27500,
    },
  },
  {
    // Pot 0: buffer = min(0, 40000) = 0, so behaviour is as before Ruling 12.
    // bills = 40000; hold = 280000 − 0 = 280000
    // safe = 200000 − 40000 − 0 − 280000 − 0 = −120000; short 120000
    // per day = −120000 ÷ 4 = −30000
    name: 'strawb, a pot of 0: no buffer, the bills are subtracted in full',
    input: base({ scope: 'strawb', accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(0)] }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 40000,
      strawbTaxPotCents: 0,
      strawbBillsBufferCents: 0,
      safeCents: -120000,
      shortByCents: 120000,
      perDayCents: -30000,
    },
  },
  {
    // No Strawb bills (only the personal ones, out of view): buffer =
    //   min(30000, 0) = 0, so the whole pot counts against tax.
    // bills = 0; hold = 280000 − (30000 − 0) = 250000
    // safe = 200000 − 0 − 0 − 250000 − 0 = −50000; short 50000
    // per day = −50000 ÷ 4 = −12500
    name: 'strawb, no Strawb bills: no buffer, the whole pot nets the tax',
    input: base({ scope: 'strawb', bills: BILLS.filter((b) => b.scope === 'personal') }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 0,
      strawbBillsBufferCents: 0,
      strawbTaxHoldCents: 250000,
      taxHoldCents: 250000,
      safeCents: -50000,
      shortByCents: 50000,
      perDayCents: -12500,
    },
  },
  {
    // An overdrawn pot, −5000: buffer = max(0, min(−5000, 40000)) = 0, not
    //   −5000, so it adds no bills; the overdraft stays in the hold.
    // bills = 40000; hold = 280000 − (−5000 − 0) = 285000
    // safe = 200000 − 40000 − 0 − 285000 − 0 = −125000; short 125000
    // per day = −125000 ÷ 4 = −31250
    name: 'strawb, an overdrawn pot: no buffer, never a negative one',
    input: base({ scope: 'strawb', accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(-5000)] }),
    expected: {
      ...EXPECT_STRAWB,
      unpaidBillsCents: 40000,
      strawbTaxPotCents: -5000,
      strawbBillsBufferCents: 0,
      strawbTaxHoldCents: 285000,
      taxHoldCents: 285000,
      safeCents: -125000,
      shortByCents: 125000,
      perDayCents: -31250,
    },
  },
  {
    // All, with personal and Strawb bills and a pot on each side. Strawb pot
    //   100000 covers the supplier bill 40000; the personal pot 30000 pays
    //   no bill.
    // Strawb buffer = min(100000, 40000) = 40000 (personal bills never size
    //   it); Strawb hold = 280000 − (100000 − 40000) = 220000
    // Personal hold = 100000 − 30000 = 70000, as without Ruling 12
    // bills = rent 100000 + power 12000 (personal, in full) + supplier
    //   40000 − 40000 = 112000
    // hold = 220000 + 70000 = 290000
    // safe = 500000 − 112000 − 14000 − 290000 − 0 = 84000
    // per day = 84000 ÷ 4 = 21000
    name: 'all scope: personal bills and the personal pot are untouched by the Strawb buffer',
    input: base({
      scope: 'all',
      personalTaxOwedCents: 100000,
      accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(100000), P_TAX(30000)],
    }),
    expected: {
      ...EXPECT_ALL,
      unpaidBillsCents: 112000,
      strawbTaxPotCents: 100000,
      strawbBillsBufferCents: 40000,
      strawbTaxHoldCents: 220000,
      personalTaxOwedCents: 100000,
      personalTaxPotCents: 30000,
      personalTaxHoldCents: 70000,
      taxHoldCents: 290000,
    },
  },
  {
    // Personal: Strawb is not in view, so the Strawb pot 100000 and the
    //   supplier bill are not seen and the buffer is 0. Personal bills
    //   112000 come out in full, as in the base Personal row.
    name: 'personal scope: no Strawb buffer, though Strawb has a pot and a bill',
    input: base({ scope: 'personal', accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(100000)] }),
    expected: EXPECT_PERSONAL,
  },

  // --- Card debt (Ruling 10) ----------------------------------------------
  {
    // p-card balance −40000 (owed, Akahu's confirmed sign): debt = 40000.
    //   The card is not liquid: liquid stays p-cur 300000.
    // safe = 300000 − 112000 − 14000 − 0 − 40000 = 134000
    // per day = 134000 ÷ 4 = 33500
    name: 'personal, a card with money owed: the debt is subtracted',
    input: base({ scope: 'personal', accounts: [...ACCOUNTS, P_CARD(-40000)] }),
    expected: { ...EXPECT_PERSONAL, cardDebtCents: 40000, safeCents: 134000, perDayCents: 33500 },
  },
  {
    // p-card balance +15000 (in credit): debt = max(0, −15000) = 0. Not liquid
    //   either, so liquid stays 300000, not 315000.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal, a card in credit: adds 0 and does not raise liquid',
    input: base({ scope: 'personal', accounts: [...ACCOUNTS, P_CARD(15000)] }),
    expected: EXPECT_PERSONAL,
  },
  {
    // p-card balance 0: debt = 0.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal, a card at zero: no debt',
    input: base({ scope: 'personal', accounts: [...ACCOUNTS, P_CARD(0)] }),
    expected: EXPECT_PERSONAL,
  },
  {
    // Two cards: p-card −40000 owes 40000; p-card-2 +15000 owes 0.
    //   debt = 40000 + 0 = 40000, not −40000 + 15000 → 25000: credit on one
    //   card never offsets another.
    // safe = 300000 − 112000 − 14000 − 0 − 40000 = 134000; per day 33500
    name: 'personal, two cards: credit on one never offsets debt on the other',
    input: base({
      scope: 'personal',
      accounts: [...ACCOUNTS, P_CARD(-40000), { ...P_CARD(15000), id: 'p-card-2' }],
    }),
    expected: { ...EXPECT_PERSONAL, cardDebtCents: 40000, safeCents: 134000, perDayCents: 33500 },
  },
  {
    // The personal card in All: debt 40000.
    // safe = 500000 − 122000 − 14000 − 280000 − 40000 = 44000
    // per day = 44000 ÷ 4 = 11000
    name: 'all scope: a personal card debt is subtracted',
    input: base({ scope: 'all', accounts: [...ACCOUNTS, P_CARD(-40000)] }),
    expected: { ...EXPECT_ALL, cardDebtCents: 40000, safeCents: 44000, perDayCents: 11000 },
  },
  {
    // The personal card seen from Strawb: not Strawb's, debt 0.
    // safe = 200000 − 10000 − 0 − 280000 − 0 = −90000; per day −22500
    name: 'strawb scope: a personal card debt is not Strawb’s',
    input: base({ scope: 'strawb', accounts: [...ACCOUNTS, P_CARD(-40000)] }),
    expected: EXPECT_STRAWB,
  },
  {
    // s-card balance −60000 in Strawb: debt 60000. The card is not a tax pot
    //   and pays no bill: the buffer stays 30000.
    // safe = 200000 − 10000 − 0 − 280000 − 60000 = −150000; short 150000
    // per day = −150000 ÷ 4 = −37500
    name: 'strawb scope: a Strawb card debt is subtracted',
    input: base({ scope: 'strawb', accounts: [...ACCOUNTS, S_CARD(-60000)] }),
    expected: { ...EXPECT_STRAWB, cardDebtCents: 60000, safeCents: -150000, shortByCents: 150000, perDayCents: -37500 },
  },
  {
    // The Strawb card in All: debt 60000.
    // safe = 500000 − 122000 − 14000 − 280000 − 60000 = 24000
    // per day = 24000 ÷ 4 = 6000
    name: 'all scope: a Strawb card debt is subtracted',
    input: base({ scope: 'all', accounts: [...ACCOUNTS, S_CARD(-60000)] }),
    expected: { ...EXPECT_ALL, cardDebtCents: 60000, safeCents: 24000, perDayCents: 6000 },
  },
  {
    // The Strawb card seen from Personal: not personal, debt 0.
    // safe = 300000 − 112000 − 14000 − 0 − 0 = 174000; per day 43500
    name: 'personal scope: a Strawb card debt is not personal',
    input: base({ scope: 'personal', accounts: [...ACCOUNTS, S_CARD(-60000)] }),
    expected: EXPECT_PERSONAL,
  },
  {
    // A 5000 Groceries purchase on the card, inside a budget with room:
    //   before it, the card is at 0 and safe is 174000 (the 'card at zero'
    //   row above). After it:
    // Groceries spent = 46000 + 5000 (card row counts as personal spend)
    //   = 51000; remaining = 60000 − 51000 = 9000
    // card debt = max(0, −(−5000)) = 5000
    // safe = 300000 − 112000 − 9000 − 0 − 5000 = 174000: unchanged, since
    //   the budget had already reserved the money the card now owes.
    // per day = 174000 ÷ 4 = 43500
    name: 'personal, a card purchase inside a budget leaves safe unchanged',
    input: base({
      scope: 'personal',
      accounts: [...ACCOUNTS, P_CARD(-5000)],
      transactions: [
        ...TRANSACTIONS,
        { accountId: 'p-card', date: '2026-10-22', amountCents: -5000, category: 'Groceries', status: 'settled' },
      ],
    }),
    expected: {
      ...EXPECT_PERSONAL,
      remainingBudgetCents: 9000,
      cardDebtCents: 5000,
      budgets: [{ ...GROCERIES, spentCents: 51000, remainingCents: 9000 }],
    },
  },

  // --- Money edges --------------------------------------------------------
  {
    // An overdrawn current account is negative liquid, not zero.
    // liquid = −5000; bills 0; budgets 0; tax 0; card 0
    // safe = −5000; short 5000; per day = −5000 ÷ 4 = −1250
    name: 'overdrawn current account counts as negative liquid',
    input: base({
      scope: 'personal',
      accounts: [{ id: 'p-cur', scope: 'personal', role: 'current', balanceCents: -5000 }],
      bills: [],
      budgets: [],
      transactions: [],
    }),
    expected: {
      scope: 'personal',
      ...PAYDAY_WEEK,
      liquidCents: -5000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      ...NO_TAX,
      cardDebtCents: 0,
      safeCents: -5000,
      shortByCents: 5000,
      perDayCents: -1250,
      budgets: [],
    },
  },
  {
    // Tax owed rounds UP to the cent: 2500 × 333 / 10000 = 83.25 → 84.
    // liquid = 10000; hold = 84 − 0 = 84
    // safe = 10000 − 84 = 9916
    // Today Wed 2026-10-21: last Tue 10-20, next Tue 10-27, 6 days, so the
    //   division is inexact: per day = 9916 ÷ 6 = 1652.66… → 1652 (down)
    name: 'one rounding each: tax owed rounds up, per day rounds down',
    input: base({
      scope: 'strawb',
      today: '2026-10-21',
      taxRateBasisPoints: 2500,
      profitCents: 333,
      accounts: [{ id: 's-cur', scope: 'strawb', role: 'current', balanceCents: 10000 }],
      bills: [],
      budgets: [],
      transactions: [],
    }),
    expected: {
      scope: 'strawb',
      today: '2026-10-21',
      lastPayday: '2026-10-20',
      nextPayday: '2026-10-27',
      daysToPayday: 6,
      liquidCents: 10000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      ...NO_TAX,
      strawbTaxOwedCents: 84,
      strawbTaxHoldCents: 84,
      taxHoldCents: 84,
      cardDebtCents: 0,
      safeCents: 9916,
      shortByCents: 0,
      perDayCents: 1652,
      budgets: [],
    },
  },
  {
    // safe = 0 − 1 = −1; per day = −1 ÷ 4 = −0.25 → −1 (down, never flattering)
    name: 'per day rounds a small shortfall down to −1, not 0',
    input: base({
      scope: 'personal',
      accounts: [{ id: 'p-cur', scope: 'personal', role: 'current', balanceCents: 0 }],
      bills: [{ id: 'b', scope: 'personal', amountCents: 1, dueDate: '2026-10-24', paid: false }],
      budgets: [],
      transactions: [],
    }),
    expected: {
      scope: 'personal',
      ...PAYDAY_WEEK,
      liquidCents: 0,
      unpaidBillsCents: 1,
      remainingBudgetCents: 0,
      ...NO_TAX,
      cardDebtCents: 0,
      safeCents: -1,
      shortByCents: 1,
      perDayCents: -1,
      budgets: [],
    },
  },
  {
    // Zero accounts, one rent bill: liquid 0; bills 100000
    // safe = 0 − 100000 = −100000; short 100000; per day = −100000 ÷ 4 = −25000
    name: 'zero accounts with a bill due',
    input: base({ accounts: [], bills: [BILLS[0]], budgets: [], transactions: [], profitCents: 0 }),
    expected: {
      scope: 'all',
      ...PAYDAY_WEEK,
      liquidCents: 0,
      unpaidBillsCents: 100000,
      remainingBudgetCents: 0,
      ...NO_TAX,
      cardDebtCents: 0,
      safeCents: -100000,
      shortByCents: 100000,
      perDayCents: -25000,
      budgets: [],
    },
  },
  {
    // Nothing at all: every money figure 0; days to payday is still 4.
    name: 'empty inputs',
    input: base({ accounts: [], bills: [], budgets: [], transactions: [], profitCents: 0 }),
    expected: {
      scope: 'all',
      ...PAYDAY_WEEK,
      liquidCents: 0,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      ...NO_TAX,
      cardDebtCents: 0,
      safeCents: 0,
      shortByCents: 0,
      perDayCents: 0,
      budgets: [],
    },
  },

  // --- The weekly cycle (Ruling 9) ----------------------------------------
  {
    // On payday itself (Tue 2026-10-27): last payday is today, next is
    //   Tue 2026-11-03, 7 days away. Budgets reset: no spend is dated 10-27,
    //   so groceries remaining 60000, software remaining 20000 = 80000.
    // bills = rent 100000 (10-25, now overdue) + supplier 40000 (10-27)
    //       + gym 5000 (10-28, now before the next payday) + power 12000
    //       = 157000 due; phone still paid. Less the Strawb buffer
    //       min(30000, 40000) = 30000: 127000.
    // liquid 500000; hold 280000; card 0
    // safe = 500000 − 127000 − 80000 − 280000 − 0 = 13000
    // per day = 13000 ÷ 7 = 1857.14… → 1857
    name: 'on payday: the week resets and the next payday is seven days out',
    input: base({ today: '2026-10-27' }),
    expected: {
      ...EXPECT_ALL,
      today: '2026-10-27',
      lastPayday: '2026-10-27',
      nextPayday: '2026-11-03',
      daysToPayday: 7,
      unpaidBillsCents: 127000,
      remainingBudgetCents: 80000,
      safeCents: 13000,
      perDayCents: 1857,
      budgets: [
        { ...GROCERIES, spentCents: 0, remainingCents: 60000, overCents: 0 },
        { ...SOFTWARE, spentCents: 0, remainingCents: 20000, overCents: 0 },
      ],
    },
  },
  {
    // The day after payday (Wed 2026-10-28): last Tue 10-27, next Tue 11-03,
    //   6 days. Extra Groceries rows: −2000 on 10-28 counts; −3000 on
    //   Mon 10-26, the day before the last payday, does not. Every base row
    //   is dated before 10-27 and is last week's.
    // Groceries spent 2000, remaining 60000 − 2000 = 58000; software 20000
    //   budgets = 58000 + 20000 = 78000
    // bills 127000 (as on payday); liquid 500000; hold 280000; card 0
    // safe = 500000 − 127000 − 78000 − 280000 − 0 = 15000
    // per day = 15000 ÷ 6 = 2500
    name: 'the day after payday: spend counts from payday, not the day before',
    input: base({
      today: '2026-10-28',
      transactions: [
        ...TRANSACTIONS,
        { accountId: 'p-cur', date: '2026-10-28', amountCents: -2000, category: 'Groceries', status: 'settled' },
        { accountId: 'p-cur', date: '2026-10-26', amountCents: -3000, category: 'Groceries', status: 'settled' },
      ],
    }),
    expected: {
      ...EXPECT_ALL,
      today: '2026-10-28',
      lastPayday: '2026-10-27',
      nextPayday: '2026-11-03',
      daysToPayday: 6,
      unpaidBillsCents: 127000,
      remainingBudgetCents: 78000,
      safeCents: 15000,
      perDayCents: 2500,
      budgets: [
        { ...GROCERIES, spentCents: 2000, remainingCents: 58000, overCents: 0 },
        { ...SOFTWARE, spentCents: 0, remainingCents: 20000, overCents: 0 },
      ],
    },
  },
  {
    // A week crossing a month end: today Sat 2026-10-31, last Tue 10-27,
    //   next Tue 2026-11-03, 3 days.
    // bills: insurance 30000 due 11-03 (= next payday) counts; water 6000
    //   due 11-04 does not. bills = 30000
    // Groceries: −4000 on 10-27 counts; −8000 on 10-26 does not.
    //   spent 4000, remaining 60000 − 4000 = 56000
    // liquid 300000; tax 0; card 0
    // safe = 300000 − 30000 − 56000 − 0 − 0 = 214000
    // per day = 214000 ÷ 3 = 71333.33… → 71333
    name: 'a week crossing a month end: November bills and October spend',
    input: base({
      scope: 'personal',
      today: '2026-10-31',
      bills: [
        { id: 'insurance', scope: 'personal', amountCents: 30000, dueDate: '2026-11-03', paid: false },
        { id: 'water', scope: 'personal', amountCents: 6000, dueDate: '2026-11-04', paid: false },
      ],
      budgets: [BUDGETS[0]],
      transactions: [
        { accountId: 'p-cur', date: '2026-10-27', amountCents: -4000, category: 'Groceries', status: 'pending' },
        { accountId: 'p-cur', date: '2026-10-26', amountCents: -8000, category: 'Groceries', status: 'settled' },
      ],
    }),
    expected: {
      scope: 'personal',
      today: '2026-10-31',
      lastPayday: '2026-10-27',
      nextPayday: '2026-11-03',
      daysToPayday: 3,
      liquidCents: 300000,
      unpaidBillsCents: 30000,
      remainingBudgetCents: 56000,
      ...NO_TAX,
      cardDebtCents: 0,
      safeCents: 214000,
      shortByCents: 0,
      perDayCents: 71333,
      budgets: [{ ...GROCERIES, spentCents: 4000, remainingCents: 56000, overCents: 0 }],
    },
  },
]

const RESULT_KEYS = [
  'scope',
  'today',
  'lastPayday',
  'nextPayday',
  'liquidCents',
  'unpaidBillsCents',
  'remainingBudgetCents',
  'strawbTaxOwedCents',
  'strawbTaxPotCents',
  'strawbBillsBufferCents',
  'strawbTaxHoldCents',
  'personalTaxOwedCents',
  'personalTaxPotCents',
  'personalTaxHoldCents',
  'taxHoldCents',
  'cardDebtCents',
  'safeCents',
  'shortByCents',
  'daysToPayday',
  'perDayCents',
  'budgets',
]

const BUDGET_LINE_KEYS = [
  'id',
  'scope',
  'category',
  'limitCents',
  'spentCents',
  'remainingCents',
  'overCents',
]

describe('safeToSpend: the fixed table', () => {
  it.each(CASES)('$name', ({ input, expected }) => {
    const result = safeToSpend(input)
    expect(Object.keys(result).sort()).toEqual([...RESULT_KEYS].sort())
    for (const line of result.budgets) {
      expect(Object.keys(line).sort()).toEqual([...BUDGET_LINE_KEYS].sort())
    }
    expect(result).toStrictEqual(expected)
  })

  it.each(CASES)('$name: every money figure is an integer', ({ input }) => {
    const result = safeToSpend(input)
    const figures = [
      result.liquidCents,
      result.unpaidBillsCents,
      result.remainingBudgetCents,
      result.strawbTaxOwedCents,
      result.strawbTaxPotCents,
      result.strawbBillsBufferCents,
      result.strawbTaxHoldCents,
      result.personalTaxOwedCents,
      result.personalTaxPotCents,
      result.personalTaxHoldCents,
      result.taxHoldCents,
      result.cardDebtCents,
      result.safeCents,
      result.shortByCents,
      result.daysToPayday,
      result.perDayCents,
      ...result.budgets.flatMap((b) => [b.limitCents, b.spentCents, b.remainingCents, b.overCents]),
    ]
    for (const n of figures) {
      expect(Number.isSafeInteger(n)).toBe(true)
      expect(Object.is(n, -0)).toBe(false)
    }
  })

  it('All is Personal plus Strawb with the base rows', () => {
    // 174000 + (−90000) = 84000: the All, Personal and Strawb rows above.
    const all = safeToSpend(base({ scope: 'all' })).safeCents
    const personal = safeToSpend(base({ scope: 'personal' })).safeCents
    const strawb = safeToSpend(base({ scope: 'strawb' })).safeCents
    expect(all).toBe(84000)
    expect(personal).toBe(174000)
    expect(strawb).toBe(-90000)
    expect(personal + strawb).toBe(84000)
  })

  it('All is Personal plus Strawb with a surplus pot on one side and a card', () => {
    // Strawb pot 340000: after the bills buffer min(340000, 40000) = 40000
    //   it counts 300000, a surplus over owed 280000. Personal owed 100000
    //   with no personal pot, a personal card owing 40000.
    // Personal: 300000 − 112000 − 14000 − hold 100000 − card 40000 = 34000
    // Strawb:   200000 − (40000 − 40000) − 0
    //           − hold max(0, 280000 − 300000) = 0 − card 0 = 200000
    // All:      500000 − (152000 − 40000) − 14000 − (0 + 100000) − 40000
    //           = 234000 = 34000 + 200000. Cross-netting would hold
    //           (280000 + 100000) − 300000 = 80000 and make All 254000.
    const overrides: Partial<SafeToSpendInput> = {
      personalTaxOwedCents: 100000,
      accounts: [...ACCOUNTS_NO_S_TAX, S_TAX(340000), P_CARD(-40000)],
    }
    const all = safeToSpend(base({ ...overrides, scope: 'all' })).safeCents
    const personal = safeToSpend(base({ ...overrides, scope: 'personal' })).safeCents
    const strawb = safeToSpend(base({ ...overrides, scope: 'strawb' })).safeCents
    expect(personal).toBe(34000)
    expect(strawb).toBe(200000)
    expect(all).toBe(234000)
    expect(personal + strawb).toBe(all)
  })

  it('does not read the clock: the same input gives the same answer', () => {
    expect(safeToSpend(base())).toStrictEqual(safeToSpend(base()))
  })
})

describe('budgetSpentCents', () => {
  // Window Tue 2026-10-27 (last payday) .. Mon 2026-11-02 (today), personal
  // Groceries: a week crossing a month end. Each row is −1000 unless it says
  // otherwise.
  const accounts = [...ACCOUNTS, P_CARD(-1000)]
  const window = { scope: 'personal' as const, category: 'Groceries', from: '2026-10-27', to: '2026-11-02' }
  const row = (o: Partial<SafeToSpendTransaction>): SafeToSpendTransaction => ({
    accountId: 'p-cur',
    date: '2026-10-30',
    amountCents: -1000,
    category: 'Groceries',
    status: 'settled',
    ...o,
  })

  it.each<[string, SafeToSpendTransaction[], number]>([
    ['a settled outflow counts', [row({})], 1000],
    ['a pending outflow counts', [row({ status: 'pending' })], 1000],
    ['settled 1000 + pending 2500 = 3500', [row({}), row({ status: 'pending', amountCents: -2500 })], 3500],
    ['income in the category is not spend', [row({ amountCents: 1000 })], 0],
    ['a refund does not offset spend: 1000, not 1000 − 400', [row({}), row({ amountCents: 400 })], 1000],
    ['spend on the last payday counts', [row({ date: '2026-10-27' })], 1000],
    ['spend the day before the last payday does not', [row({ date: '2026-10-26' })], 0],
    ['spend on today counts', [row({ date: '2026-11-02' })], 1000],
    ['spend dated after today does not', [row({ date: '2026-11-03' })], 0],
    ['spend on a Strawb account does not count for a personal budget', [row({ accountId: 's-cur' })], 0],
    ['spend in another category does not count', [row({ category: 'Dining' })], 0],
    ['uncategorised spend does not count', [row({ category: null })], 0],
    ['spend on a savings account counts: its scope is personal', [row({ accountId: 'p-sav' })], 1000],
    ['spend on a personal credit card counts: its scope is personal', [row({ accountId: 'p-card' })], 1000],
    ['nothing at all is 0', [], 0],
  ])('%s', (_name, transactions, expected) => {
    expect(budgetSpentCents({ accounts, transactions, ...window })).toBe(expected)
  })

  it('refuses a transaction on an account it was not given', () => {
    expect(() =>
      budgetSpentCents({ accounts, transactions: [row({ accountId: 'ghost' })], ...window }),
    ).toThrow(/unknown account "ghost"/)
  })

  // `safeToSpend` checks these before it calls `budgetSpentCents`, so only a
  // direct call reaches the guards inside it (#127). Each message is matched
  // whole: with the guard gone the call either returns or fails elsewhere
  // with a different message (a fractional amount reaches `sumCents`).
  it.each<[string, Partial<Parameters<typeof budgetSpentCents>[0]>, RegExp]>([
    [
      'a bad from date',
      { from: '2026-10-1' },
      /^from must be a YYYY-MM-DD calendar date, got "2026-10-1"$/,
    ],
    [
      'a bad to date',
      { to: '2026-11-31' },
      /^to must be a YYYY-MM-DD calendar date, got "2026-11-31"$/,
    ],
    [
      'a fractional transaction amount',
      { transactions: [row({ amountCents: -1.5 })] },
      /^transaction amountCents must be an integer number of cents, got -1.5$/,
    ],
    [
      'a bad transaction date',
      { transactions: [row({ date: '2026-10-1' })] },
      /^transaction date must be a YYYY-MM-DD calendar date, got "2026-10-1"$/,
    ],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() =>
      budgetSpentCents({ accounts, transactions: [row({})], ...window, ...overrides }),
    ).toThrow(message)
  })
})

// Regression (#264, before drawings): money leaving a Strawb account and the
// same amount arriving in a personal account the next day. Whatever drawings
// later exclude, a Strawb outflow with an ordinary category is that
// category's spend, and money in is never a credit to a budget.
describe('a Strawb outflow and an equal personal inflow (#264 regression)', () => {
  const CONTRACTORS: SafeToSpendBudget = {
    id: 'contractors',
    scope: 'strawb',
    category: 'Contractors',
    limitCents: 50000,
  }
  const OUT: SafeToSpendTransaction = {
    accountId: 's-cur',
    date: '2026-10-21',
    amountCents: -30000,
    category: 'Contractors',
    status: 'settled',
  }
  const IN: SafeToSpendTransaction = {
    accountId: 'p-cur',
    date: '2026-10-22',
    amountCents: 30000,
    category: 'Groceries',
    status: 'settled',
  }
  const input = (scope: 'all' | 'personal' | 'strawb'): SafeToSpendInput =>
    base({
      scope,
      budgets: [...BUDGETS, CONTRACTORS],
      transactions: [...TRANSACTIONS, OUT, IN],
    })

  it('the Strawb outflow counts toward the Strawb budget on its category', () => {
    expect(
      budgetSpentCents({
        accounts: ACCOUNTS,
        transactions: [OUT, IN],
        scope: 'strawb',
        category: 'Contractors',
        from: '2026-10-20',
        to: '2026-10-23',
      }),
    ).toBe(30000)
  })

  it('the personal inflow never credits a personal budget on its category', () => {
    // Groceries alone: 1000 spent; crediting the 30000 inflow would give 0.
    expect(
      budgetSpentCents({
        accounts: ACCOUNTS,
        transactions: [
          { ...OUT, category: 'Groceries' },
          IN,
          { ...IN, amountCents: -1000, date: '2026-10-21' },
        ],
        scope: 'personal',
        category: 'Groceries',
        from: '2026-10-20',
        to: '2026-10-23',
      }),
    ).toBe(1000)
  })

  it('Strawb: Contractors is 30000 spent and the safe figure falls by its remaining 20000', () => {
    // Base Strawb safe is −90000 (the fixed table). Contractors spent 30000,
    //   remaining 50000 − 30000 = 20000, so −90000 − 20000 = −110000. Not
    //   counting the outflow would leave 50000 remaining: −140000.
    const result = safeToSpend(input('strawb'))
    const line = result.budgets.find((b) => b.id === 'contractors')
    expect(line).toBeDefined()
    expect(Object.keys(line ?? {}).sort()).toEqual([...BUDGET_LINE_KEYS].sort())
    expect(line).toStrictEqual({
      id: 'contractors',
      scope: 'strawb',
      category: 'Contractors',
      limitCents: 50000,
      spentCents: 30000,
      remainingCents: 20000,
      overCents: 0,
    })
    expect(result.remainingBudgetCents).toBe(20000)
    expect(result.safeCents).toBe(-110000)
  })

  it('Personal: Groceries is still 46000 spent and the safe figure is the base 174000', () => {
    // The 30000 inflow in Groceries changes nothing: crediting it would make
    //   Groceries 16000 spent, remaining 44000 and safe 144000.
    const result = safeToSpend(input('personal'))
    expect(result.budgets).toStrictEqual([GROCERIES])
    expect(result.remainingBudgetCents).toBe(14000)
    expect(result.safeCents).toBe(174000)
  })

  it('All: Personal plus Strawb, 174000 + (−110000) = 64000', () => {
    expect(safeToSpend(input('all')).safeCents).toBe(64000)
  })
})

describe('paydays', () => {
  it.each<[string, number, string, string, number]>([
    // today (its weekday), payday weekday (0 Sunday … 6 Saturday),
    // last payday, next payday, days to it. Payday 2 is Tuesday.
    ['2026-10-23', 2, '2026-10-20', '2026-10-27', 4], // Fri
    ['2026-10-20', 2, '2026-10-20', '2026-10-27', 7], // Tue, payday itself
    ['2026-10-21', 2, '2026-10-20', '2026-10-27', 6], // Wed, the day after
    ['2026-10-25', 2, '2026-10-20', '2026-10-27', 2], // Sun
    ['2026-10-26', 2, '2026-10-20', '2026-10-27', 1], // Mon, the day before
    // a month end: Sat 31 Oct, the next payday is in November
    ['2026-10-31', 2, '2026-10-27', '2026-11-03', 3],
    // a year end: Thu 31 Dec, the next payday is in 2027
    ['2026-12-31', 2, '2026-12-29', '2027-01-05', 5],
    // a year start: Fri 1 Jan 2027, the last payday is in 2026
    ['2027-01-01', 2, '2026-12-29', '2027-01-05', 4],
    // February in a common year: Mon 1 Mar 2027, last payday Tue 23 Feb
    ['2027-03-01', 2, '2027-02-23', '2027-03-02', 1],
    // a leap day that is a Tuesday: payday itself, next is 7 Mar
    ['2028-02-29', 2, '2028-02-29', '2028-03-07', 7],
    // the day after that leap day: Wed 1 Mar 2028
    ['2028-03-01', 2, '2028-02-29', '2028-03-07', 6],
    // the ends of the weekday range, both on Sun 25 Oct 2026
    ['2026-10-25', 0, '2026-10-25', '2026-11-01', 7], // Sunday payday, on a Sunday
    ['2026-10-25', 6, '2026-10-24', '2026-10-31', 6], // Saturday payday: yesterday
    // Years 0 to 99, which Date.UTC would read as 1900 to 1999 (#126).
    // Weekdays checked against Python's proleptic Gregorian `datetime`.
    ['0050-03-01', 2, '0050-03-01', '0050-03-08', 7], // Tue, payday itself
    // Thu 31 Dec 0099: the next payday is in the year 100
    ['0099-12-31', 2, '0099-12-29', '0100-01-05', 5],
    // Mon 1 Mar 0004: the last payday is before the leap day 29 Feb 0004
    ['0004-03-01', 2, '0004-02-24', '0004-03-02', 1],
    // Tue 4 Jan 0000, the first payday the year 0000 has: 363 days before
    //   Mon 1 Jan 0001 (year 0 is a leap year), and 363 = 7 × 51 + 6.
    ['0000-01-04', 2, '0000-01-04', '0000-01-11', 7],
  ])('today %s, payday weekday %i: last %s, next %s, %i days', (today, weekday, last, next, days) => {
    expect(lastPayday(today, weekday)).toBe(last)
    expect(nextPayday(today, weekday)).toBe(next)
    expect(daysBetween(today, next)).toBe(days)
  })

  it.each<[string, string, number]>([
    // Years 0 to 99 (#126). Counts checked against Python's `datetime`,
    //   which starts at year 1; year 0 is a leap year (divisible by 400), so
    //   0000-01-01 to 0001-01-01 is 366 days.
    ['0099-12-31', '0100-01-01', 1],
    ['0001-01-01', '0100-01-01', 36159],
    ['0000-01-01', '0100-01-01', 36525], // 366 + 36159
    ['0000-02-28', '0000-03-01', 2], // 29 Feb 0000 exists
    ['0050-03-01', '2026-10-23', 721955],
  ])('daysBetween %s and %s is %i', (from, to, days) => {
    expect(daysBetween(from, to)).toBe(days)
  })

  // Sat 1 Jan 0000: the last Tuesday is in year −1, which has no YYYY-MM-DD
  // form; it is refused, not printed as "00-1-12-28" (#126). Thu 30 Dec
  // 9999: the next Tuesday is in year 10000.
  it('refuses a payday outside the years 0000 to 9999', () => {
    expect(() => lastPayday('0000-01-01', 2)).toThrow(
      /^a payday must fall in the years 0000 to 9999, got year -1$/,
    )
    expect(lastPayday('9999-12-30', 2)).toBe('9999-12-28')
    expect(() => nextPayday('9999-12-30', 2)).toThrow(
      /^a payday must fall in the years 0000 to 9999, got year 10000$/,
    )
  })

  it.each<[number, number, number]>([
    [2026, 1, 31],
    [2026, 2, 28],
    [2028, 2, 29],
    [2000, 2, 29],
    [2100, 2, 28],
    [2026, 4, 30],
    [2026, 6, 30],
    [2026, 9, 30],
    [2026, 11, 30],
    [2026, 12, 31],
  ])('%i-%i has %i days', (year, month, days) => {
    expect(daysInMonth(year, month)).toBe(days)
  })
})

describe('refusals', () => {
  it.each<[string, Partial<SafeToSpendInput>, RegExp]>([
    [
      'payday weekday −1',
      { paydayWeekday: -1 },
      /paydayWeekday must be a whole weekday from 0 \(Sunday\) to 6 \(Saturday\), got -1/,
    ],
    [
      'payday weekday 7',
      { paydayWeekday: 7 },
      /paydayWeekday must be a whole weekday from 0 \(Sunday\) to 6 \(Saturday\), got 7/,
    ],
    [
      'payday weekday 1.5',
      { paydayWeekday: 1.5 },
      /paydayWeekday must be a whole weekday from 0 \(Sunday\) to 6 \(Saturday\), got 1.5/,
    ],
    [
      'payday weekday NaN',
      { paydayWeekday: Number.NaN },
      /paydayWeekday must be a whole weekday from 0 \(Sunday\) to 6 \(Saturday\), got NaN/,
    ],
    // Personal tax owed is checked even when Strawb is in view and the
    // personal hold is never computed: the same rows never succeed in one
    // scope and throw in another.
    [
      'negative personal tax owed, in Strawb scope',
      { scope: 'strawb', personalTaxOwedCents: -1 },
      /personalTaxOwedCents must not be negative, got -1/,
    ],
    [
      'fractional personal tax owed, in Strawb scope',
      { scope: 'strawb', personalTaxOwedCents: 100.5 },
      /personalTaxOwedCents must be an integer number of cents, got 100.5/,
    ],
    [
      'personal tax owed past the safe-integer range, in Strawb scope',
      { scope: 'strawb', personalTaxOwedCents: Number.MAX_SAFE_INTEGER + 1 },
      /personalTaxOwedCents must be an integer number of cents, got 9007199254740992/,
    ],
    ['an impossible date', { today: '2026-02-30' }, /today must be a YYYY-MM-DD calendar date/],
    ['a timestamp, not a date', { today: '2026-10-23T09:00:00Z' }, /today must be a YYYY-MM-DD calendar date/],
    // Text before the date, so the pattern is anchored at the start as well
    // as the end (#127).
    [
      'a date with a leading character',
      { today: 'x2026-10-23' },
      /^today must be a YYYY-MM-DD calendar date, got "x2026-10-23"$/,
    ],
    // The week around `today` must stay in the years 0000 to 9999 (#126).
    [
      'a today whose last payday is before the year 0000',
      { today: '0000-01-01' },
      /^a payday must fall in the years 0000 to 9999, got year -1$/,
    ],
    [
      'a today whose next payday is after the year 9999',
      { today: '9999-12-30' },
      /^a payday must fall in the years 0000 to 9999, got year 10000$/,
    ],
    ['a fractional tax rate', { taxRateBasisPoints: 2812.5 }, /taxRateBasisPoints must be a whole number/],
    ['a tax rate over 100%', { taxRateBasisPoints: 10001 }, /taxRateBasisPoints must be a whole number/],
    ['fractional profit', { profitCents: 100.5 }, /profitCents must be an integer number of cents/],
    // 2500 × 10_000_000_000_000 = 25_000_000_000_000_000, past
    // Number.MAX_SAFE_INTEGER (about 9.007 × 10^15), though each input is a
    // safe integer (#127).
    [
      'a tax rate × profit past the safe-integer range',
      { taxRateBasisPoints: 2500, profitCents: 10_000_000_000_000 },
      /^taxRateBasisPoints × profitCents must be an integer number of cents, got 25000000000000000$/,
    ],
    [
      'a fractional balance',
      { accounts: [{ id: 'p-cur', scope: 'personal', role: 'current', balanceCents: 10.5 }], transactions: [] },
      /balanceCents of account "p-cur" must be an integer number of cents/,
    ],
    [
      'a fractional transaction amount',
      {
        transactions: [
          { accountId: 'p-cur', date: '2026-10-21', amountCents: -1.5, category: 'Groceries', status: 'settled' },
        ],
      },
      /transaction amountCents must be an integer number of cents/,
    ],
    [
      'a negative bill',
      { bills: [{ id: 'x', scope: 'personal', amountCents: -100, dueDate: '2026-10-24', paid: false }] },
      /amountCents of bill "x" must not be negative/,
    ],
    [
      'a bill with a bad due date',
      { bills: [{ id: 'x', scope: 'personal', amountCents: 100, dueDate: '24/10/2026', paid: false }] },
      /dueDate of bill "x" must be a YYYY-MM-DD calendar date/,
    ],
    [
      'a negative budget limit',
      { budgets: [{ id: 'g', scope: 'personal', category: 'Groceries', limitCents: -1 }] },
      /limitCents of budget "g" must not be negative/,
    ],
    [
      'a fractional balance on an account outside the scope',
      {
        scope: 'personal',
        accounts: [...ACCOUNTS, { id: 's-odd', scope: 'strawb', role: 'current', balanceCents: 10.5 }],
      },
      /balanceCents of account "s-odd" must be an integer number of cents/,
    ],
    [
      'a fractional card balance on a card outside the scope',
      {
        scope: 'strawb',
        accounts: [...ACCOUNTS, P_CARD(-10.5)],
      },
      /balanceCents of account "p-card" must be an integer number of cents/,
    ],
    [
      'a transaction on an unknown account when no budget is in scope',
      {
        budgets: [],
        transactions: [
          { accountId: 'ghost', date: '2026-10-21', amountCents: -100, category: 'Groceries', status: 'settled' },
        ],
      },
      /unknown account "ghost"/,
    ],
    ['a negative tax rate', { taxRateBasisPoints: -1 }, /taxRateBasisPoints must be a whole number from 0 to 10000/],
    [
      'a bad transaction date when no budget is in scope',
      {
        budgets: [],
        transactions: [
          { accountId: 'p-cur', date: '2026-10-1', amountCents: -100, category: 'Groceries', status: 'settled' },
        ],
      },
      /transaction date must be a YYYY-MM-DD calendar date/,
    ],
    [
      'the same account twice',
      { accounts: [...ACCOUNTS, { id: 'p-cur', scope: 'strawb', role: 'current', balanceCents: 1 }] },
      /account "p-cur" appears twice/,
    ],
    ['an unknown scope', { scope: 'business' as unknown as 'all' }, /scope must be all, personal or strawb/],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => safeToSpend(base(overrides))).toThrow(message)
  })
})

describe('contracts: settings', () => {
  // Later waves seed and read settings from these constants; a wrong default
  // silently moves the tax hold or the payday, so the values are pinned as
  // literals.
  it('defaults are exactly the ruled values', () => {
    expect(SETTINGS_DEFAULTS).toStrictEqual({
      tax_rate_bp: 2500,
      profit_cents: 0,
      payday_weekday: 2, // Tuesday (prd-02 Ruling 9)
      personal_tax_owed_cents: 0,
      currency: '$',
    })
    // The tax rate is stored as an integer, not a float (issue #36).
    expect(Number.isInteger(SETTINGS_DEFAULTS.tax_rate_bp)).toBe(true)
  })

  it('every SettingsResponse field reads one stored key, and every key is read', () => {
    const fields: Record<keyof SettingsResponse, true> = {
      taxRateBasisPoints: true,
      profitCents: true,
      paydayWeekday: true,
      personalTaxOwedCents: true,
      currency: true,
    }
    expect(Object.keys(SETTING_KEYS).sort()).toEqual(Object.keys(fields).sort())
    expect(SETTING_KEYS).toStrictEqual({
      taxRateBasisPoints: 'tax_rate_bp',
      profitCents: 'profit_cents',
      paydayWeekday: 'payday_weekday',
      personalTaxOwedCents: 'personal_tax_owed_cents',
      currency: 'currency',
    })
    expect(Object.values(SETTING_KEYS).sort()).toEqual(Object.keys(SETTINGS_DEFAULTS).sort())
  })
})

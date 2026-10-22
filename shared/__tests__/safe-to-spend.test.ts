// The fixed test table for safe-to-spend: the contract prd-02 says to hold
// ("The one risk worth watching"). Every expected number below is worked by
// hand in the comment above it, from the rows in this file, and written as a
// literal. None is computed by the code under test. To check a case, redo
// the arithmetic in its comment.
//
//   safe = liquid − unpaid bills − remaining budget − tax hold
//   (prd-02 Ruling 2; shared/safe-to-spend.ts)

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
// The base fixture. Today is Fri 23 Oct 2026, payday is the 28th:
//   last payday 2026-09-28, next payday 2026-10-28, 5 days to go.
// Tax: 28% (2800 bp) of $10,000.00 profit = 1000000 × 2800 / 10000 = 280000.
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
  { id: 'supplier', scope: 'strawb', amountCents: 40000, dueDate: '2026-10-28', paid: false },
  // due the day AFTER payday: excluded
  { id: 'gym', scope: 'personal', amountCents: 5000, dueDate: '2026-10-29', paid: false },
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
  // Personal Groceries, in the window 2026-09-28..2026-10-23:
  { accountId: 'p-cur', date: '2026-10-01', amountCents: -30000, category: 'Groceries', status: 'settled' },
  { accountId: 'p-cur', date: '2026-10-22', amountCents: -15000, category: 'Groceries', status: 'pending' },
  { accountId: 'p-cur', date: '2026-09-28', amountCents: -1000, category: 'Groceries', status: 'settled' },
  // a refund is money in: not spend, and does not offset spend
  { accountId: 'p-cur', date: '2026-10-10', amountCents: 5000, category: 'Groceries', status: 'settled' },
  // the day before the last payday: previous cycle, excluded
  { accountId: 'p-cur', date: '2026-09-27', amountCents: -9999, category: 'Groceries', status: 'settled' },
  // dated after today: excluded
  { accountId: 'p-cur', date: '2026-10-24', amountCents: -7000, category: 'Groceries', status: 'pending' },
  // a Strawb account buying groceries: not the personal budget's spend
  { accountId: 's-cur', date: '2026-10-05', amountCents: -2000, category: 'Groceries', status: 'settled' },
  // income, and an uncategorised spend: no budget
  { accountId: 'p-cur', date: '2026-09-28', amountCents: 400000, category: 'Salary', status: 'settled' },
  { accountId: 'p-cur', date: '2026-10-12', amountCents: -3000, category: null, status: 'settled' },
  // Strawb Software, over its 20000 limit
  { accountId: 's-cur', date: '2026-10-03', amountCents: -25000, category: 'Software', status: 'settled' },
]

function base(overrides: Partial<SafeToSpendInput> = {}): SafeToSpendInput {
  return {
    scope: 'all',
    today: '2026-10-23',
    paydayDay: 28,
    taxRateBasisPoints: 2800,
    profitCents: 1000000,
    accounts: ACCOUNTS,
    bills: BILLS,
    budgets: BUDGETS,
    transactions: TRANSACTIONS,
    ...overrides,
  }
}

// Groceries spent = 30000 + 15000 + 1000 = 46000 (refund, 09-27, 10-24 and
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

const PAYDAY_OCT = { today: '2026-10-23', lastPayday: '2026-09-28', nextPayday: '2026-10-28', daysToPayday: 5 }

interface Case {
  name: string
  input: SafeToSpendInput
  expected: SafeToSpendResult
}

const CASES: Case[] = [
  {
    // liquid  = p-cur 300000 + s-cur 200000 = 500000
    //           (savings 500000, no-role 7000 and the tax pot 30000 are not liquid)
    // bills   = rent 100000 + supplier 40000 + power 12000 = 152000
    //           (gym due 10-29 is after payday; phone is paid)
    // budgets = groceries 14000 + software 0 = 14000
    // tax     = owed 280000 − pot 30000 = hold 250000
    // safe    = 500000 − 152000 − 14000 − 250000 = 84000
    // per day = 84000 ÷ 5 = 16800
    name: 'all scope: every term from both sides',
    input: base({ scope: 'all' }),
    expected: {
      scope: 'all',
      ...PAYDAY_OCT,
      liquidCents: 500000,
      unpaidBillsCents: 152000,
      remainingBudgetCents: 14000,
      taxOwedCents: 280000,
      taxPotCents: 30000,
      taxHoldCents: 250000,
      safeCents: 84000,
      shortByCents: 0,
      perDayCents: 16800,
      budgets: [GROCERIES, SOFTWARE],
    },
  },
  {
    // liquid  = p-cur 300000
    // bills   = rent 100000 + power 12000 = 112000
    // budgets = groceries 14000
    // tax     = 0 in Personal (owed 0, pot 0, hold 0) though profit is set
    // safe    = 300000 − 112000 − 14000 − 0 = 174000
    // per day = 174000 ÷ 5 = 34800
    name: 'personal scope: personal rows only, no tax hold',
    input: base({ scope: 'personal' }),
    expected: {
      scope: 'personal',
      ...PAYDAY_OCT,
      liquidCents: 300000,
      unpaidBillsCents: 112000,
      remainingBudgetCents: 14000,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: 174000,
      shortByCents: 0,
      perDayCents: 34800,
      budgets: [GROCERIES],
    },
  },
  {
    // liquid  = s-cur 200000
    // bills   = supplier 40000 (due on payday counts)
    // budgets = software 0 (over its limit; adds nothing, takes nothing extra)
    // tax     = owed 280000 − pot 30000 = hold 250000
    // safe    = 200000 − 40000 − 0 − 250000 = −90000   (negative, not clamped)
    // short   = 90000
    // per day = −90000 ÷ 5 = −18000
    name: 'strawb scope: negative result is returned signed, with short-by',
    input: base({ scope: 'strawb' }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 200000,
      unpaidBillsCents: 40000,
      remainingBudgetCents: 0,
      taxOwedCents: 280000,
      taxPotCents: 30000,
      taxHoldCents: 250000,
      safeCents: -90000,
      shortByCents: 90000,
      perDayCents: -18000,
      budgets: [SOFTWARE],
    },
  },
  {
    // Profit 0 (Xero not connected): owed = 2800 × 0 / 10000 = 0;
    //   hold = max(0, 0 − 30000) = 0. The pot just sits outside liquid.
    // safe    = 200000 − 40000 − 0 − 0 = 160000
    // per day = 160000 ÷ 5 = 32000
    name: 'strawb, profit 0 with money in the tax pot: hold is 0',
    input: base({ scope: 'strawb', profitCents: 0 }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 200000,
      unpaidBillsCents: 40000,
      remainingBudgetCents: 0,
      taxOwedCents: 0,
      taxPotCents: 30000,
      taxHoldCents: 0,
      safeCents: 160000,
      shortByCents: 0,
      perDayCents: 32000,
      budgets: [SOFTWARE],
    },
  },
  {
    // Profit 100000: owed = 2800 × 100000 / 10000 = 28000;
    //   hold = max(0, 28000 − 30000) = 0, not −2000 (the pot is not liquid).
    // safe    = 200000 − 40000 − 0 − 0 = 160000
    // per day = 160000 ÷ 5 = 32000
    name: 'strawb, tax pot above the tax owed: hold is 0, not negative',
    input: base({ scope: 'strawb', profitCents: 100000 }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 200000,
      unpaidBillsCents: 40000,
      remainingBudgetCents: 0,
      taxOwedCents: 28000,
      taxPotCents: 30000,
      taxHoldCents: 0,
      safeCents: 160000,
      shortByCents: 0,
      perDayCents: 32000,
      budgets: [SOFTWARE],
    },
  },
  {
    // A loss: profit −500000 owes nothing; hold 0.
    // safe = 200000 − 40000 − 0 − 0 = 160000; per day 32000
    name: 'strawb, negative profit: nothing owed',
    input: base({ scope: 'strawb', profitCents: -500000 }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 200000,
      unpaidBillsCents: 40000,
      remainingBudgetCents: 0,
      taxOwedCents: 0,
      taxPotCents: 30000,
      taxHoldCents: 0,
      safeCents: 160000,
      shortByCents: 0,
      perDayCents: 32000,
      budgets: [SOFTWARE],
    },
  },
  {
    // A personal-scope tax pot with profit set: Personal still holds 0.
    // liquid = 300000 (p-tax is not liquid); bills 112000; budgets 14000
    // safe = 300000 − 112000 − 14000 − 0 = 174000; per day 34800
    name: 'personal scope with a personal tax pot: still no tax hold',
    input: base({
      scope: 'personal',
      accounts: [...ACCOUNTS, { id: 'p-tax', scope: 'personal', role: 'tax_pot', balanceCents: 50000 }],
    }),
    expected: {
      scope: 'personal',
      ...PAYDAY_OCT,
      liquidCents: 300000,
      unpaidBillsCents: 112000,
      remainingBudgetCents: 14000,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: 174000,
      shortByCents: 0,
      perDayCents: 34800,
      budgets: [GROCERIES],
    },
  },
  {
    // The same personal tax pot seen from Strawb: it is not Strawb's.
    // liquid = s-cur 200000; bills = supplier 40000; budgets = software 0
    // tax    = owed 280000 − pot 30000 (s-tax only; p-tax 50000 is personal)
    //        = hold 250000
    // safe   = 200000 − 40000 − 0 − 250000 = −90000; short 90000
    // per day = −90000 ÷ 5 = −18000
    name: 'strawb scope with a personal tax pot: only the Strawb pot nets',
    input: base({
      scope: 'strawb',
      accounts: [...ACCOUNTS, { id: 'p-tax', scope: 'personal', role: 'tax_pot', balanceCents: 50000 }],
    }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 200000,
      unpaidBillsCents: 40000,
      remainingBudgetCents: 0,
      taxOwedCents: 280000,
      taxPotCents: 30000,
      taxHoldCents: 250000,
      safeCents: -90000,
      shortByCents: 90000,
      perDayCents: -18000,
      budgets: [SOFTWARE],
    },
  },
  {
    // All scope nets every in-scope tax pot, a personal one included
    //   (Ruling 2: "in-scope"; #29 may say otherwise).
    // liquid 500000; bills 152000; budgets 14000
    // tax    = owed 280000 − pots (s-tax 30000 + p-tax 50000 = 80000)
    //        = hold 200000
    // safe   = 500000 − 152000 − 14000 − 200000 = 134000
    // per day = 134000 ÷ 5 = 26800
    name: 'all scope with a personal tax pot: every in-scope pot nets',
    input: base({
      scope: 'all',
      accounts: [...ACCOUNTS, { id: 'p-tax', scope: 'personal', role: 'tax_pot', balanceCents: 50000 }],
    }),
    expected: {
      scope: 'all',
      ...PAYDAY_OCT,
      liquidCents: 500000,
      unpaidBillsCents: 152000,
      remainingBudgetCents: 14000,
      taxOwedCents: 280000,
      taxPotCents: 80000,
      taxHoldCents: 200000,
      safeCents: 134000,
      shortByCents: 0,
      perDayCents: 26800,
      budgets: [GROCERIES, SOFTWARE],
    },
  },
  {
    // A 100% tax rate is allowed: owed = 10000 × 1000000 / 10000 = 1000000.
    // liquid 200000; bills 40000; budgets 0; hold = 1000000 − 30000 = 970000
    // safe = 200000 − 40000 − 0 − 970000 = −810000; short 810000
    // per day = −810000 ÷ 5 = −162000
    name: 'strawb, tax rate 10000 bp (100%) is the upper bound, accepted',
    input: base({ scope: 'strawb', taxRateBasisPoints: 10000 }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 200000,
      unpaidBillsCents: 40000,
      remainingBudgetCents: 0,
      taxOwedCents: 1000000,
      taxPotCents: 30000,
      taxHoldCents: 970000,
      safeCents: -810000,
      shortByCents: 810000,
      perDayCents: -162000,
      budgets: [SOFTWARE],
    },
  },
  {
    // An overdrawn current account is negative liquid, not zero.
    // liquid = −5000; bills 0; budgets 0; tax 0
    // safe = −5000; short 5000; per day = −5000 ÷ 5 = −1000
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
      ...PAYDAY_OCT,
      liquidCents: -5000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: -5000,
      shortByCents: 5000,
      perDayCents: -1000,
      budgets: [],
    },
  },
  {
    // Tax owed rounds UP to the cent: 2500 × 333 / 10000 = 83.25 → 84.
    // liquid = 10000; hold = 84 − 0 = 84
    // safe = 10000 − 84 = 9916; per day = 9916 ÷ 5 = 1983.2 → 1983 (down)
    name: 'one rounding each: tax owed rounds up, per day rounds down',
    input: base({
      scope: 'strawb',
      taxRateBasisPoints: 2500,
      profitCents: 333,
      accounts: [{ id: 's-cur', scope: 'strawb', role: 'current', balanceCents: 10000 }],
      bills: [],
      budgets: [],
      transactions: [],
    }),
    expected: {
      scope: 'strawb',
      ...PAYDAY_OCT,
      liquidCents: 10000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      taxOwedCents: 84,
      taxPotCents: 0,
      taxHoldCents: 84,
      safeCents: 9916,
      shortByCents: 0,
      perDayCents: 1983,
      budgets: [],
    },
  },
  {
    // safe = 0 − 1 = −1; per day = −1 ÷ 5 = −0.2 → −1 (down, never flattering)
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
      ...PAYDAY_OCT,
      liquidCents: 0,
      unpaidBillsCents: 1,
      remainingBudgetCents: 0,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: -1,
      shortByCents: 1,
      perDayCents: -1,
      budgets: [],
    },
  },
  {
    // Zero accounts, one rent bill: liquid 0; bills 100000
    // safe = 0 − 100000 = −100000; short 100000; per day = −100000 ÷ 5 = −20000
    name: 'zero accounts with a bill due',
    input: base({ accounts: [], bills: [BILLS[0]], budgets: [], transactions: [], profitCents: 0 }),
    expected: {
      scope: 'all',
      ...PAYDAY_OCT,
      liquidCents: 0,
      unpaidBillsCents: 100000,
      remainingBudgetCents: 0,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: -100000,
      shortByCents: 100000,
      perDayCents: -20000,
      budgets: [],
    },
  },
  {
    // Nothing at all: every money figure 0; days to payday is still 5.
    name: 'empty inputs',
    input: base({ accounts: [], bills: [], budgets: [], transactions: [], profitCents: 0 }),
    expected: {
      scope: 'all',
      ...PAYDAY_OCT,
      liquidCents: 0,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: 0,
      shortByCents: 0,
      perDayCents: 0,
      budgets: [],
    },
  },
  {
    // On payday itself (2026-10-28): last payday is today, next is 2026-11-28,
    //   31 days away. Budgets reset: no spend is dated 10-28, so
    //   groceries remaining 60000, software remaining 20000 = 80000.
    // bills = rent 100000 (10-25, now overdue) + supplier 40000 (10-28)
    //       + gym 5000 (10-29, now before the next payday) + power 12000
    //       = 157000; phone still paid.
    // liquid 500000; hold 250000
    // safe = 500000 − 157000 − 80000 − 250000 = 13000
    // per day = 13000 ÷ 31 = 419.35… → 419
    name: 'on payday: the cycle resets and the next payday is a month out',
    input: base({ today: '2026-10-28' }),
    expected: {
      scope: 'all',
      today: '2026-10-28',
      lastPayday: '2026-10-28',
      nextPayday: '2026-11-28',
      daysToPayday: 31,
      liquidCents: 500000,
      unpaidBillsCents: 157000,
      remainingBudgetCents: 80000,
      taxOwedCents: 280000,
      taxPotCents: 30000,
      taxHoldCents: 250000,
      safeCents: 13000,
      shortByCents: 0,
      perDayCents: 419,
      budgets: [
        { ...GROCERIES, spentCents: 0, remainingCents: 60000, overCents: 0 },
        { ...SOFTWARE, spentCents: 0, remainingCents: 20000, overCents: 0 },
      ],
    },
  },
  {
    // Payday 31 in November (30 days): today 2026-11-15 → last payday
    //   2026-10-31, next 2026-11-30 (clamped), 15 days.
    // Groceries: −1000 on 10-31 counts; −2000 on 10-30 is the old cycle.
    //   spent 1000, remaining 60000 − 1000 = 59000.
    // liquid 300000; bills 0; safe = 300000 − 59000 = 241000
    // per day = 241000 ÷ 15 = 16066.66… → 16066
    name: 'payday 31 in a 30-day month: spend counts from the 31st before',
    input: base({
      scope: 'personal',
      today: '2026-11-15',
      paydayDay: 31,
      bills: [],
      budgets: [BUDGETS[0]],
      transactions: [
        { accountId: 'p-cur', date: '2026-10-31', amountCents: -1000, category: 'Groceries', status: 'settled' },
        { accountId: 'p-cur', date: '2026-10-30', amountCents: -2000, category: 'Groceries', status: 'settled' },
      ],
    }),
    expected: {
      scope: 'personal',
      today: '2026-11-15',
      lastPayday: '2026-10-31',
      nextPayday: '2026-11-30',
      daysToPayday: 15,
      liquidCents: 300000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 59000,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: 241000,
      shortByCents: 0,
      perDayCents: 16066,
      budgets: [{ ...GROCERIES, spentCents: 1000, remainingCents: 59000, overCents: 0 }],
    },
  },
  {
    // Payday 31 in February 2027 (28 days): today 2027-03-10 → last payday
    //   2027-02-28 (clamped), next 2027-03-31, 21 days.
    // Groceries: −4000 on 02-28 counts; −8000 on 02-27 does not.
    //   remaining 60000 − 4000 = 56000.
    // bill 'insurance' due 2027-03-31 (= next payday) counts: 30000.
    // safe = 300000 − 30000 − 56000 = 214000
    // per day = 214000 ÷ 21 = 10190.47… → 10190
    name: 'payday 31 after February: last payday is 28 Feb',
    input: base({
      scope: 'personal',
      today: '2027-03-10',
      paydayDay: 31,
      bills: [{ id: 'insurance', scope: 'personal', amountCents: 30000, dueDate: '2027-03-31', paid: false }],
      budgets: [BUDGETS[0]],
      transactions: [
        { accountId: 'p-cur', date: '2027-02-28', amountCents: -4000, category: 'Groceries', status: 'pending' },
        { accountId: 'p-cur', date: '2027-02-27', amountCents: -8000, category: 'Groceries', status: 'settled' },
      ],
    }),
    expected: {
      scope: 'personal',
      today: '2027-03-10',
      lastPayday: '2027-02-28',
      nextPayday: '2027-03-31',
      daysToPayday: 21,
      liquidCents: 300000,
      unpaidBillsCents: 30000,
      remainingBudgetCents: 56000,
      taxOwedCents: 0,
      taxPotCents: 0,
      taxHoldCents: 0,
      safeCents: 214000,
      shortByCents: 0,
      perDayCents: 10190,
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
  'taxOwedCents',
  'taxPotCents',
  'taxHoldCents',
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
      result.taxOwedCents,
      result.taxPotCents,
      result.taxHoldCents,
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

  it('All is Personal plus Strawb when only Strawb holds tax', () => {
    // 174000 + (−90000) = 84000: the All, Personal and Strawb rows above.
    const all = safeToSpend(base({ scope: 'all' })).safeCents
    const personal = safeToSpend(base({ scope: 'personal' })).safeCents
    const strawb = safeToSpend(base({ scope: 'strawb' })).safeCents
    expect(all).toBe(84000)
    expect(personal + strawb).toBe(84000)
  })

  it('does not read the clock: the same input gives the same answer', () => {
    expect(safeToSpend(base())).toStrictEqual(safeToSpend(base()))
  })
})

describe('budgetSpentCents', () => {
  // Window 2026-10-31..2026-11-15 (payday 31, a 30-day November), personal
  // Groceries. Each row is −1000 unless it says otherwise.
  const accounts = ACCOUNTS
  const window = { scope: 'personal' as const, category: 'Groceries', from: '2026-10-31', to: '2026-11-15' }
  const row = (o: Partial<SafeToSpendTransaction>): SafeToSpendTransaction => ({
    accountId: 'p-cur',
    date: '2026-11-05',
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
    ['spend on the last payday counts', [row({ date: '2026-10-31' })], 1000],
    ['spend the day before the last payday does not', [row({ date: '2026-10-30' })], 0],
    ['spend on today counts', [row({ date: '2026-11-15' })], 1000],
    ['spend dated after today does not', [row({ date: '2026-11-16' })], 0],
    ['spend on a Strawb account does not count for a personal budget', [row({ accountId: 's-cur' })], 0],
    ['spend in another category does not count', [row({ category: 'Dining' })], 0],
    ['uncategorised spend does not count', [row({ category: null })], 0],
    ['spend on a savings account counts: its scope is personal', [row({ accountId: 'p-sav' })], 1000],
    ['nothing at all is 0', [], 0],
  ])('%s', (_name, transactions, expected) => {
    expect(budgetSpentCents({ accounts, transactions, ...window })).toBe(expected)
  })

  it('refuses a transaction on an account it was not given', () => {
    expect(() =>
      budgetSpentCents({ accounts, transactions: [row({ accountId: 'ghost' })], ...window }),
    ).toThrow(/unknown account "ghost"/)
  })
})

describe('paydays', () => {
  it.each<[string, number, string, string, number]>([
    // today, payday day, last payday, next payday, days to it
    ['2026-10-23', 28, '2026-09-28', '2026-10-28', 5],
    ['2026-10-27', 28, '2026-09-28', '2026-10-28', 1],
    ['2026-10-28', 28, '2026-10-28', '2026-11-28', 31],
    // payday 31 in a 30-day month clamps to the 30th
    ['2026-11-15', 31, '2026-10-31', '2026-11-30', 15],
    ['2026-11-30', 31, '2026-11-30', '2026-12-31', 31],
    ['2026-12-01', 31, '2026-11-30', '2026-12-31', 30],
    // February, not a leap year: 29, 30, 31 all clamp to the 28th
    ['2027-02-10', 30, '2027-01-30', '2027-02-28', 18],
    ['2027-02-28', 29, '2027-02-28', '2027-03-29', 29],
    ['2027-03-01', 31, '2027-02-28', '2027-03-31', 30],
    // February in a leap year clamps to the 29th
    ['2028-02-10', 30, '2028-01-30', '2028-02-29', 19],
    ['2028-02-29', 31, '2028-02-29', '2028-03-31', 31],
    // 2100 is not a leap year (divisible by 100, not by 400)
    ['2100-02-15', 29, '2100-01-29', '2100-02-28', 13],
    // the year boundary
    ['2026-12-31', 31, '2026-12-31', '2027-01-31', 31],
    ['2026-01-05', 31, '2025-12-31', '2026-01-31', 26],
    // payday on the 1st
    ['2026-10-01', 1, '2026-10-01', '2026-11-01', 31],
    ['2026-10-31', 1, '2026-10-01', '2026-11-01', 1],
  ])('today %s, payday %i: last %s, next %s, %i days', (today, day, last, next, days) => {
    expect(lastPayday(today, day)).toBe(last)
    expect(nextPayday(today, day)).toBe(next)
    expect(daysBetween(today, next)).toBe(days)
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
    ['payday day 0', { paydayDay: 0 }, /paydayDay must be a whole day from 1 to 31/],
    ['payday day 32', { paydayDay: 32 }, /paydayDay must be a whole day from 1 to 31/],
    ['payday day 1.5', { paydayDay: 1.5 }, /paydayDay must be a whole day from 1 to 31/],
    ['an impossible date', { today: '2026-02-30' }, /today must be a YYYY-MM-DD calendar date/],
    ['a timestamp, not a date', { today: '2026-10-23T09:00:00Z' }, /today must be a YYYY-MM-DD calendar date/],
    ['a fractional tax rate', { taxRateBasisPoints: 2812.5 }, /taxRateBasisPoints must be a whole number/],
    ['a tax rate over 100%', { taxRateBasisPoints: 10001 }, /taxRateBasisPoints must be a whole number/],
    ['fractional profit', { profitCents: 100.5 }, /profitCents must be an integer number of cents/],
    [
      'a fractional balance',
      { accounts: [{ id: 'p-cur', scope: 'personal', role: 'current', balanceCents: 10.5 }], transactions: [] },
      /balanceCents of account "p-cur" must be an integer number of cents/,
    ],
    [
      'a fractional transaction amount',
      {
        transactions: [
          { accountId: 'p-cur', date: '2026-10-01', amountCents: -1.5, category: 'Groceries', status: 'settled' },
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
      'a transaction on an unknown account when no budget is in scope',
      {
        budgets: [],
        transactions: [
          { accountId: 'ghost', date: '2026-10-01', amountCents: -100, category: 'Groceries', status: 'settled' },
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
  // silently moves the tax hold, so the values are pinned as literals.
  it('defaults are exactly the ruled values', () => {
    expect(SETTINGS_DEFAULTS).toStrictEqual({
      tax_rate_bp: 2500,
      profit_cents: 0,
      payday_day: 28,
      currency: '$',
    })
    // The tax rate is stored as an integer, not a float (issue #36).
    expect(Number.isInteger(SETTINGS_DEFAULTS.tax_rate_bp)).toBe(true)
  })

  it('every SettingsResponse field reads one stored key, and every key is read', () => {
    const fields: Record<keyof SettingsResponse, true> = {
      taxRateBasisPoints: true,
      profitCents: true,
      paydayDay: true,
      currency: true,
    }
    expect(Object.keys(SETTING_KEYS).sort()).toEqual(Object.keys(fields).sort())
    expect(SETTING_KEYS).toStrictEqual({
      taxRateBasisPoints: 'tax_rate_bp',
      profitCents: 'profit_cents',
      paydayDay: 'payday_day',
      currency: 'currency',
    })
    expect(Object.values(SETTING_KEYS).sort()).toEqual(Object.keys(SETTINGS_DEFAULTS).sort())
  })
})

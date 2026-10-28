// `get_safe_to_spend` (prd-03 Ruling 1, Done when 1; #473). This test fails
// if:
//   - for the fixed test table's base fixture (shared/__tests__/
//     safe-to-spend.test.ts), seeded into a replica as stored rows, the
//     result differs from that table's expected Personal or Strawb result by
//     a cent, or gains, loses or renames a key, at the top or in a budget
//     line;
//   - the handler computes with any clock but the call's (today must be the
//     clock's NZ date, Fri 2026-10-23);
//   - `data_as_of` is not the replica meta's;
//   - the tool stops importing `gatherSafeToSpendInputs` and `safeToSpend`
//     from `shared/` (doing its own gathering or arithmetic instead);
//   - a row the Overview does not read (a Xero account, a Xero-sourced
//     transaction, the `currency` setting) changes the result or is refused;
//   - an undated transaction on a stored account becomes a number instead of
//     the Overview's refusal;
//   - a replica that cannot be read becomes a result instead of a throw.
//
// It runs the handler against a real small replica file through the real
// reader, so the SQL is exercised, not mocked.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clock, HandlerContext, HandlerOutcome } from '../../contracts.ts'
import { openReplica } from '../../replica/index.ts'
import { close, openDatabase, run } from '../../replica/scrub.ts'
import { getSafeToSpend } from '../get-safe-to-spend.ts'

const SOURCE = fileURLToPath(new URL('../get-safe-to-spend.ts', import.meta.url))

// Two NZ days before the clock (Wed 2026-10-21), so a handler that took
// "now" from the replica's age instead of the call's clock answers the
// wrong `today`.
const DATA_AS_OF = '2026-10-21T00:55:00.000Z'
const BUILT_AT = '2026-10-21T00:55:05.000Z'
// 14:00 NZDT on Fri 2026-10-23: the fixture's today.
const NOW = '2026-10-23T01:00:00.000Z'

const RESULT_KEYS = [
  'budgets',
  'card_debt_cents',
  'data_as_of',
  'days_to_payday',
  'last_payday',
  'liquid_cents',
  'next_payday',
  'per_day_cents',
  'personal_tax_hold_cents',
  'personal_tax_owed_cents',
  'personal_tax_pot_cents',
  'remaining_budget_cents',
  'safe_cents',
  'scope',
  'short_by_cents',
  'strawb_bills_buffer_cents',
  'strawb_tax_hold_cents',
  'strawb_tax_owed_cents',
  'strawb_tax_pot_cents',
  'tax_hold_cents',
  'today',
  'unpaid_bills_cents',
]
const BUDGET_LINE_KEYS = ['category', 'id', 'limit_cents', 'over_cents', 'remaining_cents', 'scope', 'spent_cents']

// ---------------------------------------------------------------------------
// The base fixture of shared/__tests__/safe-to-spend.test.ts (ACCOUNTS,
// BILLS, BUDGETS, TRANSACTIONS and the settings in `base()`), as the stored
// rows the Overview would load. Ids are integers, as stored; the fixture's
// names are kept in comments. Akahu ids join `transactions.account_id`.
// ---------------------------------------------------------------------------

// [id, akahu_id, scope, name, balance_cents, role]
const ACCOUNTS: readonly [number, string, string, string, number, string | null][] = [
  [1, 'acc_p_cur', 'personal', 'p-cur', 300000, 'current'],
  [2, 'acc_p_sav', 'personal', 'p-sav', 500000, 'savings'],
  [3, 'acc_p_new', 'personal', 'p-new', 7000, null], // no account_settings row
  [4, 'acc_s_cur', 'strawb', 's-cur', 200000, 'current'],
  [5, 'acc_s_tax', 'strawb', 's-tax', 30000, 'tax_pot'],
]

// [id, scope, name, amount_cents, first_due_date]; every one repeat 'none',
// so its only occurrence is the fixture's dueDate.
const BILLS: readonly [number, string, string, number, string][] = [
  [1, 'personal', 'rent', 100000, '2026-10-25'],
  [2, 'strawb', 'supplier', 40000, '2026-10-27'],
  [3, 'personal', 'gym', 5000, '2026-10-28'],
  [4, 'personal', 'power', 12000, '2026-10-01'],
  [5, 'personal', 'phone', 8000, '2026-10-20'], // paid: a bill_payments row
]
const BILL_PAYMENTS: readonly [number, string][] = [[5, '2026-10-20']]

// [id, scope, category, limit_cents]
const BUDGETS: readonly [number, string, string, number][] = [
  [1, 'personal', 'Groceries', 60000], // fixture id 'groceries'
  [2, 'strawb', 'Software', 20000], // fixture id 'software'
]

// [id, account_id (Akahu), NZ date, amount_cents, category, status]. Each is
// stored as UTC midnight of that date, which is 13:00 the same day in NZ.
const TRANSACTIONS: readonly [number, string, string, number, string | null, string][] = [
  [1, 'acc_p_cur', '2026-10-21', -30000, 'Groceries', 'settled'],
  [2, 'acc_p_cur', '2026-10-22', -15000, 'Groceries', 'pending'],
  [3, 'acc_p_cur', '2026-10-20', -1000, 'Groceries', 'settled'],
  [4, 'acc_p_cur', '2026-10-21', 5000, 'Groceries', 'settled'],
  [5, 'acc_p_cur', '2026-10-19', -9999, 'Groceries', 'settled'],
  [6, 'acc_p_cur', '2026-10-24', -7000, 'Groceries', 'pending'],
  [7, 'acc_s_cur', '2026-10-21', -2000, 'Groceries', 'settled'],
  [8, 'acc_p_cur', '2026-10-20', 400000, 'Salary', 'settled'],
  [9, 'acc_p_cur', '2026-10-22', -3000, null, 'settled'],
  [10, 'acc_s_cur', '2026-10-21', -25000, 'Software', 'settled'],
]

// `base()`: payday Tuesday (2), 28% tax, $10,000.00 profit, no personal tax.
const SETTINGS: readonly [string, string][] = [
  ['tax_rate_bp', '2800'],
  ['profit_cents', '1000000'],
  ['payday_weekday', '2'],
  ['personal_tax_owed_cents', '0'],
]

// ---------------------------------------------------------------------------
// Expected: EXPECT_PERSONAL and EXPECT_STRAWB from shared/__tests__/
// safe-to-spend.test.ts (worked by hand there), copied value for value and
// renamed to the advisor's snake_case. That file exports nothing, so the
// literals are copied, not imported. Budget line ids are the stored ids as
// text ('1', '2'), where the fixture names them 'groceries' and 'software'.
// ---------------------------------------------------------------------------

const GROCERIES = {
  id: '1',
  scope: 'personal',
  category: 'Groceries',
  limit_cents: 60000,
  spent_cents: 46000,
  remaining_cents: 14000,
  over_cents: 0,
}
const SOFTWARE = {
  id: '2',
  scope: 'strawb',
  category: 'Software',
  limit_cents: 20000,
  spent_cents: 25000,
  remaining_cents: 0,
  over_cents: 5000,
}

const EXPECT_PERSONAL = {
  scope: 'personal',
  today: '2026-10-23',
  last_payday: '2026-10-20',
  next_payday: '2026-10-27',
  days_to_payday: 4,
  liquid_cents: 300000,
  unpaid_bills_cents: 112000,
  remaining_budget_cents: 14000,
  strawb_tax_owed_cents: 0,
  strawb_tax_pot_cents: 0,
  strawb_bills_buffer_cents: 0,
  strawb_tax_hold_cents: 0,
  personal_tax_owed_cents: 0,
  personal_tax_pot_cents: 0,
  personal_tax_hold_cents: 0,
  tax_hold_cents: 0,
  card_debt_cents: 0,
  safe_cents: 174000,
  short_by_cents: 0,
  per_day_cents: 43500,
  budgets: [GROCERIES],
  data_as_of: DATA_AS_OF,
}

const EXPECT_STRAWB = {
  scope: 'strawb',
  today: '2026-10-23',
  last_payday: '2026-10-20',
  next_payday: '2026-10-27',
  days_to_payday: 4,
  liquid_cents: 200000,
  unpaid_bills_cents: 10000,
  remaining_budget_cents: 0,
  strawb_tax_owed_cents: 280000,
  strawb_tax_pot_cents: 30000,
  strawb_bills_buffer_cents: 30000,
  strawb_tax_hold_cents: 280000,
  personal_tax_owed_cents: 0,
  personal_tax_pot_cents: 0,
  personal_tax_hold_cents: 0,
  tax_hold_cents: 280000,
  card_debt_cents: 0,
  safe_cents: -90000,
  short_by_cents: 90000,
  per_day_cents: -22500,
  budgets: [SOFTWARE],
  data_as_of: DATA_AS_OF,
}

// Every row each query reads: the settings, accounts, roles, bills,
// payments and budgets; every transaction (all are dated from the window's
// start, Mon 2026-10-19, on); and the drawing candidates (the Strawb
// outflows and the personal inflows).
const ROWS_READ =
  SETTINGS.length +
  ACCOUNTS.length +
  ACCOUNTS.filter((a) => a[5] !== null).length +
  BILLS.length +
  BILL_PAYMENTS.length +
  BUDGETS.length +
  TRANSACTIONS.length +
  TRANSACTIONS.filter(([, acc, , amount]) => (acc.startsWith('acc_s_') ? amount < 0 : amount > 0)).length

let dir: string
let path: string

/** A replica holding the tables safe-to-spend reads, in the scrub's columns. */
async function writeReplica(): Promise<void> {
  const db = await openDatabase(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
  try {
    await run(db, 'CREATE TABLE replica_meta (built_at TEXT NOT NULL, last_sync_at TEXT, data_as_of TEXT NOT NULL)')
    await run(db, 'INSERT INTO replica_meta VALUES (?, ?, ?)', [BUILT_AT, DATA_AS_OF, DATA_AS_OF])
    await run(db, 'CREATE TABLE settings (key varchar(255), value text)')
    for (const [key, value] of SETTINGS) await run(db, 'INSERT INTO settings VALUES (?, ?)', [key, value])
    await run(
      db,
      'CREATE TABLE accounts (id integer, akahu_id varchar(255), source text, scope text, name varchar(255), balance_cents integer)',
    )
    await run(db, 'CREATE TABLE account_settings (account_id integer, role text)')
    for (const [id, akahuId, scope, name, balance, role] of ACCOUNTS) {
      await run(db, 'INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)', [id, akahuId, 'akahu', scope, name, balance])
      if (role !== null) await run(db, 'INSERT INTO account_settings VALUES (?, ?)', [id, role])
    }
    await run(
      db,
      'CREATE TABLE bills (id integer, scope text, name varchar(255), amount_cents integer, repeat text, first_due_date date)',
    )
    for (const [id, scope, name, amount, due] of BILLS) {
      await run(db, 'INSERT INTO bills VALUES (?, ?, ?, ?, ?, ?)', [id, scope, name, amount, 'none', due])
    }
    await run(db, 'CREATE TABLE bill_payments (bill_id integer, due_date date)')
    for (const [billId, due] of BILL_PAYMENTS) await run(db, 'INSERT INTO bill_payments VALUES (?, ?)', [billId, due])
    await run(db, 'CREATE TABLE budgets (id integer, scope text, category varchar(255), limit_cents integer)')
    for (const [id, scope, category, limit] of BUDGETS) {
      await run(db, 'INSERT INTO budgets VALUES (?, ?, ?, ?)', [id, scope, category, limit])
    }
    await run(
      db,
      'CREATE TABLE transactions (id integer, account_id varchar(255), source text, date datetime, amount_cents integer, category varchar(255), category_source text, status text)',
    )
    for (const [id, accountId, date, amount, category, status] of TRANSACTIONS) {
      await run(db, 'INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        accountId,
        'akahu',
        `${date}T00:00:00.000Z`,
        amount,
        category,
        'akahu',
        status,
      ])
    }
  } finally {
    await close(db)
  }
}

/** Runs `sql` statements against the replica `writeReplica` built. */
async function addToReplica(statements: readonly [string, readonly (string | number | null)[]][]): Promise<void> {
  const db = await openDatabase(path, sqlite3.OPEN_READWRITE)
  try {
    for (const [sql, params] of statements) await run(db, sql, params)
  } finally {
    await close(db)
  }
}

async function context(): Promise<HandlerContext> {
  const clock: Clock = { now: () => new Date(NOW) }
  return { replica: await openReplica({ path }), clock }
}

async function call(scope: 'personal' | 'strawb'): Promise<Extract<HandlerOutcome, { ok: true }>> {
  const outcome = await getSafeToSpend.handler({ scope }, await context())
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}`)
  return outcome
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'divvy-safe-to-spend-'))
  path = join(dir, 'replica.sqlite3')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('get_safe_to_spend', () => {
  it.each([
    ['personal', EXPECT_PERSONAL],
    ['strawb', EXPECT_STRAWB],
  ] as const)('equals the fixed table to the cent for %s', async (scope, expected) => {
    await writeReplica()
    const outcome = await call(scope)
    const result = outcome.result as unknown as { budgets: Record<string, unknown>[] }

    expect(Object.keys(outcome.result).sort()).toEqual(RESULT_KEYS)
    for (const line of result.budgets) expect(Object.keys(line).sort()).toEqual(BUDGET_LINE_KEYS)
    expect(outcome.result).toStrictEqual(expected)
    expect(outcome.rowCount).toBe(ROWS_READ)
  })

  // The Overview's loader reads only Akahu accounts and Akahu transactions,
  // and only the safe-to-spend setting keys; the replica also holds the
  // `currency` setting. None of these rows may move the number, or make the
  // settings read exceed its bound.
  it('ignores the rows the Overview does not read', async () => {
    await writeReplica()
    await addToReplica([
      ["INSERT INTO settings VALUES ('currency', 'NZ$')", []],
      ["INSERT INTO accounts VALUES (6, 'xero_bank', 'xero', 'personal', 'x-cur', 999999)", []],
      ['INSERT INTO account_settings VALUES (6, ?)', ['current']],
      [
        'INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [11, 'acc_p_cur', 'xero', '2026-10-21T00:00:00.000Z', -12345, 'Groceries', 'akahu', 'settled'],
      ],
    ])

    expect((await call('personal')).result).toStrictEqual(EXPECT_PERSONAL)
  })

  // The window reads undated rows so the gathering can refuse them, as the
  // Overview does ('a transaction is incomplete'), never leave them out.
  it('throws, as the Overview refuses, on an undated transaction on a stored account', async () => {
    await writeReplica()
    await addToReplica([
      [
        'INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [11, 'acc_p_cur', 'akahu', null, -100, 'Groceries', 'akahu', 'settled'],
      ],
    ])

    await expect(getSafeToSpend.handler({ scope: 'personal' }, await context())).rejects.toThrow(
      'a transaction is incomplete',
    )
  })

  it('imports its gathering and its arithmetic from shared/', () => {
    const source = readFileSync(SOURCE, 'utf8')

    expect(source).toMatch(
      /import\s*\{[^}]*\bgatherSafeToSpendInputs\b[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/safe-to-spend-inputs\.ts'/,
    )
    expect(source).toMatch(/import\s*\{[^}]*\bsafeToSpend\b[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/safe-to-spend\.ts'/)
    expect(source).toMatch(/\bgatherSafeToSpendInputs\(/)
    expect(source).toMatch(/\bsafeToSpend\(\{/)
    expect(source).not.toMatch(/from\s*'[^']*server\//)
  })

  it('throws, rather than returning text, when the replica cannot be read', async () => {
    await expect(getSafeToSpend.handler({ scope: 'personal' }, await context())).rejects.toThrow()
  })
})

// prd-02 wave 1 (#39): the planning schema. Covers
// 20261025120000_prd02_budgets_bills_goals_roles_dismissals.js from the
// schema just before it (holding a legacy `targets` row and a prd-01
// category correction), through `migrate:latest`, and back down.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../knexfile.js'
import { migrateToJustBefore } from './migrateToJustBefore.ts'
import type { AccountRole } from '../../../shared/contracts.ts'
import type { AccountScope } from '../../../models/sync.ts'
import type {
  AccountSetting,
  AlertDismissal,
  Bill,
  BillPayment,
  BillRepeat,
  Budget,
  Goal,
  GoalContribution,
} from '../../../models/planning.ts'

const OURS = '20261025120000_prd02_budgets_bills_goals_roles_dismissals.js'
const MONEY_AS_CENTS = '20261023120000_money_as_cents.js'

// Each table's columns, tied to its row type: adding a field to the type
// without a column (or the reverse) fails the key-set tests below, and
// TypeScript refuses a key here that the type does not have.
const BUDGET_KEYS: Record<keyof Budget, true> = {
  id: true,
  scope: true,
  category: true,
  limit_cents: true,
  note: true,
  created_at: true,
  updated_at: true,
}
const BILL_KEYS: Record<keyof Bill, true> = {
  id: true,
  scope: true,
  name: true,
  amount_cents: true,
  repeat: true,
  first_due_date: true,
  account_id: true,
  created_at: true,
  updated_at: true,
}
const BILL_PAYMENT_KEYS: Record<keyof BillPayment, true> = {
  id: true,
  bill_id: true,
  due_date: true,
  amount_cents: true,
  paid_at: true,
}
const GOAL_KEYS: Record<keyof Goal, true> = {
  id: true,
  name: true,
  target_cents: true,
  target_date: true,
  created_at: true,
  updated_at: true,
}
const GOAL_CONTRIBUTION_KEYS: Record<keyof GoalContribution, true> = {
  id: true,
  goal_id: true,
  amount_cents: true,
  contributed_at: true,
}
const ACCOUNT_SETTING_KEYS: Record<keyof AccountSetting, true> = {
  id: true,
  account_id: true,
  role: true,
  updated_at: true,
}
const ALERT_DISMISSAL_KEYS: Record<keyof AlertDismissal, true> = {
  alert_id: true,
  dismissed_at: true,
}

const TABLE_KEYS: [string, Record<string, true>][] = [
  ['budgets', BUDGET_KEYS],
  ['bills', BILL_KEYS],
  ['bill_payments', BILL_PAYMENT_KEYS],
  ['goals', GOAL_KEYS],
  ['goal_contributions', GOAL_CONTRIBUTION_KEYS],
  ['account_settings', ACCOUNT_SETTING_KEYS],
  ['alert_dismissals', ALERT_DISMISSAL_KEYS],
]
const NEW_TABLES = TABLE_KEYS.map(([table]) => table)

// Every value of each domain, as the types declare them. A `satisfies`
// list cannot miss a member silently: `Record<Union, true>` requires each.
const SCOPES = Object.keys({ personal: true, strawb: true } satisfies Record<
  AccountScope,
  true
>)
const REPEATS = Object.keys({
  none: true,
  weekly: true,
  monthly: true,
  yearly: true,
} satisfies Record<BillRepeat, true>)
const ROLES = Object.keys({
  current: true,
  savings: true,
  tax_pot: true,
  credit_card: true,
} satisfies Record<AccountRole, true>)

const REAL_DATES = ['2026-10-25', '2028-02-29']
const NOT_DATES: unknown[] = [
  '2026-02-29',
  '2026-02-30',
  '2026-13-01',
  '2026-2-3',
  20261025,
  '',
  'bogus',
  '2026-10-25 ',
  '2026-10-25T03:00:00Z',
]

const AT = '2026-10-25T03:00:00.000Z'
const LATER = '2026-10-25T03:05:00.000Z'

type Row = Record<string, unknown>

// `row` without `column`, so the insert leaves it out. Not `{ column: undefined }`:
// with `useNullAsDefault` knex binds that as NULL, which a column default
// never sees, so it could not catch a default creeping in.
function omit(row: Row, column: string): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== column))
}

let db: Knex

async function columns(table: string): Promise<string[]> {
  const info: { name: string }[] = await db.raw('PRAGMA table_info(??)', [table])
  return info.map((c) => c.name)
}

async function columnTypes(table: string): Promise<Record<string, string>> {
  const info: { name: string; type: string; notnull: number }[] = await db.raw(
    'PRAGMA table_info(??)',
    [table],
  )
  return Object.fromEntries(
    info.map((c) => [c.name, `${c.type.toLowerCase()}${c.notnull ? ' not null' : ''}`]),
  )
}

async function tables(): Promise<string[]> {
  return db('sqlite_master').where({ type: 'table' }).orderBy('name').pluck('name')
}

async function sequence(table: string): Promise<number | undefined> {
  const row = await db('sqlite_sequence').where({ name: table }).first('seq')
  return row?.seq
}

async function applied(): Promise<string[]> {
  const [completed] = (await db.migrate.list()) as [{ name: string }[], unknown]
  return completed.map((m) => m.name)
}

async function count(table: string): Promise<number> {
  const row = await db(table).count('* as n').first()
  return Number(row?.n)
}

// What SQLite says `targets` is, as PRAGMA output rather than raw SQL, which
// differs in quoting and spacing between a knex create and a knex rebuild.
async function targetsShape() {
  const cols: Row[] = await db.raw('PRAGMA table_info(targets)')
  const keys: Row[] = await db.raw('PRAGMA foreign_key_list(targets)')
  const indexes: { name: string; unique: number; origin: string; partial: number }[] =
    await db.raw('PRAGMA index_list(targets)')
  const sql: string = (await db('sqlite_master').where({ name: 'targets' }).first('sql')).sql
  return {
    columns: cols.map((c) => ({ ...c, type: String(c.type).toLowerCase() })),
    foreignKeys: keys.map(({ table, from, to, on_update, on_delete }) => ({
      table,
      from,
      to,
      on_update,
      on_delete,
    })),
    indexes: await Promise.all(
      [...indexes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async ({ name, unique, origin, partial }) => ({
          name,
          unique,
          origin,
          partial,
          columns: ((await db.raw('PRAGMA index_info(??)', [name])) as { name: string }[]).map(
            (c) => c.name,
          ),
        })),
    ),
    autoincrement: /autoincrement/i.test(sql),
  }
}

let accountCount = 0
const account = (fields: Row = {}) => ({
  name: 'Everyday',
  akahu_id: `acc_fixture_${++accountCount}`,
  created_at: AT,
  updated_at: AT,
  ...fields,
})

async function insertAccount(fields: Row = {}): Promise<number> {
  const [id] = await db('accounts').insert(account(fields))
  return id
}

const budget = (fields: Row = {}) => ({
  scope: 'personal',
  category: 'Groceries',
  limit_cents: 15000,
  created_at: AT,
  updated_at: AT,
  ...fields,
})

const bill = (fields: Row = {}) => ({
  scope: 'personal',
  name: 'Power',
  amount_cents: 18450,
  repeat: 'monthly',
  first_due_date: '2026-10-31',
  created_at: AT,
  updated_at: AT,
  ...fields,
})

const payment = (fields: Row) => ({
  due_date: '2026-10-31',
  amount_cents: 18450,
  paid_at: AT,
  ...fields,
})

const goal = (fields: Row = {}) => ({
  name: 'Bike',
  target_cents: 120000,
  created_at: AT,
  updated_at: AT,
  ...fields,
})

const contribution = (fields: Row) => ({
  amount_cents: 5000,
  contributed_at: AT,
  ...fields,
})

let tablesBefore: string[]
let targetsBefore: Awaited<ReturnType<typeof targetsShape>>
let targetsSequenceBefore: number | undefined
let correctionsBefore: Row[]
let transactionsBefore: Row[]
let transactionsSequenceBefore: number | undefined

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, OURS)

  await db('users').insert({ id: 1, email: 'fixture@example.com', password: 'x' })
  await db('targets').insert({
    user_id: 1,
    category: 'Food',
    target_amount_cents: 50000,
    period: 'monthly',
  })
  const [transactionId] = await db('transactions').insert({
    akahu_id: 'trans_fixture_kept',
    account_id: 'acc_fixture_everyday',
    amount_cents: -450,
  })
  await db('category_corrections').insert({
    transaction_id: transactionId,
    from_category: null,
    to_category: 'Bakeries',
    corrected_at: AT,
    source: 'user',
  })

  tablesBefore = await tables()
  targetsBefore = await targetsShape()
  targetsSequenceBefore = await sequence('targets')
  correctionsBefore = await db('category_corrections').orderBy('id')
  transactionsBefore = await db('transactions').orderBy('id')
  transactionsSequenceBefore = await sequence('transactions')

  await db.migrate.latest()
})

afterEach(async () => {
  await db.destroy()
})

describe('schema (Done-when 1, 4)', () => {
  it('creates exactly the seven tables', async () => {
    expect(NEW_TABLES).toHaveLength(7)
    const expected = [...tablesBefore.filter((t) => t !== 'targets'), ...NEW_TABLES].sort()
    expect(await tables()).toEqual(expected)
  })

  it.each(TABLE_KEYS)("%s has exactly its row type's columns", async (table, keys) => {
    expect((await columns(table)).sort()).toEqual(Object.keys(keys).sort())
  })

  it('makes every *_cents column INTEGER, and no new column decimal, float, real or numeric', async () => {
    let cents = 0
    for (const table of NEW_TABLES) {
      for (const [name, type] of Object.entries(await columnTypes(table))) {
        expect(type, `${table}.${name}`).not.toMatch(/decimal|float|real|numeric|double/)
        if (name.endsWith('_cents')) {
          cents++
          expect(type, `${table}.${name}`).toBe('integer not null')
        }
      }
    }
    expect(cents).toBeGreaterThan(0)
  })

  it('gives goals no stored saved or balance column', async () => {
    expect((await columns('goals')).filter((c) => /saved|balance/.test(c))).toEqual([])
  })
})

describe('budgets (Rulings 6, 9)', () => {
  it('round-trips a budget', async () => {
    const full: Omit<Budget, 'id'> = {
      scope: 'strawb',
      category: 'Software',
      limit_cents: 4999,
      note: 'Weekly cap',
      created_at: AT,
      updated_at: LATER,
    }
    const [id] = await db('budgets').insert(full)

    const row = await db('budgets').where({ id }).first()
    expect(Object.keys(row).sort()).toEqual(Object.keys(BUDGET_KEYS).sort())
    expect(row).toStrictEqual({ id, ...full })
  })

  it('accepts personal and strawb scope, and refuses all, bogus, null or none', async () => {
    for (const scope of SCOPES) await db('budgets').insert(budget({ scope }))
    expect(await db('budgets').orderBy('id').pluck('scope')).toEqual(SCOPES)

    for (const scope of ['all', 'bogus']) {
      await expect(
        db('budgets').insert(budget({ scope, category: 'Other' })),
      ).rejects.toThrow(/CHECK constraint failed: scope/)
    }
    await expect(db('budgets').insert(budget({ scope: null }))).rejects.toThrow(
      /NOT NULL constraint failed: budgets.scope/,
    )
    await expect(db('budgets').insert(omit(budget(), 'scope'))).rejects.toThrow(
      /NOT NULL constraint failed: budgets.scope/,
    )
  })

  it('accepts a zero limit, and refuses a negative, fractional or missing one', async () => {
    await db('budgets').insert(budget({ limit_cents: 0 }))
    expect(await db('budgets').pluck('limit_cents')).toEqual([0])

    for (const limit_cents of [-1, 12.5]) {
      await expect(
        db('budgets').insert(budget({ category: 'Other', limit_cents })),
      ).rejects.toThrow(/CHECK constraint failed: budgets_limit_non_negative/)
    }
    await expect(
      db('budgets').insert(budget({ category: 'Other', limit_cents: null })),
    ).rejects.toThrow(/NOT NULL constraint failed: budgets.limit_cents/)
  })

  it('refuses a second budget for the same scope and category', async () => {
    await db('budgets').insert(budget())

    await expect(db('budgets').insert(budget({ limit_cents: 1 }))).rejects.toThrow(
      /UNIQUE constraint failed: budgets.scope, budgets.category/,
    )
  })

  it('allows the same category in the other scope', async () => {
    await db('budgets').insert(budget({ scope: 'personal' }))
    await db('budgets').insert(budget({ scope: 'strawb' }))

    expect(await count('budgets')).toBe(2)
  })

  it('requires a category and both timestamps', async () => {
    for (const column of ['category', 'created_at', 'updated_at']) {
      await expect(db('budgets').insert(budget({ [column]: null }))).rejects.toThrow(
        new RegExp(`NOT NULL constraint failed: budgets.${column}`),
      )
    }
  })
})

describe('bills (#35 option C)', () => {
  it('round-trips a bill for each repeat value', async () => {
    const accountId = await insertAccount()
    const rows: Omit<Bill, 'id'>[] = REPEATS.map((repeat, i) => ({
      scope: i % 2 ? 'strawb' : 'personal',
      name: `Bill ${repeat}`,
      amount_cents: 1000 + i,
      repeat: repeat as BillRepeat,
      first_due_date: '2026-01-31',
      account_id: i % 2 ? null : accountId,
      created_at: AT,
      updated_at: LATER,
    }))
    for (const row of rows) await db('bills').insert(row)

    const stored = await db('bills').orderBy('id')
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(BILL_KEYS).sort())
    }
    expect(stored).toStrictEqual(rows.map((row, i) => ({ id: stored[i].id, ...row })))
  })

  it('refuses daily, empty or null repeat, and a bill that does not say', async () => {
    for (const repeat of ['daily', '']) {
      await expect(db('bills').insert(bill({ repeat }))).rejects.toThrow(
        /CHECK constraint failed: repeat/,
      )
    }
    for (const row of [bill({ repeat: null }), omit(bill(), 'repeat')]) {
      await expect(db('bills').insert(row)).rejects.toThrow(
        /NOT NULL constraint failed: bills.repeat/,
      )
    }
    expect(await count('bills')).toBe(0)
  })

  it('refuses a zero, negative or fractional amount', async () => {
    for (const amount_cents of [0, -1, 12.5]) {
      await expect(db('bills').insert(bill({ amount_cents }))).rejects.toThrow(
        /CHECK constraint failed: bills_amount_positive/,
      )
    }
    await expect(db('bills').insert(bill({ amount_cents: null }))).rejects.toThrow(
      /NOT NULL constraint failed: bills.amount_cents/,
    )
  })

  it('refuses a scope other than personal or strawb', async () => {
    for (const scope of ['all', 'bogus']) {
      await expect(db('bills').insert(bill({ scope }))).rejects.toThrow(
        /CHECK constraint failed: scope/,
      )
    }
    await expect(db('bills').insert(omit(bill(), 'scope'))).rejects.toThrow(
      /NOT NULL constraint failed: bills.scope/,
    )
  })

  it('takes a real calendar date as first_due_date, and refuses anything else', async () => {
    for (const first_due_date of REAL_DATES) {
      await db('bills').insert(bill({ first_due_date }))
    }
    expect(await db('bills').orderBy('id').pluck('first_due_date')).toEqual(REAL_DATES)

    for (const first_due_date of NOT_DATES) {
      await expect(
        db('bills').insert(bill({ first_due_date })),
        String(first_due_date),
      ).rejects.toThrow(/CHECK constraint failed: bills_first_due_date_is_date/)
    }
    await expect(db('bills').insert(bill({ first_due_date: null }))).rejects.toThrow(
      /NOT NULL constraint failed: bills.first_due_date/,
    )
  })

  it('refuses an account that does not exist', async () => {
    const accountId = await insertAccount()

    await expect(
      db('bills').insert(bill({ account_id: accountId + 1 })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it("keeps a bill when its account is deleted, with no account", async () => {
    const accountId = await insertAccount()
    const [billId] = await db('bills').insert(bill({ account_id: accountId }))

    await db('accounts').where({ id: accountId }).del()

    expect(await db('bills').where({ id: billId }).first()).toMatchObject({
      id: billId,
      name: 'Power',
      account_id: null,
    })
  })
})

describe('bill_payments (#35 option C, Done-when 4)', () => {
  let billId: number
  let otherBillId: number

  beforeEach(async () => {
    ;[billId] = await db('bills').insert(bill())
    ;[otherBillId] = await db('bills').insert(bill({ name: 'Water' }))
  })

  it('records a payment for an occurrence', async () => {
    const full: Omit<BillPayment, 'id'> = {
      bill_id: billId,
      due_date: '2026-10-31',
      amount_cents: 18450,
      paid_at: LATER,
    }
    const [id] = await db('bill_payments').insert(full)

    const row = await db('bill_payments').where({ id }).first()
    expect(Object.keys(row).sort()).toEqual(Object.keys(BILL_PAYMENT_KEYS).sort())
    expect(row).toStrictEqual({ id, ...full })
  })

  it('refuses a second payment for the same bill and due date', async () => {
    await db('bill_payments').insert(payment({ bill_id: billId }))

    await expect(
      db('bill_payments').insert(payment({ bill_id: billId, paid_at: LATER })),
    ).rejects.toThrow(/UNIQUE constraint failed: bill_payments.bill_id, bill_payments.due_date/)
  })

  it('accepts the same due date on another bill, and the next cycle on the same bill', async () => {
    await db('bill_payments').insert([
      payment({ bill_id: billId }),
      payment({ bill_id: otherBillId }),
      payment({ bill_id: billId, due_date: '2026-11-30' }),
    ])

    expect(
      await db('bill_payments').orderBy('id').select('bill_id', 'due_date'),
    ).toEqual([
      { bill_id: billId, due_date: '2026-10-31' },
      { bill_id: otherBillId, due_date: '2026-10-31' },
      { bill_id: billId, due_date: '2026-11-30' },
    ])
  })

  it('makes the unique index (bill_id, due_date), in that order', async () => {
    const indexes: { name: string; unique: number }[] = await db.raw(
      'PRAGMA index_list(bill_payments)',
    )
    const unique = indexes.filter((i) => i.unique === 1)
    expect(unique.map((i) => i.name)).toEqual(['bill_payments_bill_id_due_date_unique'])

    const info: { seqno: number; name: string }[] = await db.raw(
      'PRAGMA index_info(bill_payments_bill_id_due_date_unique)',
    )
    expect(info.sort((a, b) => a.seqno - b.seqno).map((c) => c.name)).toEqual([
      'bill_id',
      'due_date',
    ])
  })

  it('refuses a payment for a bill that does not exist', async () => {
    await expect(
      db('bill_payments').insert(payment({ bill_id: otherBillId + 1 })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it("deletes a bill's payments with it, and only its own", async () => {
    await db('bill_payments').insert([
      payment({ bill_id: billId }),
      payment({ bill_id: otherBillId }),
    ])

    await db('bills').where({ id: billId }).del()

    expect(await db('bill_payments').pluck('bill_id')).toEqual([otherBillId])
  })

  it('refuses a non-positive or fractional amount, a date that is not real, and no paid_at', async () => {
    for (const amount_cents of [0, -1, 12.5]) {
      await expect(
        db('bill_payments').insert(payment({ bill_id: billId, amount_cents })),
      ).rejects.toThrow(/CHECK constraint failed: bill_payments_amount_positive/)
    }
    for (const due_date of NOT_DATES) {
      await expect(
        db('bill_payments').insert(payment({ bill_id: billId, due_date })),
        String(due_date),
      ).rejects.toThrow(/CHECK constraint failed: bill_payments_due_date_is_date/)
    }
    await expect(
      db('bill_payments').insert(payment({ bill_id: billId, paid_at: null })),
    ).rejects.toThrow(/NOT NULL constraint failed: bill_payments.paid_at/)
    expect(await count('bill_payments')).toBe(0)
  })
})

describe('goals and goal_contributions (Ruling 5, Done-when 4)', () => {
  it('round-trips a goal with and without a target date', async () => {
    const rows: Omit<Goal, 'id'>[] = [
      {
        name: 'Bike',
        target_cents: 120000,
        target_date: '2027-03-01',
        created_at: AT,
        updated_at: LATER,
      },
      {
        name: 'Rainy day',
        target_cents: 500000,
        target_date: null,
        created_at: AT,
        updated_at: AT,
      },
    ]
    for (const row of rows) await db('goals').insert(row)

    const stored = await db('goals').orderBy('id')
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(GOAL_KEYS).sort())
    }
    expect(stored).toStrictEqual(rows.map((row, i) => ({ id: stored[i].id, ...row })))
  })

  it('refuses a non-positive or fractional target, and a target date that is not real', async () => {
    for (const target_cents of [0, -1, 12.5]) {
      await expect(db('goals').insert(goal({ target_cents }))).rejects.toThrow(
        /CHECK constraint failed: goals_target_positive/,
      )
    }
    for (const target_date of NOT_DATES) {
      await expect(
        db('goals').insert(goal({ target_date })),
        String(target_date),
      ).rejects.toThrow(/CHECK constraint failed: goals_target_date_is_date/)
    }
    expect(await count('goals')).toBe(0)
  })

  it('records a contribution above zero, with a time, and refuses anything less', async () => {
    const [goalId] = await db('goals').insert(goal())
    const full: Omit<GoalContribution, 'id'> = {
      goal_id: goalId,
      amount_cents: 5000,
      contributed_at: LATER,
    }
    const [id] = await db('goal_contributions').insert(full)
    const row = await db('goal_contributions').where({ id }).first()
    expect(Object.keys(row).sort()).toEqual(Object.keys(GOAL_CONTRIBUTION_KEYS).sort())
    expect(row).toStrictEqual({ id, ...full })

    for (const amount_cents of [0, -1, 12.5]) {
      await expect(
        db('goal_contributions').insert(contribution({ goal_id: goalId, amount_cents })),
      ).rejects.toThrow(/CHECK constraint failed: goal_contributions_amount_positive/)
    }
    await expect(
      db('goal_contributions').insert(contribution({ goal_id: goalId, contributed_at: null })),
    ).rejects.toThrow(/NOT NULL constraint failed: goal_contributions.contributed_at/)
  })

  it('refuses a contribution to a goal that does not exist', async () => {
    const [goalId] = await db('goals').insert(goal())

    await expect(
      db('goal_contributions').insert(contribution({ goal_id: goalId + 1 })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('indexes goal_contributions on goal_id, for the saved-amount sum', async () => {
    const info: { name: string }[] = await db.raw(
      'PRAGMA index_info(goal_contributions_goal_id_index)',
    )
    expect(info.map((c) => c.name)).toEqual(['goal_id'])
  })

  it("deletes a goal's contributions with it, and only its own", async () => {
    const [bike] = await db('goals').insert(goal())
    const [rainy] = await db('goals').insert(goal({ name: 'Rainy day' }))
    await db('goal_contributions').insert([
      contribution({ goal_id: bike }),
      contribution({ goal_id: rainy }),
    ])

    await db('goals').where({ id: bike }).del()

    expect(await db('goal_contributions').pluck('goal_id')).toEqual([rainy])
  })

  it('derives saved as the sum of contributions, moving with no other write', async () => {
    const [goalId] = await db('goals').insert(goal())
    const goalRow = await db('goals').where({ id: goalId }).first()
    const saved = async () =>
      Number(
        (await db('goal_contributions').where({ goal_id: goalId }).sum('amount_cents as s').first())
          ?.s ?? 0,
      )

    await db('goal_contributions').insert(contribution({ goal_id: goalId, amount_cents: 5000 }))
    const [second] = await db('goal_contributions').insert(
      contribution({ goal_id: goalId, amount_cents: 20000 }),
    )
    expect(await saved()).toBe(25000)

    await db('goal_contributions').where({ id: second }).del()
    expect(await saved()).toBe(5000)

    expect(await db('goals').where({ id: goalId }).first()).toStrictEqual(goalRow)
  })
})

describe('account_settings (Rulings 2, 10, 11)', () => {
  const setting = (fields: Row) => ({ role: 'current', updated_at: AT, ...fields })

  it('accepts each of the four roles', async () => {
    for (const role of ROLES) {
      await db('account_settings').insert(setting({ account_id: await insertAccount(), role }))
    }

    const stored = await db('account_settings').orderBy('id')
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(ACCOUNT_SETTING_KEYS).sort())
    }
    expect(stored.map((r) => r.role)).toEqual(ROLES)
  })

  it('refuses a role spelt with a space, an unknown role, or none', async () => {
    const accountId = await insertAccount()

    for (const role of ['tax pot', 'credit card', 'bogus']) {
      await expect(
        db('account_settings').insert(setting({ account_id: accountId, role })),
      ).rejects.toThrow(/CHECK constraint failed: role/)
    }
    for (const row of [
      setting({ account_id: accountId, role: null }),
      omit(setting({ account_id: accountId }), 'role'),
    ]) {
      await expect(db('account_settings').insert(row)).rejects.toThrow(/NOT NULL constraint failed: account_settings.role/)
    }
  })

  it('refuses a second role row for an account, and an update changes the role', async () => {
    const accountId = await insertAccount()
    await db('account_settings').insert(setting({ account_id: accountId, role: 'current' }))

    await expect(
      db('account_settings').insert(setting({ account_id: accountId, role: 'savings' })),
    ).rejects.toThrow(/UNIQUE constraint failed: account_settings.account_id/)

    await db('account_settings')
      .where({ account_id: accountId })
      .update({ role: 'tax_pot', updated_at: LATER })
    expect(await db('account_settings').select('account_id', 'role', 'updated_at')).toEqual([
      { account_id: accountId, role: 'tax_pot', updated_at: LATER },
    ])
  })

  it('refuses a row with no account_id, even when account 1 exists (rowid trap)', async () => {
    // With PRIMARY KEY (account_id) the column would be a rowid alias, and
    // this insert would be handed account_id 1 silently.
    expect(await insertAccount()).toBe(1)

    await expect(db('account_settings').insert(setting({}))).rejects.toThrow(
      /NOT NULL constraint failed: account_settings.account_id/,
    )
    expect(await count('account_settings')).toBe(0)
  })

  it('refuses a role for an account that does not exist', async () => {
    const accountId = await insertAccount()

    await expect(
      db('account_settings').insert(setting({ account_id: accountId + 1 })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it("deletes an account's role row with it, and only its own", async () => {
    const gone = await insertAccount()
    const kept = await insertAccount()
    await db('account_settings').insert([
      setting({ account_id: gone }),
      setting({ account_id: kept, role: 'savings' }),
    ])

    await db('accounts').where({ id: gone }).del()

    expect(await db('account_settings').select('account_id', 'role')).toEqual([
      { account_id: kept, role: 'savings' },
    ])
  })

  it('allows a tax pot in each scope, and two in one scope (Ruling 11)', async () => {
    for (const scope of ['personal', 'strawb', 'personal']) {
      await db('account_settings').insert(
        setting({ account_id: await insertAccount({ scope }), role: 'tax_pot' }),
      )
    }

    expect(
      await db('account_settings')
        .join('accounts', 'accounts.id', 'account_settings.account_id')
        .where({ role: 'tax_pot' })
        .orderBy('account_settings.id')
        .pluck('accounts.scope'),
    ).toEqual(['personal', 'strawb', 'personal'])
  })
})

describe('alert_dismissals', () => {
  it('stores a dismissal', async () => {
    const full: AlertDismissal = { alert_id: 'bill_overdue:7:2026-10-31', dismissed_at: AT }
    await db('alert_dismissals').insert(full)

    const row = await db('alert_dismissals').first()
    expect(Object.keys(row).sort()).toEqual(Object.keys(ALERT_DISMISSAL_KEYS).sort())
    expect(row).toStrictEqual(full)
  })

  it('refuses a dismissal with no alert id', async () => {
    for (const row of [{ alert_id: null, dismissed_at: AT }, { dismissed_at: AT }]) {
      await expect(db('alert_dismissals').insert(row)).rejects.toThrow(/NOT NULL constraint failed: alert_dismissals.alert_id/)
    }
    expect(await count('alert_dismissals')).toBe(0)
  })

  it('refuses a duplicate, and an ignored conflict keeps the first dismissed_at', async () => {
    await db('alert_dismissals').insert({ alert_id: 'over_budget:3', dismissed_at: AT })

    await expect(
      db('alert_dismissals').insert({ alert_id: 'over_budget:3', dismissed_at: LATER }),
    ).rejects.toThrow(/UNIQUE constraint failed: alert_dismissals.alert_id/)

    await db('alert_dismissals')
      .insert({ alert_id: 'over_budget:3', dismissed_at: LATER })
      .onConflict('alert_id')
      .ignore()
    expect(await db('alert_dismissals').select()).toEqual([
      { alert_id: 'over_budget:3', dismissed_at: AT },
    ])
  })

  it('requires dismissed_at', async () => {
    await expect(
      db('alert_dismissals').insert({ alert_id: 'over_budget:3', dismissed_at: null }),
    ).rejects.toThrow(/NOT NULL constraint failed: alert_dismissals.dismissed_at/)
  })
})

describe('targets and rollback (Ruling 6, Done-when 2)', () => {
  it('drops targets, its unique index and its sequence row, and copies nothing into budgets', async () => {
    expect(targetsSequenceBefore).toBe(1)
    expect(targetsBefore.indexes.map((i) => i.name)).toEqual([
      'targets_user_id_category_period_unique',
    ])

    expect(
      await db('sqlite_master')
        .where({ tbl_name: 'targets' })
        .orWhere({ name: 'targets_user_id_category_period_unique' })
        .pluck('name'),
    ).toEqual([])
    expect(await sequence('targets')).toBeUndefined()
    expect(await count('budgets')).toBe(0)
  })

  it('leaves category corrections and transactions, and their sequence, untouched', async () => {
    expect(correctionsBefore).toHaveLength(1)

    expect(await db('category_corrections').orderBy('id')).toStrictEqual(correctionsBefore)
    expect(await db('transactions').orderBy('id')).toStrictEqual(transactionsBefore)
    expect(await sequence('transactions')).toBe(transactionsSequenceBefore)
  })

  it('rolls back with every new table populated, and restores targets exactly, empty and usable', async () => {
    const accountId = await insertAccount()
    await db('budgets').insert(budget())
    const [billId] = await db('bills').insert(bill({ account_id: accountId }))
    await db('bill_payments').insert(payment({ bill_id: billId }))
    const [goalId] = await db('goals').insert(goal())
    await db('goal_contributions').insert(contribution({ goal_id: goalId }))
    await db('account_settings').insert({ account_id: accountId, role: 'current', updated_at: AT })
    await db('alert_dismissals').insert({ alert_id: 'over_budget:1', dismissed_at: AT })
    for (const table of NEW_TABLES) expect(await count(table), table).toBe(1)

    while ((await applied()).includes(OURS)) await db.migrate.down()

    expect(
      await db('sqlite_master')
        .whereIn('tbl_name', NEW_TABLES)
        .orWhere('name', 'like', 'sqlite_autoindex_alert_dismissals%')
        .pluck('name'),
    ).toEqual([])
    expect(await db('sqlite_sequence').whereIn('name', NEW_TABLES).pluck('name')).toEqual([])
    expect(await tables()).toEqual(tablesBefore)

    expect(await targetsShape()).toStrictEqual(targetsBefore)
    expect(await count('targets')).toBe(0)
    await db('targets').insert({
      user_id: 1,
      category: 'Food',
      target_amount_cents: 435,
      period: 'monthly',
    })
    await expect(
      db('targets').insert({ user_id: 1, category: 'Food', target_amount_cents: 1, period: 'monthly' }),
    ).rejects.toThrow(/UNIQUE constraint failed: targets.user_id, targets.category, targets.period/)

    // money_as_cents' own down() still runs on the recreated table.
    while ((await applied()).includes(MONEY_AS_CENTS)) await db.migrate.down()
    const types = await columnTypes('targets')
    expect(types.target_amount).toBe('float not null')
    expect(Object.keys(types)).not.toContain('target_amount_cents')
    expect(await db('targets').pluck('target_amount')).toEqual([4.35])

    await db.migrate.latest()
    expect(await tables()).toEqual(
      [...tablesBefore.filter((t) => t !== 'targets'), ...NEW_TABLES].sort(),
    )
  })

  it('runs latest, a full rollback and latest again on a fresh in-memory database', async () => {
    const fresh = knex(config.test)
    try {
      await fresh.migrate.latest()
      await fresh.migrate.rollback(undefined, true)
      const [completed] = (await fresh.migrate.list()) as [unknown[], unknown]
      expect(completed).toEqual([])
      await fresh.migrate.latest()

      const names: string[] = await fresh('sqlite_master')
        .where({ type: 'table' })
        .pluck('name')
      expect(names).not.toContain('targets')
      for (const table of NEW_TABLES) expect(names).toContain(table)
    } finally {
      await fresh.destroy()
    }
  })
})

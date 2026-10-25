// prd-02 wave 1 (#39), Rulings 2, 5, 6, 9, 10 and 11, and #35 (bill
// recurrence, option C): the tables the budgets, bills, goals, settings and
// overview routes stand on. Creates `budgets`, `bills`, `bill_payments`,
// `goals`, `goal_contributions`, `account_settings` and `alert_dismissals`,
// and drops `targets` (Ruling 6: `budgets` replaces `targets`).
//
// `targets` rows are discarded, not copied into `budgets`: a target has no
// scope, belongs to a `user_id` Divvy no longer has, and nothing reads the
// table. Rolling back recreates `targets` empty, exactly as
// 20261023120000_money_as_cents.js left it, and deletes every row of the
// new tables.
//
// Conventions on every table here:
// - Money is integer cents (M1 #8). Every `*_cents` CHECK also asserts
//   `typeof(col) = 'integer'`: a column with INTEGER affinity stores 12.5 as
//   a REAL rather than refusing it.
// - `scope`, `repeat` and `role` have no default, so a writer has to say.
// - No `user_id`: Divvy has one user.
// - Calendar dates are `YYYY-MM-DD` text, checked with
//   `date(col, '+0 days') IS col`. `date(col) = col` is not enough: without a
//   modifier `date('2026-02-30')` comes back unchanged, and `=` against NULL
//   lets a CHECK pass. The modifier normalises an impossible day to a
//   different string, and `IS` treats NULL as a value, so a nullable date
//   column accepts NULL and nothing else that is not a real date.
// - Instants are ISO-8601 UTC strings ending in `Z`, written by the
//   application. There is no `CURRENT_TIMESTAMP` default: its format sorts
//   differently from the ISO strings beside it.
//
// budgets (Rulings 6, 9): one limit per category per scope. `limit_cents` is
// a weekly amount, because payday is weekly (Ruling 9).
//
// bills and bill_payments (#35 option C): a bill has a `repeat` of `none`
// (one-off), `weekly`, `monthly` or `yearly`, anchored on `first_due_date`.
// Every occurrence is computed from the anchor, never from the previous
// occurrence, so nothing drifts:
// - weekly: anchor + 7n days.
// - monthly: the anchor's day of month, clamped to the end of a shorter
//   month (the 31st falls on the 30th, 28th or 29th, and is the 31st again
//   the month after).
// - yearly: the anchor's month and day; 29 February falls on 28 February
//   in a year that is not a leap year.
// "Mark paid" writes a `bill_payments` row whose `due_date` is the
// occurrence it pays. A bill's current occurrence is the earliest one with
// no payment; a one-off is done once its single payment exists. That
// derivation belongs to the bills route (#44), not here. The database does
// not check that a payment's `due_date` lies on the bill's schedule (that
// would need a trigger); the route validates it. One payment per occurrence:
// UNIQUE (bill_id, due_date). Deleting a bill deletes its payments. A bill
// whose account is deleted keeps existing with no account.
//
// goals and goal_contributions (Ruling 5): a contribution is a record, not a
// transfer. A goal's saved amount is the SUM of its contributions; there is
// no stored saved or balance column to drift from them. Goals have no scope
// (the goal contract carries none). Deleting a goal deletes its
// contributions.
//
// account_settings (Rulings 2, 10, 11): a row is an account's role; no row
// means no role, and an account with no role is not liquid. The roles are
// exactly `AccountRole` in shared/contracts.ts. There is no uniqueness on
// role: each scope may have its own tax pot (Ruling 11), and the scope is
// the account's. The surrogate `id` is deliberate. With
// `PRIMARY KEY (account_id)` the column would be a rowid alias, and an
// insert that omitted it would be given the next rowid silently instead of
// being refused.
//
// alert_dismissals: an alert's stable id, dismissed once. A non-integer
// PRIMARY KEY in SQLite allows NULL unless the column says NOT NULL, so it
// does. Dismissing again is a no-op via `onConflict('alert_id').ignore()`.
//
// From here on, never rebuild `accounts`, `bills` or `goals` (knex
// `dropColumn`, `.alter()`, or anything that recreates the table): the
// rebuild runs inside the migration transaction, where PRAGMA foreign_keys =
// OFF is ignored, so it deletes every `account_settings`, `bill_payments` and
// `goal_contributions` row and clears every `bills.account_id`. See the
// hazard in 20261023120000_money_as_cents.js.

const SCOPES = ['personal', 'strawb']
const BILL_REPEATS = ['none', 'weekly', 'monthly', 'yearly']
const ACCOUNT_ROLES = ['current', 'savings', 'tax_pot', 'credit_card']

// A CHECK that `column` holds integer cents above zero (or at zero, when
// `inclusive`).
function centsCheck(table, column, name, { inclusive }) {
  table.check(
    `?? ${inclusive ? '>=' : '>'} 0 AND typeof(??) = 'integer'`,
    [column, column],
    name,
  )
}

function dateCheck(table, column, name) {
  table.check("date(??, '+0 days') IS ??", [column, column], name)
}

/**
 * Drops `targets` and its rows.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('budgets', (table) => {
    table.increments('id').primary()
    table.enu('scope', SCOPES).notNullable()
    table.string('category', 255).notNullable()
    table.integer('limit_cents').notNullable()
    table.text('note')
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()

    table.unique(['scope', 'category'])
    centsCheck(table, 'limit_cents', 'budgets_limit_non_negative', {
      inclusive: true,
    })
  })

  await knex.schema.createTable('bills', (table) => {
    table.increments('id').primary()
    table.enu('scope', SCOPES).notNullable()
    table.string('name', 255).notNullable()
    table.integer('amount_cents').notNullable()
    table.enu('repeat', BILL_REPEATS).notNullable()
    table.text('first_due_date').notNullable()
    table
      .integer('account_id')
      .references('id')
      .inTable('accounts')
      .onDelete('SET NULL')
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()

    centsCheck(table, 'amount_cents', 'bills_amount_positive', {
      inclusive: false,
    })
    dateCheck(table, 'first_due_date', 'bills_first_due_date_is_date')
  })

  await knex.schema.createTable('bill_payments', (table) => {
    table.increments('id').primary()
    table
      .integer('bill_id')
      .notNullable()
      .references('id')
      .inTable('bills')
      .onDelete('CASCADE')
    // The occurrence this payment pays.
    table.text('due_date').notNullable()
    // What was paid, as a snapshot: editing the bill later does not change it.
    table.integer('amount_cents').notNullable()
    table.timestamp('paid_at').notNullable()

    table.unique(['bill_id', 'due_date'])
    centsCheck(table, 'amount_cents', 'bill_payments_amount_positive', {
      inclusive: false,
    })
    dateCheck(table, 'due_date', 'bill_payments_due_date_is_date')
  })

  await knex.schema.createTable('goals', (table) => {
    table.increments('id').primary()
    table.string('name', 255).notNullable()
    table.integer('target_cents').notNullable()
    table.text('target_date')
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()

    centsCheck(table, 'target_cents', 'goals_target_positive', {
      inclusive: false,
    })
    dateCheck(table, 'target_date', 'goals_target_date_is_date')
  })

  await knex.schema.createTable('goal_contributions', (table) => {
    table.increments('id').primary()
    table
      .integer('goal_id')
      .notNullable()
      .references('id')
      .inTable('goals')
      .onDelete('CASCADE')
    table.integer('amount_cents').notNullable()
    table.timestamp('contributed_at').notNullable()

    table.index(['goal_id'])
    centsCheck(table, 'amount_cents', 'goal_contributions_amount_positive', {
      inclusive: false,
    })
  })

  await knex.schema.createTable('account_settings', (table) => {
    table.increments('id').primary()
    table
      .integer('account_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE')
    table.enu('role', ACCOUNT_ROLES).notNullable()
    table.timestamp('updated_at').notNullable()
  })

  await knex.schema.createTable('alert_dismissals', (table) => {
    table.string('alert_id', 255).notNullable().primary()
    table.timestamp('dismissed_at').notNullable()
  })

  await knex.schema.dropTable('targets')
}

/**
 * Deletes every row of the new tables, and recreates `targets` empty.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  for (const name of [
    'goal_contributions',
    'goals',
    'bill_payments',
    'bills',
    'account_settings',
    'alert_dismissals',
    'budgets',
  ]) {
    await knex.schema.dropTable(name)
  }

  // `targets` as 20250619122142_targets.js created it and
  // 20261023120000_money_as_cents.js left it: same columns in the same
  // order, so that migration's own down() still runs after this one.
  await knex.schema.createTable('targets', (table) => {
    table.increments('id').primary()
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE')
    table.string('category', 255).notNullable()
    table.string('period', 50).notNullable()
    table.timestamp('created_at').defaultTo(knex.fn.now())
    table.timestamp('updated_at').defaultTo(knex.fn.now())
    table.integer('target_amount_cents').notNullable()
    table.unique(['user_id', 'category', 'period'])
  })
}

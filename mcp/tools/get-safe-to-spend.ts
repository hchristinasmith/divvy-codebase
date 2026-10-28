// `get_safe_to_spend` (prd-03 Ruling 1; Done when 1; prd-02 Ruling 1): how
// much can be spent today in a scope, the number the Overview shows.
//
// This handler does no arithmetic and no gathering. It loads the rows the
// Overview's `loadInputs` loads (server/db/overview.ts, with `listAccounts`
// from server/db/synced.ts and `loadDrawingCandidates` from
// server/db/drawings.ts), as the same queries written against the replica,
// hands them to `gatherSafeToSpendInputs` (shared/safe-to-spend-inputs.ts)
// and the gathered inputs to `safeToSpend` (shared/safe-to-spend.ts). Those
// two are the only place the figures come from, so the advisor's number
// cannot diverge from the Overview's. `mcp/` imports `shared/`, never
// `server/` (prd-03 Ruling 6), so the queries are restated here; change them
// with the server's.
//
// `now` is the call's clock: the Overview computes with the current time, so
// the answer is the Overview's number at the moment of the call, over the
// replica's copy of the data (`data_as_of`).
//
// The result is `safeToSpend`'s result field by field, renamed to the
// advisor's snake_case (money fields end `_cents`, so the dispatcher's
// integer check sees every one), plus `data_as_of`. Each field is picked by
// name, never spread, so a field `safeToSpend` gains does not reach the
// advisor unreviewed. A failure (a bad stored setting, an account with no
// balance, an unreadable replica) is thrown, never returned as text; the
// dispatcher answers it `internal_error`.

import { z } from 'zod'
import type { BudgetLine, SafeToSpendResult } from '../../shared/contracts.ts'
import { safeToSpend } from '../../shared/safe-to-spend.ts'
import {
  SAFE_TO_SPEND_SETTING_KEYS,
  gatherSafeToSpendInputs,
  safeToSpendWindowStart,
  type DrawingCandidateRow,
  type InputAccountRoleRow,
  type InputAccountRow,
  type InputBillPaymentRow,
  type InputBillRow,
  type InputBudgetRow,
  type InputTransactionRow,
} from '../../shared/safe-to-spend-inputs.ts'
import { READ_ONLY_ANNOTATIONS, staticSql } from '../contracts.ts'
import type { Cents, HandlerOutcome, SqlValue, ToolResult } from '../contracts.ts'
import { defineTool, scopeSchema } from './common.ts'

const NAME = 'get_safe_to_spend'

// Row bounds. The reader rejects, never truncates, a result above its
// `maxRows`, so a bound here refuses the call rather than changing the
// number. Tables that grow only with what Hannah sets up are bounded;
// tables that grow with time are read whole, as the Overview reads them.

/** Linked bank accounts; `account_settings.account_id` is UNIQUE, so the same bound holds its rows. */
const MAX_ACCOUNTS = 1_000
/** Bills and budgets are entered by hand. */
const MAX_BILLS = 10_000
const MAX_BUDGETS = 10_000
/**
 * `bill_payments` (one row per paid occurrence, all time), the window (every
 * undated row as well as the dated ones) and the drawing candidates (all
 * time) grow with time, and the Overview reads every row of each.
 */
const UNBOUNDED = Number.MAX_SAFE_INTEGER

/**
 * A row type the reader accepts: the shared row interfaces, as an object
 * type with an index signature. The replica is the scrubbed copy of the
 * live tables, so its values are trusted as the server's knex reads trust
 * them; the gathering checks what it checks (settings, balances, dates).
 */
type ReplicaRow<T> = { [K in keyof T]: T[K] }

/** A budget line, as the advisor sees it. */
interface SafeToSpendBudgetLine {
  readonly id: string
  readonly scope: BudgetLine['scope']
  readonly category: string
  readonly limit_cents: Cents
  readonly spent_cents: Cents
  readonly remaining_cents: Cents
  readonly over_cents: Cents
}

/** The result, without the `data_as_of` every result carries. */
interface SafeToSpendToolResult {
  readonly scope: SafeToSpendResult['scope']
  readonly today: string
  readonly last_payday: string
  readonly next_payday: string
  readonly liquid_cents: Cents
  readonly unpaid_bills_cents: Cents
  readonly remaining_budget_cents: Cents
  readonly strawb_tax_owed_cents: Cents
  readonly strawb_tax_pot_cents: Cents
  readonly strawb_bills_buffer_cents: Cents
  readonly strawb_tax_hold_cents: Cents
  readonly personal_tax_owed_cents: Cents
  readonly personal_tax_pot_cents: Cents
  readonly personal_tax_hold_cents: Cents
  readonly tax_hold_cents: Cents
  readonly card_debt_cents: Cents
  readonly safe_cents: Cents
  readonly short_by_cents: Cents
  readonly days_to_payday: number
  readonly per_day_cents: Cents
  readonly budgets: readonly SafeToSpendBudgetLine[]
}

function budgetLine(line: BudgetLine): SafeToSpendBudgetLine {
  return {
    id: line.id,
    scope: line.scope,
    category: line.category,
    limit_cents: line.limitCents,
    spent_cents: line.spentCents,
    remaining_cents: line.remainingCents,
    over_cents: line.overCents,
  }
}

function renamed(r: SafeToSpendResult): SafeToSpendToolResult {
  return {
    scope: r.scope,
    today: r.today,
    last_payday: r.lastPayday,
    next_payday: r.nextPayday,
    liquid_cents: r.liquidCents,
    unpaid_bills_cents: r.unpaidBillsCents,
    remaining_budget_cents: r.remainingBudgetCents,
    strawb_tax_owed_cents: r.strawbTaxOwedCents,
    strawb_tax_pot_cents: r.strawbTaxPotCents,
    strawb_bills_buffer_cents: r.strawbBillsBufferCents,
    strawb_tax_hold_cents: r.strawbTaxHoldCents,
    personal_tax_owed_cents: r.personalTaxOwedCents,
    personal_tax_pot_cents: r.personalTaxPotCents,
    personal_tax_hold_cents: r.personalTaxHoldCents,
    tax_hold_cents: r.taxHoldCents,
    card_debt_cents: r.cardDebtCents,
    safe_cents: r.safeCents,
    short_by_cents: r.shortByCents,
    days_to_payday: r.daysToPayday,
    per_day_cents: r.perDayCents,
    budgets: r.budgets.map(budgetLine),
  }
}

export const getSafeToSpend = defineTool({
  name: NAME,
  title: 'Safe to spend',
  description:
    'How much can be spent today in a scope, in integer cents, as the Divvy Overview shows it. Read-only.',
  inputSchema: z.strictObject({ scope: scopeSchema }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler({ scope }, ctx): Promise<HandlerOutcome> {
    const meta = await ctx.replica.meta()
    const now = ctx.clock.now()

    // The window's start depends on the payday setting, so the settings load
    // and are checked first, as the Overview's do. The replica keeps only
    // `key` and `value`; `key` is UNIQUE (migration 20261025150000, #46), so
    // a key has at most one row and `ORDER BY key` is the whole ordering the
    // Overview's `updated_at`/`id` tiebreak would ever apply.
    const settings = await ctx.replica.select<{ key: string; value: SqlValue }>({
      sql: staticSql`SELECT key, value FROM settings WHERE key IN (SELECT value FROM json_each(?)) ORDER BY key`,
      params: [JSON.stringify(SAFE_TO_SPEND_SETTING_KEYS)],
      maxRows: SAFE_TO_SPEND_SETTING_KEYS.length,
    })
    const windowStart = safeToSpendWindowStart(settings, now)

    const accounts = await ctx.replica.select<ReplicaRow<InputAccountRow>>({
      sql: staticSql`SELECT id, akahu_id, name, scope, balance_cents FROM accounts WHERE source = 'akahu' ORDER BY id`,
      maxRows: MAX_ACCOUNTS,
    })
    const accountRoles = await ctx.replica.select<ReplicaRow<InputAccountRoleRow>>({
      sql: staticSql`SELECT account_id, role FROM account_settings`,
      maxRows: MAX_ACCOUNTS,
    })
    const bills = await ctx.replica.select<ReplicaRow<InputBillRow>>({
      sql: staticSql`SELECT id, scope, name, amount_cents, repeat, first_due_date FROM bills ORDER BY id`,
      maxRows: MAX_BILLS,
    })
    const billPayments = await ctx.replica.select<ReplicaRow<InputBillPaymentRow>>({
      sql: staticSql`SELECT bill_id, due_date FROM bill_payments`,
      maxRows: UNBOUNDED,
    })
    const budgets = await ctx.replica.select<ReplicaRow<InputBudgetRow>>({
      sql: staticSql`SELECT id, scope, category, limit_cents FROM budgets ORDER BY id`,
      maxRows: MAX_BUDGETS,
    })
    // The window: Akahu rows from `windowStart`, and every row with no date.
    const windowTransactions = await ctx.replica.select<ReplicaRow<InputTransactionRow>>({
      sql: staticSql`SELECT id, account_id, date, amount_cents, category, category_source, status FROM transactions WHERE source = 'akahu' AND (date >= ? OR date IS NULL)`,
      params: [windowStart],
      maxRows: UNBOUNDED,
    })
    // A Strawb outflow or a personal inflow, dated, on a stored Akahu
    // account: a row that could be a half of a drawing (prd-02 Ruling 15).
    const drawingCandidates = await ctx.replica.select<ReplicaRow<DrawingCandidateRow>>({
      sql: staticSql`SELECT t.id AS id, a.scope AS scope, t.date AS date, t.amount_cents AS amount_cents FROM transactions AS t JOIN accounts AS a ON a.akahu_id = t.account_id WHERE t.source = 'akahu' AND a.source = 'akahu' AND t.date IS NOT NULL AND ((a.scope = 'strawb' AND t.amount_cents < 0) OR (a.scope = 'personal' AND t.amount_cents > 0))`,
      maxRows: UNBOUNDED,
    })

    const inputs = gatherSafeToSpendInputs(
      { accounts, accountRoles, settings, bills, billPayments, budgets, windowTransactions, drawingCandidates },
      now,
    )
    const computed = safeToSpend({
      scope,
      today: inputs.today,
      paydayWeekday: inputs.paydayWeekday,
      taxRateBasisPoints: inputs.taxRateBasisPoints,
      profitCents: inputs.profitCents,
      personalTaxOwedCents: inputs.personalTaxOwedCents,
      accounts: inputs.accounts,
      bills: inputs.bills,
      budgets: inputs.budgets,
      transactions: inputs.transactions,
    })

    const rowCount =
      settings.length +
      accounts.length +
      accountRoles.length +
      bills.length +
      billPayments.length +
      budgets.length +
      windowTransactions.length +
      drawingCandidates.length
    const result: ToolResult<SafeToSpendToolResult> = { ...renamed(computed), data_as_of: meta.data_as_of }
    return { ok: true, rowCount, result }
  },
})

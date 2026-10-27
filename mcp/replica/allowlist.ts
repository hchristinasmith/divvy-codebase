// What the scrubbed replica may hold (prd-03 Ruling 2). Default-deny: the
// replica is built table by table and column by column from this list, so a
// table or column that is not named here never reaches it, whatever the live
// database grows. Adding an entry is a security-review change, not a
// convenience; each one below names the tool that needs it.
//
// Deliberately absent, and pinned absent by `__tests__/scrub.test.ts`:
//   - every `xero_*` table, including `xero_connection` (encrypted tokens) and
//     `xero_pay_runs` (payroll) (prd-05, prd-03 Territory);
//   - `transactions.reference`, `particulars`, `code`, `card_suffix`,
//     `other_account`, `akahu_category_*`, `merchant_nzbn` and the other
//     Akahu meta (Ruling 2: only the transaction fields it names);
//   - `accounts.formatted_account` unmasked, `authorisation_id`,
//     `credentials_id`, `connection_id` (bank-link ids, #132);
//   - `sync_runs.error_message` (sync error text can carry bank responses);
//   - `category_proposals`, `insights`, `agent_runs`, `category_corrections`
//     (no prd-03 tool reads them; their text is merchant-derived);
//   - `users`, `settings` rows outside `SETTING_KEYS`, and every other table.
//
// mcp/ may import shared/ (Ruling 6); `SETTING_KEYS` is the same list the
// server's safe-to-spend reads, so the replica's settings cannot drift from it.

import { SETTING_KEYS } from '../../shared/contracts.ts'

/** A column copied in masked form: only the last four digits of `lastFourOf`. */
export interface MaskedColumn {
  readonly name: string
  readonly lastFourOf: string
}

/** A column copied as is (same name), or masked under a new name. */
export type AllowedColumn = string | MaskedColumn

export interface AllowedTable {
  readonly columns: readonly AllowedColumn[]
  /** Copy only the rows whose `column` is one of `in`; every other row is dropped. */
  readonly onlyRowsWhere?: { readonly column: string; readonly in: readonly string[] }
}

export const ALLOWLIST: Readonly<Record<string, AllowedTable>> = {
  // get_safe_to_spend, get_habits: balance, scope and role per account;
  // list_transactions: the account name. `akahu_id` is the join key, because
  // `transactions.account_id` holds the Akahu account id, not `accounts.id`;
  // `source` is the `source = 'akahu'` filter the server's reads apply.
  // `formatted_account` arrives only as `account_last4`.
  accounts: {
    columns: ['id', 'akahu_id', 'source', 'scope', 'name', 'balance_cents', { name: 'account_last4', lastFourOf: 'formatted_account' }],
  },
  // get_safe_to_spend, get_habits: the account role.
  account_settings: { columns: ['account_id', 'role'] },
  // get_safe_to_spend, get_bills.
  bills: { columns: ['id', 'scope', 'name', 'amount_cents', 'repeat', 'first_due_date'] },
  // get_safe_to_spend, get_bills: which occurrences are paid.
  bill_payments: { columns: ['bill_id', 'due_date'] },
  // get_safe_to_spend, get_budgets. `note` (free text) stays out.
  budgets: { columns: ['id', 'scope', 'category', 'limit_cents'] },
  // get_goals.
  goals: { columns: ['id', 'name', 'target_cents', 'target_date'] },
  goal_contributions: { columns: ['goal_id', 'amount_cents'] },
  // get_habits: Hannah's worth-it verdicts.
  habit_verdicts: { columns: ['transaction_id', 'verdict'] },
  // get_safe_to_spend: tax rate, profit, payday, tax owed, currency. Only
  // those rows; never the whole table.
  settings: {
    columns: ['key', 'value'],
    onlyRowsWhere: { column: 'key', in: Object.values(SETTING_KEYS) },
  },
  // get_sync_status: when, and how it ended; never `error_message`.
  sync_runs: { columns: ['started_at', 'finished_at', 'outcome'] },
  // Ruling 2's list: date, description, amount, merchant name, effective
  // category and its source, status; the account name comes through
  // `account_id` (the join key to `accounts.akahu_id`). `id` keys the habit
  // verdicts and the drawing overlay; `source` is the `source = 'akahu'`
  // filter safe-to-spend applies.
  transactions: {
    columns: [
      'id',
      'account_id',
      'source',
      'date',
      'description',
      'amount_cents',
      'merchant_name',
      'category',
      'category_source',
      'status',
    ],
  },
}

/** The replica's own freshness table (Ruling 2); written by the scrub, not copied. */
export const REPLICA_META_TABLE = 'replica_meta'

export function columnName(column: AllowedColumn): string {
  return typeof column === 'string' ? column : column.name
}

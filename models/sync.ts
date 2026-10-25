// Row types for the prd-01 sync schema (#19): `accounts`, `sync_runs` and
// `category_corrections`, plus the domains `transactions` gained beside
// them. Each interface has one field per column of its table; the migrations
// in server/db/migrations/20261024100001…100004 are the source of truth and
// server/db/__tests__/prd01-schema.test.ts pins the two together.
//
// Money is integer cents (M1 #8). Instants are `IsoTimestamp`.
import type { CategorySource } from './transactions.ts'

// An ISO-8601 UTC instant ending in `Z`, e.g. "2026-10-25T03:00:00.000Z",
// written by the application. No column defaults to SQLite's
// CURRENT_TIMESTAMP: its "YYYY-MM-DD HH:MM:SS" form sorts differently from
// these strings when the two sit in one column.
export type IsoTimestamp = string

// Whose money an account holds (prd-01 Ruling 8).
export type AccountScope = 'personal' | 'strawb'

// Where a row came from (prd-01 Ruling 9). Shared by `accounts.source` and
// `transactions.source`.
export type DataSource = 'akahu' | 'xero'

// `transactions.status` (prd-01 Ruling 1). The column defaults to
// 'settled', so sync must set 'pending' explicitly on every pending insert;
// one that forgets becomes a permanent settled row.
export type TransactionStatus = 'settled' | 'pending'

export type SyncOutcome = 'running' | 'success' | 'failed'

// Who corrected a category. Akahu's own category is never a correction.
export type CorrectionSource = Exclude<CategorySource, 'akahu'>

// A row of `accounts`. `scope` and `source` are set by Hannah and never
// inferred: the account upsert in sync must not write either of them.
// `transactions.account_id` joins to `akahu_id` (no foreign key).
export interface Account {
  id: number
  // Akahu's account `_id`; null only for a non-Akahu account.
  akahu_id: string | null
  source: DataSource
  scope: AccountScope
  name: string
  formatted_account: string | null
  // Akahu's open enums, stored as received.
  type: string | null
  status: string | null
  // Akahu's `attributes` array as JSON text, e.g. '["TRANSACTIONS"]'.
  attributes: string
  connection_id: string | null
  connection_name: string | null
  connection_type: string | null
  connection_logo: string | null
  // Akahu's `_authorisation`, and the deprecated `_credentials`.
  authorisation_id: string | null
  credentials_id: string | null
  currency: string | null
  // `balance.current`, `balance.available` and `balance.limit`, in cents.
  balance_cents: number | null
  available_balance_cents: number | null
  credit_limit_cents: number | null
  refreshed_balance_at: IsoTimestamp | null
  refreshed_meta_at: IsoTimestamp | null
  refreshed_transactions_at: IsoTimestamp | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

// A row of `sync_runs`. Only one row may be 'running' at a time, so every
// run, at claim time, closes a 'running' row older than STALE_RUN_AFTER_MS
// (left by a crash) as 'failed', with `finished_at` and a fixed error
// message, before starting its own. A younger 'running' row makes the run
// skip. `error_message` must never contain a token.
export interface SyncRun {
  id: number
  started_at: IsoTimestamp
  // Null exactly while `outcome` is 'running'.
  finished_at: IsoTimestamp | null
  outcome: SyncOutcome
  inserted_count: number
  updated_count: number
  pending_mirrored_count: number
  // Required when `outcome` is 'failed'.
  error_message: string | null
}

// A row of `category_corrections`. Deleting the transaction deletes its
// corrections (ON DELETE CASCADE).
export interface CategoryCorrection {
  id: number
  transaction_id: number
  // The effective category before the change; null when there was none.
  from_category: string | null
  to_category: string
  corrected_at: IsoTimestamp
  source: CorrectionSource
}

import type { DataSource, TransactionStatus } from './sync.ts'

// Who set a transaction's effective category (prd-01 Ruling 4). Sync may
// change `category` only while this is 'akahu'; nothing overwrites 'user'.
export type CategorySource = 'akahu' | 'user' | 'rule' | 'claude'

// A row of the `transactions` table as the server returns it. Every money
// field is integer cents (M1 #8); format with `formatCents` from
// `shared/money.ts`, never by dividing here.
export interface Transaction {
  id: string
  account_id: string
  user_id: string
  connection_id: string
  created_at: string // or Date
  updated_at: string
  date: string

  description: string
  amount_cents: number
  balance_cents: number | null
  type: string
  hash: string

  // Akahu's category, as received. Only sync writes these.
  category_id: string
  category_name: string
  category_group_id: string
  category_group_name: string

  // Embedded meta
  particulars: string
  code: string
  reference: string
  other_account: string
  logo: string
  conversion_amount_cents: number | null
  conversion_currency: number
  conversion_rate: number
  card_suffix: string

  // Embedded merchant
  merchant_id: string
  merchant_name: string
  merchant_website: string
  merchant_logo: string

  // Effective category: an NZFCC category name from data/cats.js, or Drawings
  // (prd-02 Ruling 15), or null when Akahu sent none and nobody has set one.
  category: string | null
  category_source: CategorySource

  // prd-01 wave 1 (#19). The server returns every column, so these are
  // present on rows it sends; they are optional only so existing code that
  // builds a Transaction by hand keeps compiling. A pending row has null
  // `akahu_id` and `hash`.
  status?: TransactionStatus
  source?: DataSource

  // Akahu's category as received (prd-01 Ruling 4), copied from the legacy
  // category_* fields above. Only sync writes these.
  akahu_category_id?: string | null
  akahu_category_name?: string | null
  akahu_category_group_id?: string | null
  akahu_category_group_name?: string | null
}

// A `transactions` row as GET and PATCH /api/v1/transactions (#212) and the
// agent accept route (#297) answer it. It is read through
// TRANSACTION_ROW_COLUMNS below, so a column added to the table stays out of
// these responses until it is named there.
//
// Deliberately absent: the legacy category_* and Akahu's akahu_category_*,
// because the response carries the effective `category` and its
// `category_source` (prd-01 Ruling 4); conversion_*, which the Dashboard's
// envelope does not carry; and source, posted_date and merchant_nzbn.
//
// Nullability follows the migrations, not the Transaction interface above:
// every column the original table created is nullable, and a pending row
// (prd-01 Ruling 1) has NULL `akahu_id`, `hash`, `created_at`, `balance_cents`
// and `category`.
export interface TransactionRow {
  id: number
  akahu_id: string | null
  account_id: string | null
  user_id: string | null
  connection_id: string | null
  created_at: string | null
  updated_at: string | null
  date: string | null
  description: string | null
  amount_cents: number | null
  balance_cents: number | null
  type: string | null
  hash: string | null
  particulars: string | null
  code: string | null
  reference: string | null
  other_account: string | null
  logo: string | null
  card_suffix: string | null
  merchant_id: string | null
  merchant_name: string | null
  merchant_website: string | null
  merchant_logo: string | null
  category: string | null
  category_source: CategorySource
  status: TransactionStatus
}

// The select list for a TransactionRow, in the interface's order. Every reader
// of `transactions` that returns a whole row selects these (server/db/synced.ts,
// server/db/transactions.ts), so there is one list to keep in step with the
// interface. `satisfies` refuses a name the interface lacks; a name the
// interface has and the list lacks is caught by the literal key-set pins in
// the tests.
//
// It sits in models/, beside the interface it is typed against, because
// mcp/ may import models/ but never server/**.
export const TRANSACTION_ROW_COLUMNS = [
  'id',
  'akahu_id',
  'account_id',
  'user_id',
  'connection_id',
  'created_at',
  'updated_at',
  'date',
  'description',
  'amount_cents',
  'balance_cents',
  'type',
  'hash',
  'particulars',
  'code',
  'reference',
  'other_account',
  'logo',
  'card_suffix',
  'merchant_id',
  'merchant_name',
  'merchant_website',
  'merchant_logo',
  'category',
  'category_source',
  'status',
] as const satisfies readonly (keyof TransactionRow)[]

// Body of PATCH /api/v1/transactions/:id, the one category-edit route.
// Sets the effective category with category_source 'user'; Akahu's
// category_* fields are never written by it.
export interface UpdateTransactionCategory {
  category: string
}

export interface UpdateTransactionCategoryResponse {
  transaction: TransactionRow
}

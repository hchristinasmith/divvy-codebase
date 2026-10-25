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

// Body of PATCH /api/v1/transactions/:id, the one category-edit route.
// Sets the effective category with category_source 'user'; Akahu's
// category_* fields are never written by it.
export interface UpdateTransactionCategory {
  category: string
}

export interface UpdateTransactionCategoryResponse {
  transaction: Transaction
}

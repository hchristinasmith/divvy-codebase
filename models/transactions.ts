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

  // Embedded category
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
}

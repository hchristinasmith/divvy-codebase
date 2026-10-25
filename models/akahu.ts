export interface Accounts {
    success: boolean
    items: Item[]
  }
  
  export interface Item {
    _id: string
    _authorisation: string
    _credentials: string
    connection: Connection
    name: string
    formatted_account?: string
    status: string
    type: string
    attributes: string[]
    balance: Balance
    meta: Meta
    refreshed: Refreshed
  }
  
  export interface Balance {
    currency: string
    current: number
    overdrawn: boolean
  }
  
  export interface Connection {
    name: string
    logo: string
    _id: string
  }
  
  export interface Meta {
    holder: string
    breakdown?: Breakdown
  }
  
  export interface Breakdown {
    fees: number
    employer_contributions: number
    member_tax_credit: number
    personal_contributions: number
    previous_balance: number
    returns: number
    tax: number
    withdrawals: number
  }
  
  export interface Refreshed {
    balance: Date
    meta: Date
  }
  
  
/**
 * A transaction as Akahu's API returns it (`/transactions`). Money here is
 * float dollars, exactly as received. The seed turns it into integer cents
 * with `dollarsToCents`. The sync never uses this shape:
 * `server/sync/akahu-client.ts` reads Akahu's amounts as exact text, converts
 * them with `parseDollars` and returns its own cents types
 * (`server/sync/types.ts`, prd-01 Ruling 3).
 * The Dashboard still renders this shape, in dollars, from the live proxy
 * (`server/routes/akahu.ts`).
 */
export interface AkahuTransaction {
  _id: string
  _account: string
  _user?: string
  _connection: string
  created_at: string
  updated_at: string
  date: string
  description: string
  amount: number
  balance?: number
  type: string
  hash?: string
  category?: AkahuCategory
  merchant?: AkahuMerchant
  meta?: AkahuTransactionMeta
}

export interface AkahuCategory {
  _id: string
  name: string
  groups?: {
    personal_finance?: { _id: string; name: string }
  }
}

export interface AkahuMerchant {
  _id: string
  name: string
  website?: string
  logo?: string
}

export interface AkahuTransactionMeta {
  particulars?: string
  code?: string
  reference?: string
  other_account?: string
  logo?: string
  card_suffix?: string
}

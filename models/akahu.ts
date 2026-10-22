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
  
  
// A transaction as Akahu's /transactions endpoints return it, which the
// server proxies to the client unchanged. Distinct from `Transaction` in
// ./transactions.ts, which is the flattened row shape of the local table.
export interface AkahuTransaction {
  _id: string
  _account: string
  date: string
  description: string
  amount: number
  type: string
  category?: AkahuCategory
}

export interface AkahuCategory {
  _id: string
  name: string
  groups?: {
    personal_finance?: { _id: string; name: string }
  }
}

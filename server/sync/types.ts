// What the Akahu client hands to sync (prd-01, issue #20).
//
// These are the client's output shapes, not database rows: the rows and
// their migrations belong to `models/sync.ts` (#19). Every field is flat and
// snake_case, every amount is integer cents in a `*_cents` field (prd-01
// Ruling 3), and every text field is verbatim what Akahu sent. A field Akahu
// may omit is `null` here, never `undefined`, so a consumer cannot mistake a
// missing key for a missing value.
//
// A foreign-currency conversion's `rate` (issue #155) is a number that is
// not money, so it is not cents either. It stays the exact decimal text
// Akahu sent, because this client converts no number by float; sync turns
// it into a number.
//
// Only Akahu's own category is carried (`akahu_category`); the user's
// category is Divvy's and sync never writes it (prd-01 Ruling 4). Of
// Akahu's internal bookkeeping fields, only `_user` and `_migrated*` are
// dropped at the boundary; an account's `_authorisation` and `_credentials`
// ids are carried (issue #155).
//
// Settled and pending transactions are separate types with a literal
// `status`, so one cannot be passed where the other is required. A pending
// item has no `id`: it has no stable identity until it settles, and sync
// replaces the pending mirror rather than keying it (prd-01 Ruling 1).

/** One account from `GET /v1/accounts`. */
export interface AkahuAccount {
  id: string
  name: string
  /** Akahu's account type as sent, e.g. `CHECKING`, `SAVINGS`, `CREDITCARD`. */
  type: string
  status: string
  connection_id: string
  /** The bank's name as Akahu labels the connection. */
  connection_name: string
  /** Akahu's connection type as sent, e.g. `classic` (issue #155). */
  connection_type: string | null
  /** The connection's logo URL, verbatim (issue #155). */
  connection_logo: string | null
  /** Akahu's `_authorisation` id for the account (issue #155). */
  authorisation_id: string | null
  /** Akahu's `_credentials` id for the account (issue #155). */
  credentials_id: string | null
  /**
   * Akahu's account attributes, e.g. `TRANSACTIONS`, in the order sent
   * (issue #155). An open set, so no value is checked; none sent is `[]`.
   */
  attributes: string[]
  formatted_account: string | null
  currency: string | null
  balance_current_cents: number
  balance_available_cents: number | null
  /** Only credit accounts carry a limit. */
  balance_limit_cents: number | null
  /** Akahu's refresh timestamps, verbatim. */
  refreshed_balance: string | null
  refreshed_meta: string | null
  refreshed_transactions: string | null
}

/** A transaction's merchant. Akahu may send any subset of these fields. */
export interface TransactionMerchant {
  id: string | null
  name: string | null
  nzbn: string | null
  website: string | null
  /** The merchant's logo URL, verbatim (issue #155). */
  logo: string | null
}

/**
 * A card transaction's conversion from a foreign currency (issue #155).
 * Akahu may send any subset of these fields.
 */
export interface TransactionConversion {
  /**
   * The foreign amount in hundredths of its currency's unit, read with the
   * same exact cents conversion as every other amount (prd-01 Ruling 3).
   * A currency with no minor unit (JPY) is still hundredths: 1500 is 150000.
   */
  amount_cents: number | null
  /** A three-letter currency code, e.g. `USD`, verbatim. */
  currency: string | null
  /** The rate as Akahu's decimal text, e.g. `'0.6123'`; not money. */
  rate: string | null
}

/** A transaction's bank-statement detail. Any subset may be present. */
export interface TransactionMeta {
  code: string | null
  particulars: string | null
  reference: string | null
  other_account: string | null
  logo: string | null
  /** The card's last digits, as text so a leading zero survives (#155). */
  card_suffix: string | null
  conversion: TransactionConversion | null
}

/**
 * Akahu's category for a transaction, as Akahu sent it (prd-01 Ruling 4).
 * The group is Akahu's `groups.personal_finance`.
 */
export interface TransactionAkahuCategory {
  id: string | null
  name: string | null
  group_id: string | null
  group_name: string | null
}

/** A settled transaction from `GET /v1/transactions`, keyed by `id`. */
export interface SettledTransaction {
  status: 'settled'
  /** Akahu's transaction id; the upsert key (prd-01 Ruling 1). */
  id: string
  account_id: string
  connection_id: string | null
  date: string
  posted_date: string | null
  created_at: string | null
  updated_at: string | null
  hash: string | null
  amount_cents: number
  /** The account balance after this transaction, when Akahu sends it. */
  balance_cents: number | null
  description: string
  /** Akahu's transaction type as sent, e.g. `EFTPOS`, `DIRECT DEBIT`. */
  type: string
  merchant: TransactionMerchant | null
  meta: TransactionMeta | null
  akahu_category: TransactionAkahuCategory | null
}

/**
 * A pending transaction from `GET /v1/transactions/pending`. It has no `id`
 * (prd-01 Ruling 1). Akahu's pending shape is unconfirmed against a live
 * response, so only `account_id`, `date` and `amount_cents` are required;
 * a missing `description` or `type` is `''`.
 */
export interface PendingTransaction {
  status: 'pending'
  account_id: string
  connection_id: string | null
  date: string
  updated_at: string | null
  amount_cents: number
  description: string
  type: string
  merchant: TransactionMerchant | null
  meta: TransactionMeta | null
  akahu_category: TransactionAkahuCategory | null
}

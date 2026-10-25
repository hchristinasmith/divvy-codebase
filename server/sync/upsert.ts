import type { Knex } from 'knex'
import type { Account } from '../../models/sync.ts'
import type { Transaction } from '../../models/transactions.ts'
import type {
  AkahuAccount,
  PendingTransaction,
  SettledTransaction,
} from './types.ts'

// The writes one sync run makes (prd-01, issue #21). Every function here
// takes the run's single write transaction; `run.ts` owns when it opens,
// commits and rolls back.
//
// - Accounts upsert on `akahu_id`. Only Akahu-owned columns are compared and
//   written; `scope` and `source` are Hannah's (Rulings 8, 9), so an insert
//   takes the column defaults and an update never names them.
// - Settled transactions upsert on `akahu_id` (Ruling 1). Akahu-owned
//   columns are compared and only a real difference is written, so a run
//   over unchanged data changes nothing (Done-when 1). The effective
//   `category` follows Akahu only while `category_source = 'akahu'`
//   (Ruling 4); nothing else about the user's category is ever written.
// - Pending transactions are a mirror (Ruling 1,
//   docs/akahu-pending-semantics.md): every Akahu pending row is deleted
//   and the fetched list inserted. That delete is the only delete in
//   `server/sync/`, and it can only reach `status = 'pending'` rows.
//
// Money arrives from the client as integer cents (Ruling 3) and is stored
// as it arrives; nothing here converts it.

// SQLite refuses a statement with more bound variables than this, so a
// multi-row insert is split to stay under it.
const SQLITE_MAX_VARIABLES = 999

// How many keys one `whereIn` lookup binds.
const LOOKUP_CHUNK = 500

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/** Inserts rows that share one key set, split under SQLite's variable cap. */
async function insertRows<Row extends object>(
  trx: Knex.Transaction,
  table: string,
  rows: readonly Row[],
): Promise<void> {
  if (rows.length === 0) return
  const perRow = Object.keys(rows[0]).length
  const size = Math.max(1, Math.floor(SQLITE_MAX_VARIABLES / perRow))
  for (const chunk of chunks(rows, size)) {
    await trx(table).insert(chunk)
  }
}

/** The last item for each id wins, so one id is written once per run. */
function lastById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()]
}

/** Loads existing rows of `table` whose `akahu_id` is one of `ids`. */
async function existingByAkahuId<Row extends { akahu_id: string | null }>(
  trx: Knex.Transaction,
  table: string,
  ids: readonly string[],
): Promise<Map<string, Row>> {
  const found = new Map<string, Row>()
  for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
    const rows: Row[] = await trx(table).whereIn('akahu_id', chunk).select()
    for (const row of rows) {
      if (row.akahu_id !== null) found.set(row.akahu_id, row)
    }
  }
  return found
}

type Comparable = string | number | null

/**
 * The fields of `incoming` whose value differs from `existing`, with
 * undefined and null treated as the same.
 */
function changedFields<Fields extends { [K in keyof Fields]: Comparable }>(
  existing: { [K in keyof Fields]?: unknown },
  incoming: Fields,
): Partial<Fields> {
  const changed: Partial<Fields> = {}
  for (const key of Object.keys(incoming) as (keyof Fields)[]) {
    const before = existing[key] ?? null
    const after = incoming[key] ?? null
    if (before !== after) changed[key] = incoming[key]
  }
  return changed
}

// ---------------------------------------------------------------------------
// Accounts.

/** Every `accounts` column Akahu owns and sync writes. */
interface AccountAkahuFields {
  name: string
  formatted_account: string | null
  type: string
  status: string
  connection_id: string
  connection_name: string
  currency: string | null
  balance_cents: number
  available_balance_cents: number | null
  credit_limit_cents: number | null
  refreshed_balance_at: string | null
  refreshed_meta_at: string | null
  refreshed_transactions_at: string | null
}

function accountFields(account: AkahuAccount): AccountAkahuFields {
  return {
    name: account.name,
    formatted_account: account.formatted_account,
    type: account.type,
    status: account.status,
    connection_id: account.connection_id,
    connection_name: account.connection_name,
    currency: account.currency,
    balance_cents: account.balance_current_cents,
    available_balance_cents: account.balance_available_cents,
    credit_limit_cents: account.balance_limit_cents,
    refreshed_balance_at: account.refreshed_balance,
    refreshed_meta_at: account.refreshed_meta,
    refreshed_transactions_at: account.refreshed_transactions,
  }
}

/** An inserted account: no `scope` or `source`, so both take the defaults. */
interface AccountInsert extends AccountAkahuFields {
  akahu_id: string
  created_at: string
  updated_at: string
}

/**
 * Upserts Akahu's accounts on `akahu_id`. `updated_at` moves only when an
 * Akahu-owned column changed. Never writes `scope` or `source`.
 */
export async function upsertAccounts(
  trx: Knex.Transaction,
  accounts: readonly AkahuAccount[],
  nowIso: string,
): Promise<void> {
  const unique = lastById(accounts)
  const existing = await existingByAkahuId<Account>(
    trx,
    'accounts',
    unique.map((a) => a.id),
  )
  const inserts: AccountInsert[] = []
  for (const account of unique) {
    const fields = accountFields(account)
    const row = existing.get(account.id)
    if (row === undefined) {
      inserts.push({
        akahu_id: account.id,
        ...fields,
        created_at: nowIso,
        updated_at: nowIso,
      })
      continue
    }
    const changed = changedFields(row, fields)
    if (Object.keys(changed).length === 0) continue
    await trx('accounts')
      .where({ id: row.id })
      .update({ ...changed, updated_at: nowIso })
  }
  await insertRows(trx, 'accounts', inserts)
}

// ---------------------------------------------------------------------------
// Settled transactions.

/** Every `transactions` column Akahu owns on a settled row. */
interface SettledAkahuFields {
  account_id: string
  connection_id: string | null
  // Akahu's own timestamps for the transaction, not Divvy's.
  created_at: string | null
  updated_at: string | null
  date: string
  description: string
  amount_cents: number
  balance_cents: number | null
  type: string
  hash: string | null
  particulars: string | null
  code: string | null
  reference: string | null
  other_account: string | null
  logo: string | null
  merchant_id: string | null
  merchant_name: string | null
  merchant_website: string | null
  akahu_category_id: string | null
  akahu_category_name: string | null
  akahu_category_group_id: string | null
  akahu_category_group_name: string | null
}

function settledFields(tx: SettledTransaction): SettledAkahuFields {
  return {
    account_id: tx.account_id,
    connection_id: tx.connection_id,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
    date: tx.date,
    description: tx.description,
    amount_cents: tx.amount_cents,
    balance_cents: tx.balance_cents,
    type: tx.type,
    hash: tx.hash,
    particulars: tx.meta?.particulars ?? null,
    code: tx.meta?.code ?? null,
    reference: tx.meta?.reference ?? null,
    other_account: tx.meta?.other_account ?? null,
    logo: tx.meta?.logo ?? null,
    merchant_id: tx.merchant?.id ?? null,
    merchant_name: tx.merchant?.name ?? null,
    merchant_website: tx.merchant?.website ?? null,
    akahu_category_id: tx.akahu_category?.id ?? null,
    akahu_category_name: tx.akahu_category?.name ?? null,
    akahu_category_group_id: tx.akahu_category?.group_id ?? null,
    akahu_category_group_name: tx.akahu_category?.group_name ?? null,
  }
}

/** The effective category Akahu would give this transaction. */
function akahuEffectiveCategory(tx: SettledTransaction): string | null {
  return tx.akahu_category?.name ?? null
}

/**
 * The one place sync decides the effective `category` of an existing row
 * (prd-01 Ruling 4): it follows Akahu only while `category_source` is
 * 'akahu'. Returns the change to write, or nothing.
 */
function categoryChange(
  row: Transaction,
  tx: SettledTransaction,
): { category: string | null } | Record<string, never> {
  if (row.category_source !== 'akahu') return {}
  const category = akahuEffectiveCategory(tx)
  return (row.category ?? null) === category ? {} : { category }
}

interface SettledInsert extends SettledAkahuFields {
  akahu_id: string
  status: 'settled'
  source: 'akahu'
  category: string | null
  category_source: 'akahu'
}

/**
 * Upserts settled transactions on `akahu_id`. A row is updated only when an
 * Akahu-owned column, or a category Akahu still owns, changed. Never
 * writes `status`, `source`, `category_source` or the legacy `category_*`
 * columns of an existing row.
 */
export async function upsertSettled(
  trx: Knex.Transaction,
  transactions: readonly SettledTransaction[],
): Promise<{ inserted: number; updated: number }> {
  const unique = lastById(transactions)
  const existing = await existingByAkahuId<Transaction & { akahu_id: string }>(
    trx,
    'transactions',
    unique.map((t) => t.id),
  )
  const inserts: SettledInsert[] = []
  let updated = 0
  for (const tx of unique) {
    const fields = settledFields(tx)
    const row = existing.get(tx.id)
    if (row === undefined) {
      inserts.push({
        akahu_id: tx.id,
        status: 'settled',
        source: 'akahu',
        ...fields,
        category: akahuEffectiveCategory(tx),
        category_source: 'akahu',
      })
      continue
    }
    const changed = { ...changedFields(row, fields), ...categoryChange(row, tx) }
    if (Object.keys(changed).length === 0) continue
    await trx('transactions').where({ id: row.id }).update(changed)
    updated += 1
  }
  await insertRows(trx, 'transactions', inserts)
  return { inserted: inserts.length, updated }
}

// ---------------------------------------------------------------------------
// The pending mirror.

/** A pending row. Akahu gives it no id, hash, balance or category. */
interface PendingInsert {
  akahu_id: null
  status: 'pending'
  source: 'akahu'
  account_id: string
  connection_id: string | null
  created_at: null
  updated_at: string | null
  date: string
  description: string
  amount_cents: number
  balance_cents: null
  type: string
  hash: null
  particulars: string | null
  code: string | null
  reference: string | null
  other_account: string | null
  logo: string | null
  merchant_id: string | null
  merchant_name: string | null
  merchant_website: string | null
  category: null
  category_source: 'akahu'
  akahu_category_id: null
  akahu_category_name: null
  akahu_category_group_id: null
  akahu_category_group_name: null
}

/**
 * A pending item as a row. Any category Akahu sends on a pending item is
 * dropped: Akahu does not enrich pending items, and a pending row is
 * replaced on every run, so nothing may hang off it.
 */
function pendingRow(tx: PendingTransaction): PendingInsert {
  return {
    akahu_id: null,
    status: 'pending',
    source: 'akahu',
    account_id: tx.account_id,
    connection_id: tx.connection_id,
    created_at: null,
    updated_at: tx.updated_at,
    date: tx.date,
    description: tx.description,
    amount_cents: tx.amount_cents,
    balance_cents: null,
    type: tx.type,
    hash: null,
    particulars: tx.meta?.particulars ?? null,
    code: tx.meta?.code ?? null,
    reference: tx.meta?.reference ?? null,
    other_account: tx.meta?.other_account ?? null,
    logo: tx.meta?.logo ?? null,
    merchant_id: tx.merchant?.id ?? null,
    merchant_name: tx.merchant?.name ?? null,
    merchant_website: tx.merchant?.website ?? null,
    category: null,
    category_source: 'akahu',
    akahu_category_id: null,
    akahu_category_name: null,
    akahu_category_group_id: null,
    akahu_category_group_name: null,
  }
}

/**
 * Replaces the pending mirror: deletes every Akahu pending row, on every
 * account, then inserts what Akahu sent. An account with no pending items,
 * or one Akahu no longer lists, ends with none. Two identical pending items
 * stay two rows. Returns how many rows were inserted.
 */
export async function replacePending(
  trx: Knex.Transaction,
  pending: readonly PendingTransaction[],
): Promise<number> {
  await trx('transactions').where({ status: 'pending', source: 'akahu' }).del()
  const rows = pending.map(pendingRow)
  await insertRows(trx, 'transactions', rows)
  return rows.length
}

import express from 'express'

import type { Account } from '../../models/sync.ts'
import type { CategorySource } from '../../models/transactions.ts'
import { getCategoryGroups } from '../db/categories.ts'
import {
  listAccounts,
  listTransactions,
  type SyncedTransaction,
} from '../db/synced.ts'

// /api/v1/accounts (prd-01, issue #32): the Dashboard's accounts and
// transactions, read from what sync stored. These replace the live Akahu
// proxy (prd-01 Ruling 7, Done-when 8): no request to this router reaches
// Akahu or reads a credential.
//
// The responses keep Akahu's envelope, `{ success: true, items }`, so the
// Dashboard reads them unchanged. Money is integer cents in the database and
// becomes dollars only here, at the envelope edge (prd-01 Ruling 3), through
// `centsToDollars`, which parses the number from the whole dollars and the
// two-digit remainder, never from `cents / 100`. A key whose column is
// NULL is left out of the item, never sent as 0 or null.
//
// The category is the effective one with its source (Ruling 4), shaped like
// Akahu's category object because the Dashboard reads
// `category.groups.personal_finance.name`. The group is looked up from the
// category's name in data/cats.js, never from Akahu's stored group
// (docs/akahu-pending-semantics.md §4).
//
// There is deliberately no `/:id` route: `/:id/transactions` was the proxy
// path, and an unmatched path must stay the app's JSON 404.

export interface AccountsEnvelope<Item> {
  success: true
  items: Item[]
}

export interface AccountItem {
  _id: string
  name: string
  attributes: string[]
  formatted_account?: string
  status?: string
  type?: string
  _authorisation?: string
  _credentials?: string
  connection?: {
    _id: string | null
    name: string | null
    logo?: string
    connection_type?: string
  }
  balance?: {
    currency?: string
    current: number
    available?: number
    limit?: number
  }
  refreshed?: {
    balance?: string
    meta?: string
    transactions?: string
  }
}

export interface TransactionCategory {
  name: string
  groups?: { personal_finance: { name: string } }
}

export interface TransactionItem {
  _id: string
  _account: string | null
  _connection: string | null
  _user?: string
  created_at?: string
  updated_at?: string
  date: string | null
  description: string | null
  amount: number
  balance?: number
  type: string | null
  hash?: string
  category?: TransactionCategory
  category_source: CategorySource
  pending: boolean
  merchant?: {
    _id: string | null
    name: string | null
    website?: string
    logo?: string
  }
  meta?: {
    particulars?: string
    code?: string
    reference?: string
    other_account?: string
    logo?: string
    card_suffix?: string
  }
}

/**
 * Integer cents to a JSON dollar number: 1250 → 12.5, -5 → -0.05, 0 → 0
 * (never -0). The number is parsed from the cents' own digits, so it is
 * the nearest double to the exact two-decimal amount. Throws on anything
 * that is not a safe integer: a fractional or NaN "cents" is corrupt data,
 * not something to round.
 */
export function centsToDollars(cents: number): number {
  if (!Number.isSafeInteger(cents)) {
    throw new Error('centsToDollars: cents must be a safe integer')
  }
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const fraction = String(abs % 100).padStart(2, '0')
  const dollars = Number(`${sign}${whole}.${fraction}`)
  return dollars === 0 ? 0 : dollars
}

// Copies `value` into `target[key]` unless it is NULL.
function setIfPresent<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null,
): void {
  if (value !== null) target[key] = value
}

function parseAttributes(text: string): string[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
    throw new Error('accounts.attributes is not a JSON array of strings')
  }
  return parsed
}

function toAccountItem(row: Account): AccountItem {
  if (row.akahu_id === null) {
    throw new Error('an Akahu account has no akahu_id')
  }
  const item: AccountItem = {
    _id: row.akahu_id,
    name: row.name,
    attributes: parseAttributes(row.attributes),
  }
  setIfPresent(item, 'formatted_account', row.formatted_account)
  setIfPresent(item, 'status', row.status)
  setIfPresent(item, 'type', row.type)
  setIfPresent(item, '_authorisation', row.authorisation_id)
  setIfPresent(item, '_credentials', row.credentials_id)

  if (
    row.connection_id !== null ||
    row.connection_name !== null ||
    row.connection_logo !== null ||
    row.connection_type !== null
  ) {
    const connection: NonNullable<AccountItem['connection']> = {
      _id: row.connection_id,
      name: row.connection_name,
    }
    setIfPresent(connection, 'logo', row.connection_logo)
    setIfPresent(connection, 'connection_type', row.connection_type)
    item.connection = connection
  }

  if (row.balance_cents !== null) {
    const balance: NonNullable<AccountItem['balance']> = {
      current: centsToDollars(row.balance_cents),
    }
    setIfPresent(balance, 'currency', row.currency)
    if (row.available_balance_cents !== null) {
      balance.available = centsToDollars(row.available_balance_cents)
    }
    if (row.credit_limit_cents !== null) {
      balance.limit = centsToDollars(row.credit_limit_cents)
    }
    item.balance = balance
  }

  const refreshed: NonNullable<AccountItem['refreshed']> = {}
  setIfPresent(refreshed, 'balance', row.refreshed_balance_at)
  setIfPresent(refreshed, 'meta', row.refreshed_meta_at)
  setIfPresent(refreshed, 'transactions', row.refreshed_transactions_at)
  if (Object.keys(refreshed).length > 0) item.refreshed = refreshed

  return item
}

// Category name → its group's name, from data/cats.js.
const groupOf = new Map<string, string>(
  getCategoryGroups().flatMap((group) =>
    group.categories.map((name): [string, string] => [name, group.name]),
  ),
)

function categoryFor(name: string): TransactionCategory {
  const group = groupOf.get(name)
  return group === undefined
    ? { name }
    : { name, groups: { personal_finance: { name: group } } }
}

function toTransactionItem(row: SyncedTransaction): TransactionItem {
  const pending = row.status === 'pending'
  let id: string
  if (pending) {
    // Ephemeral: sync deletes and re-inserts every pending row on each run
    // (prd-01 Ruling 1), so this id changes whenever sync runs. It is not
    // an Akahu id; nothing may PATCH by it or store it.
    id = `pending-${row.id}`
  } else if (row.akahu_id !== null) {
    id = row.akahu_id
  } else {
    throw new Error('a settled transaction has no akahu_id')
  }
  if (row.amount_cents === null) {
    throw new Error('a transaction has no amount_cents')
  }

  const item: TransactionItem = {
    _id: id,
    _account: row.account_id,
    _connection: row.connection_id,
    date: row.date,
    description: row.description,
    amount: centsToDollars(row.amount_cents),
    type: row.type,
    category_source: row.category_source,
    pending,
  }
  setIfPresent(item, '_user', row.user_id)
  setIfPresent(item, 'created_at', row.created_at)
  setIfPresent(item, 'updated_at', row.updated_at)
  if (row.balance_cents !== null) {
    item.balance = centsToDollars(row.balance_cents)
  }
  setIfPresent(item, 'hash', row.hash)
  if (row.category !== null) item.category = categoryFor(row.category)

  if (
    row.merchant_id !== null ||
    row.merchant_name !== null ||
    row.merchant_website !== null ||
    row.merchant_logo !== null
  ) {
    const merchant: NonNullable<TransactionItem['merchant']> = {
      _id: row.merchant_id,
      name: row.merchant_name,
    }
    setIfPresent(merchant, 'website', row.merchant_website)
    setIfPresent(merchant, 'logo', row.merchant_logo)
    item.merchant = merchant
  }

  const meta: NonNullable<TransactionItem['meta']> = {}
  setIfPresent(meta, 'particulars', row.particulars)
  setIfPresent(meta, 'code', row.code)
  setIfPresent(meta, 'reference', row.reference)
  setIfPresent(meta, 'other_account', row.other_account)
  setIfPresent(meta, 'logo', row.logo)
  setIfPresent(meta, 'card_suffix', row.card_suffix)
  if (Object.keys(meta).length > 0) item.meta = meta

  return item
}

/**
 * `?accountIds`: absent means every account. A string is a comma-separated
 * list; a repeated parameter arrives as an array and is accepted the same
 * way. Ids are trimmed and empty ones dropped. Anything that leaves no id,
 * or that is not a string or an array of strings (`accountIds[x]=y` parses
 * to an object), is refused.
 */
function parseAccountIds(raw: unknown): string[] | undefined | 'invalid' {
  if (raw === undefined) return undefined
  const parts =
    typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw) && raw.every((p) => typeof p === 'string')
        ? (raw as string[])
        : null
  if (parts === null) return 'invalid'
  const ids = parts
    .flatMap((part) => part.split(','))
    .map((id) => id.trim())
    .filter((id) => id !== '')
  return ids.length === 0 ? 'invalid' : ids
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

const router = express.Router()

// GET /api/v1/accounts
router.get('/', async (req, res) => {
  try {
    const rows = await listAccounts()
    const body: AccountsEnvelope<AccountItem> = {
      success: true,
      items: rows.map(toAccountItem),
    }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('accounts: could not read accounts', errorClass(err))
    res.status(500).json({ error: 'Could not read accounts' })
  }
})

// GET /api/v1/accounts/transactions
router.get('/transactions', async (req, res) => {
  const accountIds = parseAccountIds(req.query.accountIds)
  if (accountIds === 'invalid') {
    res.status(400).json({
      error: 'accountIds must be a comma-separated list of account ids',
    })
    return
  }
  try {
    const rows = await listTransactions(accountIds)
    const body: AccountsEnvelope<TransactionItem> = {
      success: true,
      items: rows.map(toTransactionItem),
    }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('accounts: could not read transactions', errorClass(err))
    res.status(500).json({ error: 'Could not read transactions' })
  }
})

export default router

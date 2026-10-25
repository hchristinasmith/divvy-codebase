import { readFile } from 'node:fs/promises'
import * as Path from 'node:path'
import * as URL from 'node:url'
import { dollarsToCents } from '../../../shared/money.ts'

// Seeds `transactions` from Akahu-shaped data (an envelope with `items`).
//
// Default source is the committed synthetic fixture, so a fresh clone seeds
// with no private data present (M1 #7). To seed from a private Akahu dump
// instead, set DIVVY_SEED_TRANSACTIONS to a `.json` file or a `.js` module
// that exports the envelope as `spending` or as its default export. A
// relative path is resolved from the repository root, so the old private
// file still works as `DIVVY_SEED_TRANSACTIONS=spending.js`. That file is
// gitignored and must stay that way.
//
// Akahu amounts are float dollars here, so they become integer cents with
// `dollarsToCents`. The sync does not use that path:
// `server/sync/akahu-client.ts` reads amounts as exact text and converts them
// through `exactAmountToCents` and `parseDollars` (prd-01 Ruling 3).

const __dirname = Path.dirname(URL.fileURLToPath(import.meta.url))
const REPO_ROOT = Path.resolve(__dirname, '..', '..', '..')
const FIXTURE_PATH = Path.join(__dirname, '..', 'fixtures', 'transactions.json')

async function loadEnvelope() {
  const override = process.env.DIVVY_SEED_TRANSACTIONS
  const path = override ? Path.resolve(REPO_ROOT, override) : FIXTURE_PATH

  let envelope
  if (path.endsWith('.json')) {
    envelope = JSON.parse(await readFile(path, 'utf8'))
  } else {
    const mod = await import(URL.pathToFileURL(path).href)
    envelope = mod.spending ?? mod.default
  }

  if (!envelope || !Array.isArray(envelope.items)) {
    throw new Error(
      `Seed source ${path} has no "items" array (expected an Akahu transactions envelope)`,
    )
  }
  return envelope.items
}

function centsOrNull(dollars) {
  return dollars === undefined || dollars === null ? null : dollarsToCents(dollars)
}

function toRow(txn) {
  const meta = txn.meta ?? {}
  const group = txn.category?.groups?.personal_finance
  return {
    akahu_id: txn._id,
    account_id: txn._account,
    user_id: txn._user,
    connection_id: txn._connection,
    created_at: txn.created_at,
    updated_at: txn.updated_at,
    date: txn.date,
    description: txn.description,
    amount_cents: dollarsToCents(txn.amount),
    balance_cents: centsOrNull(txn.balance),
    type: txn.type,
    hash: txn.hash,
    category_id: txn.category?._id || null,
    category_name: txn.category?.name || null,
    category_group_id: group?._id || null,
    category_group_name: group?.name || null,
    akahu_category_id: txn.category?._id || null,
    akahu_category_name: txn.category?.name || null,
    akahu_category_group_id: group?._id || null,
    akahu_category_group_name: group?.name || null,
    // Seeded rows are Akahu data: the effective category is Akahu's.
    category: txn.category?.name || null,
    category_source: 'akahu',
    particulars: meta.particulars || null,
    code: meta.code || null,
    reference: meta.reference || null,
    other_account: meta.other_account || null,
    logo: meta.logo || null,
    conversion_amount_cents: centsOrNull(meta.conversion_amount),
    conversion_currency: meta.conversion_currency || null,
    conversion_rate: meta.conversion_rate || null,
    card_suffix: meta.card_suffix || null,
    merchant_id: txn.merchant?._id || null,
    merchant_name: txn.merchant?.name || null,
    merchant_website: txn.merchant?.website || null,
    merchant_logo: txn.merchant?.logo || null,
  }
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function seed(knex) {
  const rows = (await loadEnvelope()).map(toRow)
  await knex('transactions').del()
  // SQLite caps bound parameters per statement; insert in batches.
  await knex.batchInsert('transactions', rows, 25)
}

// The category agent's reads (prd-04 Rulings 2, 4, 7 and 9; #42, #430).
// Selects and joins only: `transactions`, `accounts`, `category_corrections`
// and `category_proposals` are read here and written nowhere in this
// directory.
//
// For the rules (Ruling 7), each row leaves this file reduced to its scope
// and merchant key (`merchantKeyOf`, the stored subscription-mark contract),
// so a description, reference, particulars, code, card suffix or account id
// never reaches the learner, the reason text or a log.
//
// For the model (Ruling 9), `loadModelRows` and `loadExamples` select
// Ruling 4's fields by name and nothing else: date, amount, merchant,
// description and categories. The merchant id and the account's scope are
// read only to key an example to its merchant, and are not returned. Never
// `select *`: a column added to `transactions` must not reach a prompt.
//
// Scope comes from the row's account, joined on the Akahu account id as the
// insights queries join it.
import type { AccountScope } from '../../../models/sync.ts'
import { merchantKeyOf } from '../../../shared/subscriptions.ts'
import connection from '../../db/connection.ts'
import type { CorrectionExample, PromptRow, RejectionExample } from './prompt.ts'
import type { CorrectionFact, RejectionFact } from './rules.ts'

/** A row the agent may propose for, reduced. */
export interface Candidate {
  id: number
  scope: AccountScope
  // Null when the row has neither a merchant id nor a description with a
  // letter in it: it is examined, so the sweep moves past it, and never
  // proposed for.
  key: string | null
  // As stored, raw: the accept route's stale check compares it with
  // `transactions.category`.
  category: string | null
}

interface KeyedRow {
  scope: AccountScope
  merchant_id: string | null
  description: string | null
}

const keyOf = (row: KeyedRow) =>
  merchantKeyOf({ merchantId: row.merchant_id, description: row.description })

// Ids per statement when reading given rows: under every SQLite build's
// bound-variable limit.
const IDS_PER_READ = 500

interface CandidateQuery {
  // Rows with a higher id only.
  afterId?: number
  limit?: number
  // Exactly these rows, if eligible, whatever the cursor; `afterId` and
  // `limit` are ignored.
  ids?: readonly number[]
}

/**
 * Rows the agent may propose for, ascending by id: settled (#246: a pending
 * row is re-inserted with a new id at every sync, and its proposals cascade
 * away), from Akahu, on an Akahu account, and with the category Akahu set.
 * A row Hannah or an accepted proposal categorised is never read.
 */
export async function loadCandidates(
  db = connection,
  query: CandidateQuery = {},
): Promise<Candidate[]> {
  const read = () =>
    db('transactions as t')
      .join('accounts as a', 't.account_id', 'a.akahu_id')
      .where({
        't.status': 'settled',
        't.source': 'akahu',
        'a.source': 'akahu',
        't.category_source': 'akahu',
      })
      .orderBy('t.id', 'asc')
      .select('t.id', 'a.scope', 't.merchant_id', 't.description', 't.category')

  let rows: (KeyedRow & { id: number; category: string | null })[]
  if (query.ids !== undefined) {
    rows = []
    for (let start = 0; start < query.ids.length; start += IDS_PER_READ) {
      rows.push(...(await read().whereIn('t.id', query.ids.slice(start, start + IDS_PER_READ))))
    }
    rows.sort((a, b) => a.id - b.id)
  } else {
    const sweep = read()
    if (query.afterId !== undefined) sweep.where('t.id', '>', query.afterId)
    if (query.limit !== undefined) sweep.limit(query.limit)
    rows = await sweep
  }

  return rows.map((row) => ({ id: row.id, scope: row.scope, key: keyOf(row), category: row.category }))
}

interface Evidence {
  corrections: CorrectionFact[]
  rejections: RejectionFact[]
}

/**
 * What the learner reads: Hannah's own corrections (`source = 'user'`, never
 * `rule` or `claude`, #280) and every rejected proposal, each keyed by its
 * row's scope and merchant. A fact on a row with no key is dropped.
 */
export async function loadEvidence(db = connection): Promise<Evidence> {
  const corrected: (KeyedRow & {
    id: number
    transaction_id: number
    from_category: string | null
    to_category: string
    corrected_at: string
  })[] = await db('category_corrections as c')
    .join('transactions as t', 'c.transaction_id', 't.id')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'c.source': 'user' })
    .orderBy('c.id', 'asc')
    .select(
      'c.id',
      'c.transaction_id',
      'c.from_category',
      'c.to_category',
      'c.corrected_at',
      'a.scope',
      't.merchant_id',
      't.description',
    )

  const rejected: (KeyedRow & { transaction_id: number; proposed_category: string })[] = await db(
    'category_proposals as p',
  )
    .join('transactions as t', 'p.transaction_id', 't.id')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'p.status': 'rejected' })
    .orderBy('p.id', 'asc')
    .select('p.transaction_id', 'p.proposed_category', 'a.scope', 't.merchant_id', 't.description')

  const corrections: CorrectionFact[] = []
  for (const row of corrected) {
    const key = keyOf(row)
    if (key === null) continue
    corrections.push({
      id: row.id,
      transactionId: row.transaction_id,
      scope: row.scope,
      key,
      from: row.from_category,
      to: row.to_category,
      at: row.corrected_at,
    })
  }

  const rejections: RejectionFact[] = []
  for (const row of rejected) {
    const key = keyOf(row)
    if (key === null) continue
    rejections.push({ transactionId: row.transaction_id, scope: row.scope, key, category: row.proposed_category })
  }

  return { corrections, rejections }
}

/** A row as the model may see it (Ruling 4), with the id it is stored under. */
export interface ModelRow extends PromptRow {
  id: number
}

/**
 * Ruling 4's fields of exactly these rows, ascending by id. The caller
 * passes ids `loadCandidates` returned, at most one batch's worth.
 */
export async function loadModelRows(db = connection, ids: readonly number[]): Promise<ModelRow[]> {
  if (ids.length > IDS_PER_READ) throw new Error('too many rows for one read')
  const rows: {
    id: number
    date: string | null
    amount_cents: number | null
    merchant_name: string | null
    description: string | null
    category: string | null
  }[] = await db('transactions as t')
    .whereIn('t.id', ids)
    .orderBy('t.id', 'asc')
    .select('t.id', 't.date', 't.amount_cents', 't.merchant_name', 't.description', 't.category')
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amountCents: r.amount_cents,
    merchant: r.merchant_name,
    description: r.description,
    category: r.category,
  }))
}

/** An example keyed by the merchant it is about. */
export interface Keyed<T> {
  scope: AccountScope
  key: string
  example: T
}

interface Examples {
  corrections: Keyed<CorrectionExample>[]
  rejections: Keyed<RejectionExample>[]
}

/**
 * Hannah's own corrections (`source = 'user'`) and every rejected proposal,
 * newest first, as Ruling 4's fields of the row each is about, keyed by
 * that row's scope and merchant. A fact on a row with no key is dropped.
 */
export async function loadExamples(db = connection): Promise<Examples> {
  const corrected: (KeyedRow & {
    merchant_name: string | null
    from_category: string | null
    to_category: string
  })[] = await db('category_corrections as c')
    .join('transactions as t', 'c.transaction_id', 't.id')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'c.source': 'user' })
    .orderBy('c.id', 'desc')
    .select('a.scope', 't.merchant_id', 't.merchant_name', 't.description', 'c.from_category', 'c.to_category')

  const rejected: (KeyedRow & {
    merchant_name: string | null
    current_category: string | null
    proposed_category: string
  })[] = await db('category_proposals as p')
    .join('transactions as t', 'p.transaction_id', 't.id')
    .join('accounts as a', 't.account_id', 'a.akahu_id')
    .where({ 'p.status': 'rejected' })
    .orderBy('p.id', 'desc')
    .select('a.scope', 't.merchant_id', 't.merchant_name', 't.description', 'p.current_category', 'p.proposed_category')

  const corrections: Keyed<CorrectionExample>[] = []
  for (const row of corrected) {
    const key = keyOf(row)
    if (key === null) continue
    corrections.push({
      scope: row.scope,
      key,
      example: { merchant: row.merchant_name, description: row.description, from: row.from_category, to: row.to_category },
    })
  }

  const rejections: Keyed<RejectionExample>[] = []
  for (const row of rejected) {
    const key = keyOf(row)
    if (key === null) continue
    rejections.push({
      scope: row.scope,
      key,
      example: {
        merchant: row.merchant_name,
        description: row.description,
        current: row.current_category,
        rejected: row.proposed_category,
      },
    })
  }

  return { corrections, rejections }
}

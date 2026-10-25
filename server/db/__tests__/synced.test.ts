import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import { listAccounts, listTransactions } from '../synced.ts'

// The DB reads behind the Dashboard's accounts routes (#32). Each test
// starts from an empty, freshly migrated in-memory database and inserts the
// rows it needs; every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const NOW = '2026-10-25T00:00:00.000Z'

function account(fields: Record<string, unknown>) {
  return {
    source: 'akahu',
    name: 'Invented account',
    created_at: NOW,
    updated_at: NOW,
    ...fields,
  }
}

function settled(
  akahuId: string,
  accountId: string,
  date: string,
  fields: Record<string, unknown> = {},
) {
  return {
    akahu_id: akahuId,
    account_id: accountId,
    connection_id: 'conn_invented',
    date,
    description: `Invented ${akahuId}`,
    amount_cents: -1250,
    balance_cents: 50000,
    type: 'EFTPOS',
    hash: `hash_${akahuId}`,
    status: 'settled',
    source: 'akahu',
    category: 'Bakeries',
    category_source: 'akahu',
    ...fields,
  }
}

function pending(
  accountId: string,
  date: string,
  fields: Record<string, unknown> = {},
) {
  return {
    akahu_id: null,
    account_id: accountId,
    connection_id: 'conn_invented',
    date,
    description: 'Invented pending',
    amount_cents: -700,
    balance_cents: null,
    type: 'EFTPOS',
    hash: null,
    status: 'pending',
    source: 'akahu',
    category: null,
    category_source: 'akahu',
    ...fields,
  }
}

// The columns a synced transaction row carries: never the legacy
// `category_*`, never Akahu's `akahu_category_*`, never `conversion_*`.
const ROW_KEYS = [
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
]

describe('listAccounts', () => {
  it('answers [] for an empty table', async () => {
    expect(await listAccounts(connection)).toStrictEqual([])
  })

  it('returns only Akahu-sourced accounts, in id order', async () => {
    await connection('accounts').insert([
      account({ id: 7, akahu_id: 'acc_seven', name: 'Seven' }),
      account({ id: 3, akahu_id: null, source: 'xero', name: 'Ledger' }),
      account({ id: 2, akahu_id: 'acc_two', name: 'Two' }),
    ])

    const rows = await listAccounts(connection)

    expect(rows.map((r) => r.akahu_id)).toStrictEqual(['acc_two', 'acc_seven'])
  })

  it('returns balances as the stored integer cents', async () => {
    await connection('accounts').insert(
      account({
        akahu_id: 'acc_cents',
        balance_cents: 1250,
        available_balance_cents: -5,
        credit_limit_cents: 99999999,
      }),
    )

    const [row] = await listAccounts(connection)

    expect(row.balance_cents).toBe(1250)
    expect(row.available_balance_cents).toBe(-5)
    expect(row.credit_limit_cents).toBe(99999999)
    for (const v of [
      row.balance_cents,
      row.available_balance_cents,
      row.credit_limit_cents,
    ]) {
      expect(Number.isInteger(v)).toBe(true)
    }
  })
})

describe('listTransactions', () => {
  beforeEach(async () => {
    await connection('transactions').insert([
      settled('trans_a1', 'acc_a', '2026-10-20T00:00:00.000Z'),
      settled('trans_b1', 'acc_b', '2026-10-21T00:00:00.000Z'),
      settled('trans_c1', 'acc_c', '2026-10-22T00:00:00.000Z'),
      pending('acc_a', '2026-10-23T00:00:00.000Z'),
      settled('trans_x1', 'acc_a', '2026-10-24T00:00:00.000Z', {
        source: 'xero',
      }),
    ])
  })

  it('with no ids returns every Akahu row, pending included, xero excluded', async () => {
    const rows = await listTransactions(undefined, connection)

    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.akahu_id)).toStrictEqual([
      null,
      'trans_c1',
      'trans_b1',
      'trans_a1',
    ])
    expect(rows.map((r) => r.status)).toStrictEqual([
      'pending',
      'settled',
      'settled',
      'settled',
    ])
  })

  it('with ids returns only those accounts’ rows', async () => {
    const rows = await listTransactions(['acc_a', 'acc_b'], connection)

    expect(rows.map((r) => [r.account_id, r.status])).toStrictEqual([
      ['acc_a', 'pending'],
      ['acc_b', 'settled'],
      ['acc_a', 'settled'],
    ])
  })

  it('an unknown id returns []', async () => {
    expect(await listTransactions(['acc_nobody'], connection)).toStrictEqual([])
  })

  it('an empty list returns [], not every row', async () => {
    expect(await listTransactions([], connection)).toStrictEqual([])
  })

  it('an id carrying SQL is a value, not SQL', async () => {
    expect(await listTransactions(["x' OR '1'='1"], connection)).toStrictEqual(
      [],
    )
    expect(await connection('transactions').count({ n: '*' })).toStrictEqual([
      { n: 5 },
    ])
  })

  it('orders by date descending, then id descending within a date', async () => {
    await connection('transactions').del()
    const day = '2026-10-10T00:00:00.000Z'
    await connection('transactions').insert([
      settled('trans_old', 'acc_a', '2026-10-01T00:00:00.000Z', { id: 1 }),
      settled('trans_low', 'acc_a', day, { id: 2 }),
      settled('trans_high', 'acc_a', day, { id: 3 }),
      settled('trans_new', 'acc_a', '2026-10-11T00:00:00.000Z', { id: 4 }),
    ])

    const rows = await listTransactions(undefined, connection)

    expect(rows.map((r) => r.akahu_id)).toStrictEqual([
      'trans_new',
      'trans_high',
      'trans_low',
      'trans_old',
    ])
  })

  it('a pending row keeps its NULLs and its amount in cents', async () => {
    const [row] = await listTransactions(['acc_a'], connection)

    expect(row.status).toBe('pending')
    expect(row.akahu_id).toBeNull()
    expect(row.hash).toBeNull()
    expect(row.balance_cents).toBeNull()
    expect(row.category).toBeNull()
    expect(row.created_at).toBeNull()
    expect(row.amount_cents).toBe(-700)
  })

  it('a row carries exactly the read columns, never the legacy or Akahu category ones', async () => {
    await connection('transactions').where({ akahu_id: 'trans_a1' }).update({
      category_name: 'Legacy name',
      akahu_category_name: 'Akahu name',
    })

    const rows = await listTransactions(['acc_a'], connection)

    for (const row of rows) {
      expect(Object.keys(row).sort()).toStrictEqual([...ROW_KEYS].sort())
    }
  })
})

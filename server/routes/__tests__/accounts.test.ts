import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import connection from '../../db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import { centsToDollars } from '../accounts.ts'

// /api/v1/accounts (prd-01, issue #32): the Dashboard's accounts and
// transactions in Akahu's envelope, read from the database rather than
// proxied from Akahu. Every value below is invented.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.restoreAllMocks()
})

afterAll(closeDb)

const NOW = '2026-10-25T00:00:00.000Z'

type Row = Record<string, unknown>

function insertAccounts(...rows: Row[]) {
  return connection('accounts').insert(
    rows.map((fields) => ({
      source: 'akahu',
      name: 'Invented account',
      created_at: NOW,
      updated_at: NOW,
      ...fields,
    })),
  )
}

// A settled row as sync writes one, with every optional column filled.
function settled(akahuId: string, fields: Row = {}): Row {
  return {
    akahu_id: akahuId,
    account_id: 'acc_a',
    user_id: 'user_invented',
    connection_id: 'conn_invented',
    created_at: '2026-10-20T01:00:00.000Z',
    updated_at: '2026-10-20T02:00:00.000Z',
    date: '2026-10-20T00:00:00.000Z',
    description: `Invented ${akahuId}`,
    amount_cents: -1250,
    balance_cents: 50000,
    type: 'EFTPOS',
    hash: `hash_${akahuId}`,
    particulars: 'Inv particulars',
    code: 'Inv code',
    reference: 'Inv ref',
    other_account: '00-0000-0000000-00',
    logo: 'https://example.invalid/tx.png',
    card_suffix: '0000',
    merchant_id: 'merchant_invented',
    merchant_name: 'Invented Bakery',
    merchant_website: 'https://example.invalid',
    merchant_logo: 'https://example.invalid/m.png',
    category: 'Bakeries',
    category_source: 'akahu',
    status: 'settled',
    source: 'akahu',
    ...fields,
  }
}

// A pending row as sync writes one: no id, hash, created_at, balance or
// category (docs/akahu-pending-semantics.md).
function pending(fields: Row = {}): Row {
  return {
    akahu_id: null,
    account_id: 'acc_a',
    connection_id: 'conn_invented',
    created_at: null,
    updated_at: '2026-10-24T02:00:00.000Z',
    date: '2026-10-24T00:00:00.000Z',
    description: 'Invented pending',
    amount_cents: -700,
    balance_cents: null,
    type: 'EFTPOS',
    hash: null,
    category: null,
    category_source: 'akahu',
    status: 'pending',
    source: 'akahu',
    ...fields,
  }
}

function insertTransactions(...rows: Row[]) {
  return connection('transactions').insert(rows)
}

const sortedKeys = (o: object) => Object.keys(o).sort()

describe('GET /api/v1/accounts', () => {
  it('answers an empty table with an empty envelope', async () => {
    const res = await api.get('/api/v1/accounts')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(sortedKeys(res.body)).toStrictEqual(['items', 'success'])
    expect(res.body).toStrictEqual({ success: true, items: [] })
  })

  it('maps a fully populated account to Akahu’s shape, in dollars', async () => {
    await insertAccounts({
      akahu_id: 'acc_full',
      scope: 'strawb',
      name: 'Invented Everyday',
      formatted_account: '00-0000-0000000-00',
      type: 'CHECKING',
      status: 'ACTIVE',
      attributes: '["TRANSACTIONS","TRANSFER_TO"]',
      connection_id: 'conn_invented',
      connection_name: 'Invented Bank',
      connection_type: 'classic',
      connection_logo: 'https://example.invalid/bank.png',
      authorisation_id: 'auth_invented',
      credentials_id: 'creds_invented',
      currency: 'NZD',
      balance_cents: 123456,
      available_balance_cents: 120000,
      credit_limit_cents: 500000,
      refreshed_balance_at: '2026-10-24T01:00:00.000Z',
      refreshed_meta_at: '2026-10-24T02:00:00.000Z',
      refreshed_transactions_at: '2026-10-24T03:00:00.000Z',
    })

    const res = await api.get('/api/v1/accounts')

    expect(res.status).toBe(200)
    const [item] = res.body.items
    expect(sortedKeys(item)).toStrictEqual(
      [
        '_id',
        'name',
        'attributes',
        'formatted_account',
        'status',
        'type',
        '_authorisation',
        '_credentials',
        'connection',
        'balance',
        'refreshed',
      ].sort(),
    )
    expect(item).toStrictEqual({
      _id: 'acc_full',
      name: 'Invented Everyday',
      attributes: ['TRANSACTIONS', 'TRANSFER_TO'],
      formatted_account: '00-0000-0000000-00',
      status: 'ACTIVE',
      type: 'CHECKING',
      _authorisation: 'auth_invented',
      _credentials: 'creds_invented',
      connection: {
        _id: 'conn_invented',
        name: 'Invented Bank',
        logo: 'https://example.invalid/bank.png',
        connection_type: 'classic',
      },
      balance: {
        currency: 'NZD',
        current: 1234.56,
        available: 1200,
        limit: 5000,
      },
      refreshed: {
        balance: '2026-10-24T01:00:00.000Z',
        meta: '2026-10-24T02:00:00.000Z',
        transactions: '2026-10-24T03:00:00.000Z',
      },
    })
    expect(sortedKeys(item.connection)).toStrictEqual(
      ['_id', 'name', 'logo', 'connection_type'].sort(),
    )
    expect(sortedKeys(item.balance)).toStrictEqual(
      ['currency', 'current', 'available', 'limit'].sort(),
    )
    expect(sortedKeys(item.refreshed)).toStrictEqual(
      ['balance', 'meta', 'transactions'].sort(),
    )
  })

  it('leaves out every key whose column is NULL, and never sends id, scope or source', async () => {
    await insertAccounts({ akahu_id: 'acc_sparse', name: 'Sparse' })

    const res = await api.get('/api/v1/accounts')

    const [item] = res.body.items
    expect(sortedKeys(item)).toStrictEqual(['_id', 'attributes', 'name'])
    expect(item).toStrictEqual({
      _id: 'acc_sparse',
      name: 'Sparse',
      attributes: [],
    })
    for (const key of ['id', 'scope', 'source', 'balance']) {
      expect(key in item, key).toBe(false)
    }
  })

  it('a NULL balance has no balance key, never a 0', async () => {
    await insertAccounts({
      akahu_id: 'acc_nobal',
      currency: 'NZD',
      available_balance_cents: 100,
    })

    const res = await api.get('/api/v1/accounts')

    expect('balance' in res.body.items[0]).toBe(false)
    expect(res.text).not.toMatch(/"current"/)
  })

  it('lists only Akahu-sourced accounts, in id order', async () => {
    await insertAccounts(
      { id: 9, akahu_id: 'acc_nine', name: 'Nine' },
      { id: 4, akahu_id: null, source: 'xero', name: 'Ledger' },
      { id: 2, akahu_id: 'acc_two', name: 'Two' },
    )

    const res = await api.get('/api/v1/accounts')

    expect(res.body.items.map((i: { _id: string }) => i._id)).toStrictEqual([
      'acc_two',
      'acc_nine',
    ])
  })
})

describe('money in the envelope is stored cents as dollars', () => {
  // The expectation is a literal, never computed by dividing: [cents, the
  // JSON number as written, toFixed(2)].
  it.each([
    [1250, '12.5', '12.50'],
    [7, '0.07', '0.07'],
    [-5, '-0.05', '-0.05'],
    [0, '0', '0.00'],
    [10, '0.1', '0.10'],
    [115, '1.15', '1.15'],
    [1005, '10.05', '10.05'],
    [2999, '29.99', '29.99'],
    [-100000, '-1000', '-1000.00'],
    [99999999, '999999.99', '999999.99'],
  ])('%i cents is %s', async (cents, literal, fixed) => {
    await insertAccounts({ akahu_id: 'acc_money', balance_cents: cents })
    await insertTransactions(settled('trans_money', { amount_cents: cents }))

    const accounts = await api.get('/api/v1/accounts')
    const transactions = await api.get('/api/v1/accounts/transactions')

    expect(accounts.body.items[0].balance.current.toFixed(2)).toBe(fixed)
    expect(accounts.text).toContain(`"current":${literal}`)
    expect(transactions.body.items[0].amount.toFixed(2)).toBe(fixed)
    expect(transactions.text).toContain(`"amount":${literal},`)
  })

  it('converts the transaction balance too, and the account’s available and limit', async () => {
    await insertAccounts({
      akahu_id: 'acc_more',
      balance_cents: 1,
      available_balance_cents: -1,
      credit_limit_cents: 1005,
    })
    await insertTransactions(settled('trans_more', { balance_cents: 2999 }))

    const accounts = await api.get('/api/v1/accounts')
    const transactions = await api.get('/api/v1/accounts/transactions')

    expect(accounts.text).toContain('"current":0.01')
    expect(accounts.text).toContain('"available":-0.01')
    expect(accounts.text).toContain('"limit":10.05')
    expect(transactions.text).toContain('"balance":29.99')
  })
})

describe('centsToDollars', () => {
  it('turns 0 into 0, never -0', () => {
    expect(Object.is(centsToDollars(0), 0)).toBe(true)
    expect(Object.is(centsToDollars(-0), 0)).toBe(true)
  })

  it.each([
    ['a fraction', 12.5],
    ['NaN', NaN],
    ['2^53, past the safe range', 2 ** 53],
    ['Infinity', Infinity],
  ])('throws on %s', (_why, cents) => {
    expect(() => centsToDollars(cents)).toThrow(
      'centsToDollars: cents must be a safe integer',
    )
  })
})

describe('GET /api/v1/accounts/transactions filters by account', () => {
  beforeEach(async () => {
    await insertTransactions(
      settled('trans_a', {
        account_id: 'acc_a',
        date: '2026-10-20T00:00:00.000Z',
      }),
      settled('trans_b', {
        account_id: 'acc_b',
        date: '2026-10-21T00:00:00.000Z',
      }),
      settled('trans_c', {
        account_id: 'acc_c',
        date: '2026-10-22T00:00:00.000Z',
      }),
    )
  })

  const ids = (body: { items: { _id: string }[] }) =>
    body.items.map((i) => i._id)

  it('without accountIds returns every account’s rows', async () => {
    const res = await api.get('/api/v1/accounts/transactions')

    expect(res.status).toBe(200)
    expect(sortedKeys(res.body)).toStrictEqual(['items', 'success'])
    expect(res.body.success).toBe(true)
    expect(ids(res.body)).toStrictEqual(['trans_c', 'trans_b', 'trans_a'])
  })

  it.each([
    ['a comma-separated list', '?accountIds=acc_a,acc_b'],
    ['a list with spaces and an empty entry', '?accountIds=acc_a,%20acc_b,'],
    ['a repeated parameter', '?accountIds=acc_a&accountIds=acc_b'],
  ])('with %s returns only those accounts’ rows', async (_why, query) => {
    const res = await api.get(`/api/v1/accounts/transactions${query}`)

    expect(res.status).toBe(200)
    expect(ids(res.body)).toStrictEqual(['trans_b', 'trans_a'])
  })

  it('with a single id returns that account’s rows', async () => {
    const res = await api.get('/api/v1/accounts/transactions?accountIds=acc_c')

    expect(ids(res.body)).toStrictEqual(['trans_c'])
  })

  it('an unknown id is an empty envelope, not an error', async () => {
    const res = await api.get(
      '/api/v1/accounts/transactions?accountIds=acc_nobody',
    )

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ success: true, items: [] })
  })

  it.each([
    ['empty', '?accountIds='],
    ['only commas', '?accountIds=,'],
    ['an object', '?accountIds[x]=y'],
    ['an array holding an object', '?accountIds[0][x]=y'],
  ])('refuses accountIds that is %s with a 400', async (_why, query) => {
    const res = await api.get(`/api/v1/accounts/transactions${query}`)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'accountIds must be a comma-separated list of account ids',
    })
  })
})

describe('pending transactions', () => {
  const SETTLED_KEYS = [
    '_id',
    '_account',
    '_connection',
    '_user',
    'created_at',
    'updated_at',
    'date',
    'description',
    'amount',
    'balance',
    'type',
    'hash',
    'category',
    'category_source',
    'pending',
    'merchant',
    'meta',
  ]

  const PENDING_KEYS = [
    '_id',
    '_account',
    '_connection',
    'updated_at',
    'date',
    'description',
    'amount',
    'type',
    'category_source',
    'pending',
  ]

  it('appear once, flagged pending, beside settled rows flagged not pending', async () => {
    await insertTransactions(
      settled('trans_settled', { date: '2026-10-20T00:00:00.000Z' }),
      pending({ date: '2026-10-24T00:00:00.000Z' }),
    )

    const res = await api.get('/api/v1/accounts/transactions')

    expect(res.body.items).toHaveLength(2)
    const [p, s] = res.body.items
    expect(p.pending).toBe(true)
    expect(s.pending).toBe(false)
    expect(s._id).toBe('trans_settled')
    expect(p._id).toMatch(/^pending-\d+$/)
    expect(sortedKeys(p)).toStrictEqual([...PENDING_KEYS].sort())
    expect(sortedKeys(s)).toStrictEqual([...SETTLED_KEYS].sort())
  })

  it('two identical pending rows are two items with distinct ids', async () => {
    await insertTransactions(pending(), pending())

    const res = await api.get('/api/v1/accounts/transactions')

    expect(res.body.items).toHaveLength(2)
    const [first, second] = res.body.items
    expect(first.pending).toBe(true)
    expect(second.pending).toBe(true)
    expect(first._id).not.toBe(second._id)
  })

  it('a settled row carries its fields in Akahu’s nested shape', async () => {
    await insertTransactions(settled('trans_full'))

    const res = await api.get('/api/v1/accounts/transactions')

    const [item] = res.body.items
    expect(item).toStrictEqual({
      _id: 'trans_full',
      _account: 'acc_a',
      _connection: 'conn_invented',
      _user: 'user_invented',
      created_at: '2026-10-20T01:00:00.000Z',
      updated_at: '2026-10-20T02:00:00.000Z',
      date: '2026-10-20T00:00:00.000Z',
      description: 'Invented trans_full',
      amount: -12.5,
      balance: 500,
      type: 'EFTPOS',
      hash: 'hash_trans_full',
      category: {
        name: 'Bakeries',
        groups: { personal_finance: { name: 'Food' } },
      },
      category_source: 'akahu',
      pending: false,
      merchant: {
        _id: 'merchant_invented',
        name: 'Invented Bakery',
        website: 'https://example.invalid',
        logo: 'https://example.invalid/m.png',
      },
      meta: {
        particulars: 'Inv particulars',
        code: 'Inv code',
        reference: 'Inv ref',
        other_account: '00-0000-0000000-00',
        logo: 'https://example.invalid/tx.png',
        card_suffix: '0000',
      },
    })
    expect(sortedKeys(item.merchant)).toStrictEqual([
      '_id',
      'logo',
      'name',
      'website',
    ])
    expect(sortedKeys(item.meta)).toStrictEqual([
      'card_suffix',
      'code',
      'logo',
      'other_account',
      'particulars',
      'reference',
    ])
  })
})

describe('the category is the effective one, with its source', () => {
  async function onlyItem() {
    const res = await api.get('/api/v1/accounts/transactions')
    expect(res.body.items).toHaveLength(1)
    return res.body.items[0]
  }

  it('an Akahu-set category carries its group from data/cats.js', async () => {
    await insertTransactions(settled('trans_cat', { category: 'Bakeries' }))

    const item = await onlyItem()

    expect(item.category).toStrictEqual({
      name: 'Bakeries',
      groups: { personal_finance: { name: 'Food' } },
    })
    expect(item.category_source).toBe('akahu')
  })

  it('a user-set category wins over Akahu’s stored category and group', async () => {
    await insertTransactions(
      settled('trans_user', {
        category: 'Haircuts and treatments',
        category_source: 'user',
        akahu_category_id: 'nzfcc_invented',
        akahu_category_name: 'Bakeries',
        akahu_category_group_id: 'group_invented',
        akahu_category_group_name: 'Food',
        category_name: 'Bakeries',
        category_group_name: 'Food',
      }),
    )

    const item = await onlyItem()

    expect(item.category).toStrictEqual({
      name: 'Haircuts and treatments',
      groups: { personal_finance: { name: 'Appearance' } },
    })
    expect(item.category_source).toBe('user')
  })

  it('a row with only the legacy category columns has no category', async () => {
    await insertTransactions(
      settled('trans_legacy', {
        category: null,
        category_id: 'legacy_id',
        category_name: 'Bakeries',
        category_group_id: 'legacy_group',
        category_group_name: 'Food',
      }),
    )

    const item = await onlyItem()

    expect('category' in item).toBe(false)
    expect(item.category_source).toBe('akahu')
  })

  it('a name data/cats.js does not know is sent with no groups', async () => {
    await insertTransactions(
      settled('trans_odd', { category: 'Invented category' }),
    )

    const item = await onlyItem()

    expect(item.category).toStrictEqual({ name: 'Invented category' })
    expect(sortedKeys(item.category)).toStrictEqual(['name'])
  })
})

// prd-02 Ruling 15 (#264): a half of a drawing is sent as Drawings, set by
// rule, and keeps every other key of its item.
describe('a drawing is sent as Drawings', () => {
  const strawbOut = (fields: Row = {}) =>
    settled('trans_out', {
      id: 1,
      account_id: 'acc_s',
      amount_cents: -30000,
      date: '2026-10-20T00:00:00.000Z',
      ...fields,
    })
  const personalIn = settled('trans_in', {
    id: 2,
    account_id: 'acc_p',
    amount_cents: 30000,
    date: '2026-10-21T00:00:00.000Z',
    category: null,
  })

  async function items(): Promise<Row[]> {
    const res = await api.get('/api/v1/accounts/transactions')
    expect(res.status).toBe(200)
    return res.body.items
  }

  beforeEach(async () => {
    await insertAccounts(
      { akahu_id: 'acc_s', scope: 'strawb' },
      { akahu_id: 'acc_p', scope: 'personal' },
    )
  })

  it('both halves show Drawings with no group, and the item keys do not change', async () => {
    await insertTransactions(strawbOut())
    const [alone] = await items()
    await insertTransactions(personalIn)
    const paired = await items()
    const out = paired.find((i) => i._id === 'trans_out')
    const into = paired.find((i) => i._id === 'trans_in')

    expect(out?.category).toStrictEqual({ name: 'Drawings' })
    expect(out?.category_source).toBe('rule')
    expect(into?.category).toStrictEqual({ name: 'Drawings' })
    expect(into?.category_source).toBe('rule')
    expect(sortedKeys(out ?? {})).toStrictEqual(sortedKeys(alone))
    expect({ ...out, category: null, category_source: null }).toStrictEqual({
      ...alone,
      category: null,
      category_source: null,
    })
  })

  it('a half Hannah categorised keeps her category and its group', async () => {
    await insertTransactions(
      strawbOut({ category: 'Bakeries', category_source: 'user' }),
      personalIn,
    )
    const paired = await items()
    expect(paired.find((i) => i._id === 'trans_out')).toMatchObject({
      category: {
        name: 'Bakeries',
        groups: { personal_finance: { name: 'Food' } },
      },
      category_source: 'user',
    })
    expect(paired.find((i) => i._id === 'trans_in')).toMatchObject({
      category: { name: 'Drawings' },
      category_source: 'rule',
    })
  })
})

describe('order', () => {
  it('is newest first, with the higher id first on one date', async () => {
    const day = '2026-10-10T00:00:00.000Z'
    await insertTransactions(
      settled('trans_old', { id: 1, date: '2026-10-01T00:00:00.000Z' }),
      settled('trans_low', { id: 2, date: day }),
      settled('trans_high', { id: 3, date: day }),
      settled('trans_new', { id: 4, date: '2026-10-11T00:00:00.000Z' }),
    )

    const res = await api.get('/api/v1/accounts/transactions')

    expect(res.body.items.map((i: { _id: string }) => i._id)).toStrictEqual([
      'trans_new',
      'trans_high',
      'trans_low',
      'trans_old',
    ])
  })
})

describe('a read failure is a 500 with a message, never an empty 200', () => {
  async function withTableAway(table: string, run: () => Promise<void>) {
    await connection.schema.renameTable(table, `${table}_away`)
    try {
      await run()
    } finally {
      await connection.schema.renameTable(`${table}_away`, table)
    }
  }

  it('an unreadable accounts table', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await withTableAway('accounts', async () => {
      const res = await api.get('/api/v1/accounts')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not read accounts' })
    })
    // The error's class only: never its message, which names SQL.
    expect(error.mock.calls).toStrictEqual([
      ['accounts: could not read accounts', 'Error'],
    ])
  })

  it.each(['', '?accountIds=acc_a'])(
    'an unreadable transactions table (query %s)',
    async (query) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await withTableAway('transactions', async () => {
        const res = await api.get(`/api/v1/accounts/transactions${query}`)

        expect(res.status).toBe(500)
        expect(res.body).toStrictEqual({ error: 'Could not read transactions' })
      })
      expect(error.mock.calls).toStrictEqual([
        ['accounts: could not read transactions', 'Error'],
      ])
    },
  )

  it('corrupt attributes JSON', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await insertAccounts({ akahu_id: 'acc_corrupt', attributes: '{not json' })

    const res = await api.get('/api/v1/accounts')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not read accounts' })
    expect(error.mock.calls).toStrictEqual([
      ['accounts: could not read accounts', 'SyntaxError'],
    ])
  })

  // Valid JSON that is not an array of strings: JSON.parse accepts it, so
  // only the shape check stands between it and a 200 with a string or a
  // number where the Dashboard expects attribute names.
  it.each([
    ['a JSON string', '"x"'],
    ['an array holding a number', '[1]'],
  ])('attributes that are %s', async (_why, attributes) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await insertAccounts({ akahu_id: 'acc_shape', attributes })

    const res = await api.get('/api/v1/accounts')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not read accounts' })
    expect(error.mock.calls).toStrictEqual([
      ['accounts: could not read accounts', 'Error'],
    ])
  })

  // An Akahu account with a NULL akahu_id is not tested here: the
  // accounts_akahu_has_akahu_id CHECK refuses to store one.

  it('a settled transaction with no akahu_id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await insertTransactions(settled('trans_unused', { akahu_id: null }))

    const res = await api.get('/api/v1/accounts/transactions')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not read transactions' })
    expect(error.mock.calls).toStrictEqual([
      ['accounts: could not read transactions', 'Error'],
    ])
  })

  // The route's own NULL check and centsToDollars's safe-integer check both
  // refuse this row, so the test pins the 500, not which of them fired.
  it.each([
    ['settled', settled('trans_noamount', { amount_cents: null })],
    ['pending', pending({ amount_cents: null })],
  ])('a %s transaction with no amount_cents', async (_why, row) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await insertTransactions(row)

    const res = await api.get('/api/v1/accounts/transactions')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Could not read transactions' })
    expect(res.text).not.toMatch(/"amount"/)
    expect(error.mock.calls).toStrictEqual([
      ['accounts: could not read transactions', 'Error'],
    ])
  })
})

describe('the Akahu proxy is gone', () => {
  it('GET /api/v1/accounts/acc_1/transactions is the app’s JSON 404', async () => {
    const res = await api.get('/api/v1/accounts/acc_1/transactions')

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })

  it('POST /api/v1/accounts is a 404', async () => {
    const res = await api.post('/api/v1/accounts').send({})

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })

  const serverDir = fileURLToPath(new URL('../../', import.meta.url))
  const repoDir = fileURLToPath(new URL('../../../', import.meta.url))

  it('server/routes/akahu.ts no longer exists', () => {
    expect(existsSync(join(serverDir, 'routes', 'akahu.ts'))).toBe(false)
  })

  // prd-01 Done-when 8: only sync may spend Akahu's credentials. A hit is
  // Akahu's API host, a named credential (`AKAHU_USER_TOKEN`,
  // `AKAHU_APP_ID`, `AKAHU_APP_SECRET`), or any `AKAHU_*` read off an `env`
  // object. A bare `AKAHU_` is not: a migration's `AKAHU_CATEGORY` constant
  // and mcp/guard-env.ts's deny-list prefix name no credential. Built from
  // parts so this file is not itself a hit for the issue's grep.
  const AKAHU = 'AKAHU_'
  const AKAHU_SPEND = new RegExp(
    [
      'api\\.akahu\\.io',
      `\\b${AKAHU}(?:USER_TOKEN|APP_ID|APP_SECRET)\\b`,
      `\\benv\\s*(?:\\.|\\[\\s*['"\`])\\s*${AKAHU}`,
    ].join('|'),
  )

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : sourceFiles(path)
      }
      return /\.(?:ts|js)$/.test(entry.name) ? [path] : []
    })
  }

  // server/ outside server/sync/, and mcp/ (prd-03), never their tests.
  function guardedFiles(): string[] {
    return ['server', 'mcp']
      .flatMap((top) => sourceFiles(join(repoDir, top)))
      .map((path) => relative(repoDir, path))
      .filter((path) => !path.startsWith(`server${sep}sync${sep}`))
      .filter((path) => !path.split(sep).includes('__tests__'))
  }

  const spends = (path: string) =>
    AKAHU_SPEND.test(readFileSync(join(repoDir, path), 'utf8'))

  it('no server or mcp file outside server/sync/ and tests names Akahu’s credentials or API', () => {
    const files = guardedFiles()

    // The walk reached both trees, and .js as well as .ts.
    expect(files.some((p) => p.startsWith(`server${sep}`))).toBe(true)
    expect(files.some((p) => p.startsWith(`mcp${sep}`))).toBe(true)
    expect(files.some((p) => p.endsWith('.js'))).toBe(true)
    expect(files.filter(spends)).toStrictEqual([])
  })

  it.each([
    ['the API host', 'https://api.akahu.io/v1/accounts'],
    ['the token', `x = ${AKAHU}USER_TOKEN`],
    ['the app id', `x = ${AKAHU}APP_ID`],
    ['any AKAHU_ env read', `process.env.${AKAHU}ANYTHING`],
    ['a bracketed env read', `env['${AKAHU}ANYTHING']`],
  ])('the guard sees %s', (_why, text) => {
    expect(AKAHU_SPEND.test(text)).toBe(true)
  })

  it('the guard can see a hit in a real file (sync itself spends the token)', () => {
    const syncFiles = sourceFiles(join(serverDir, 'sync')).filter((path) =>
      AKAHU_SPEND.test(readFileSync(path, 'utf8')),
    )

    expect(syncFiles.length).toBeGreaterThan(0)
  })
})

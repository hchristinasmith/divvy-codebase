import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AkahuError, createAkahuClient, MAX_PAGES } from '../akahu-client.ts'
import type { AkahuClient, AkahuFetch, AkahuGetInit } from '../akahu-client.ts'
import type { PendingTransaction, SettledTransaction } from '../types.ts'

// Issue #20 (prd-01 w1): the Akahu client returns typed, cents-converted
// accounts and transactions, follows the cursor to the end, and never lets a
// credential reach an error or a log line.
//
// Fixtures are read as raw text and served as a Response body, exactly as
// Akahu's bytes would arrive; importing them as JSON would turn every amount
// into a float before the client could see it (docs/testing.md, Fixtures).

const syncDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = Path.join(syncDir, '__fixtures__')

function fixture(name: string): string {
  return readFileSync(Path.join(fixturesDir, name), 'utf8')
}

/** Values no error, serialised error or log line may contain. */
const SENTINEL_TOKEN = 'sentinel-akahu-user-token-4f2a9c'
const SENTINEL_APP_ID = 'sentinel-akahu-app-id-71be03'

type Reply = string | { status: number; body?: string }

interface RecordedCall {
  url: URL
  init: AkahuGetInit
}

/**
 * A fetch that answers with `replies` in order and records every call. When
 * the replies run out it answers with `onExhausted(callNumber)` if given,
 * else it throws, so an unexpected extra request fails the test.
 */
function recordingFetch(
  replies: Reply[],
  onExhausted?: (call: number) => Reply,
) {
  const calls: RecordedCall[] = []
  const queue = [...replies]
  const fetch: AkahuFetch = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift() ?? onExhausted?.(calls.length)
    if (next === undefined) {
      throw new Error(`unexpected request ${calls.length}: ${url.pathname}`)
    }
    const reply = typeof next === 'string' ? { status: 200, body: next } : next
    return new Response(reply.body ?? '', {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetch, calls }
}

function clientWith(replies: Reply[], onExhausted?: (call: number) => Reply) {
  const recorder = recordingFetch(replies, onExhausted)
  const client: AkahuClient = createAkahuClient({
    token: SENTINEL_TOKEN,
    appId: SENTINEL_APP_ID,
    fetch: recorder.fetch,
  })
  return { client, calls: recorder.calls }
}

/** A client whose fetch is the given function. */
function clientFetching(fetch: AkahuFetch): AkahuClient {
  return createAkahuClient({
    token: SENTINEL_TOKEN,
    appId: SENTINEL_APP_ID,
    fetch,
  })
}

/** Akahu's envelope around raw item text. */
function page(items: string[], next: string | null = null): string {
  const cursor = next === null ? 'null' : JSON.stringify(next)
  return `{"success":true,"items":[${items.join(',')}],"cursor":{"next":${cursor}}}`
}

/** A minimal settled item with the amount written as raw JSON text. */
function settledItem(id: string, amount = '-1.00', extra = ''): string {
  return `{"_id":"${id}","_account":"acc_fixture_inline","date":"2026-10-01T00:00:00.000Z","description":"Example inline","type":"EFTPOS","amount":${amount}${extra}}`
}

const WINDOW = {
  start: new Date('2026-09-25T00:00:00.000Z'),
  end: new Date('2026-10-25T00:00:00.000Z'),
}

/**
 * The fixture's page 1 with its cursor replaced by the end of the list. It
 * throws if the cursor is not there, so a fixture edit cannot quietly turn
 * every single-page test into a test of nothing.
 */
function singlePageTransactions(): string {
  const text = fixture('akahu-transactions.json')
  const cursor = '"next": "cursor_fixture_page2"'
  if (!text.includes(cursor)) throw new Error('fixture lost its cursor')
  return text.replace(cursor, '"next": null')
}

async function rejection(promise: Promise<unknown>): Promise<AkahuError> {
  const outcome = await promise.then(
    () => new Error('expected a rejection'),
    (e: unknown) => e,
  )
  expect(outcome).toBeInstanceOf(AkahuError)
  return outcome as AkahuError
}

/** Every `*_cents` value on an output object, nested objects included. */
function centsValues(row: object): unknown[] {
  return Object.entries(row).flatMap(([key, value]) => {
    if (key.endsWith('_cents')) return [value]
    if (typeof value === 'object' && value !== null) return centsValues(value)
    return []
  })
}

const SETTLED_KEYS = [
  'account_id',
  'akahu_category',
  'amount_cents',
  'balance_cents',
  'connection_id',
  'created_at',
  'date',
  'description',
  'hash',
  'id',
  'merchant',
  'meta',
  'posted_date',
  'status',
  'type',
  'updated_at',
]

const PENDING_KEYS = [
  'account_id',
  'akahu_category',
  'amount_cents',
  'connection_id',
  'date',
  'description',
  'merchant',
  'meta',
  'status',
  'type',
  'updated_at',
]

const MERCHANT_KEYS = ['id', 'logo', 'name', 'nzbn', 'website']

const META_KEYS = [
  'card_suffix',
  'code',
  'conversion',
  'logo',
  'other_account',
  'particulars',
  'reference',
]

const CONVERSION_KEYS = ['amount_cents', 'currency', 'rate']

const ACCOUNT_KEYS = [
  'balance_available_cents',
  'balance_current_cents',
  'balance_limit_cents',
  'connection_id',
  'connection_name',
  'currency',
  'formatted_account',
  'id',
  'name',
  'refreshed_balance',
  'refreshed_meta',
  'refreshed_transactions',
  'status',
  'type',
]

describe('dollars to integer cents (prd-01 Ruling 3)', () => {
  it.each([
    ['19.99', 1999],
    ['1.15', 115],
    ['0.07', 7],
    ['-2.30', -230],
    ['0', 0],
    ['-0', 0],
    ['-0.00', 0],
    ['5', 500],
    ['5.5', 550],
    ['123456789012.34', 12345678901234],
    ['"19.99"', 1999],
  ])('converts %s to %d cents', async (amount, cents) => {
    const { client } = clientWith([
      page([
        settledItem('trans_fixture_amount', amount, `,"balance":${amount}`),
      ]),
    ])

    const [txn] = await client.listTransactions(WINDOW)

    // toBe compares with Object.is, so a -0 result fails against 0.
    expect(txn.amount_cents).toBe(cents)
    expect(txn.balance_cents).toBe(cents)
    expect(Number.isInteger(txn.amount_cents)).toBe(true)
  })

  it.each([
    ['a third decimal place', '1.005'],
    ['an exponent', '1e2'],
    ['a negative exponent', '-1.5E-1'],
  ])(
    'refuses %s as bad_response naming the field, not the value',
    async (_label, amount) => {
      const { client } = clientWith([
        page([settledItem('trans_fixture_bad', amount)]),
      ])

      const error = await rejection(client.listTransactions(WINDOW))

      expect(error.code).toBe('bad_response')
      expect(error.message).toBe(
        'transaction.amount is missing or not an amount',
      )
      expect(error.message).not.toContain(amount)
    },
  )

  it.each([
    // Without the string guard, `["5"]` coerces to "5", passes the pattern
    // and comes out as "out of range". `true` coerces to "true", which the
    // pattern refuses with this same message, so it pins wording, not the guard.
    ['a one-item list of text', '["5"]'],
    ['a boolean', 'true'],
  ])(
    'refuses an amount that is %s as bad_response, naming the field',
    async (_label, amount) => {
      const { client } = clientWith([
        page([settledItem('trans_fixture_type', amount)]),
      ])

      const error = await rejection(client.listTransactions(WINDOW))

      expect(error).toMatchObject({
        code: 'bad_response',
        message: 'transaction.amount is missing or not an amount',
      })
    },
  )

  it.each([
    ['a leading zero', '01'],
    ['a trailing point', '1.'],
    ['a bare point', '.5'],
    ['a plus sign', '+1'],
  ])('refuses %s as a body that is not JSON', async (_label, amount) => {
    const { client } = clientWith([
      page([settledItem('trans_fixture_bad', amount)]),
    ])

    const error = await rejection(client.listTransactions(WINDOW))

    expect(error.code).toBe('bad_response')
    expect(error.status).toBe(200)
    expect(error.message).toBe(
      'Akahu returned a body that is not JSON on /v1/transactions',
    )
  })

  it.each([
    ['leading zeros', '"0019.99"'],
    ['a single leading zero', '"01"'],
  ])(
    'refuses a quoted amount with %s, as a bare number could not have it',
    async (_label, amount) => {
      const { client } = clientWith([
        page([settledItem('trans_fixture_quoted', amount)]),
      ])

      const error = await rejection(client.listTransactions(WINDOW))

      expect(error.code).toBe('bad_response')
      expect(error.message).toBe(
        'transaction.amount is missing or not an amount',
      )
    },
  )

  it('refuses an amount too large to be exact in cents', async () => {
    const { client } = clientWith([
      page([settledItem('trans_fixture_big', '123456789012345678.99')]),
    ])

    const error = await rejection(client.listTransactions(WINDOW))

    expect(error.code).toBe('bad_response')
    expect(error.message).toBe('transaction.amount is out of range')
  })

  it('refuses a missing amount on a settled item', async () => {
    const item = settledItem('trans_fixture_noamount').replace(
      /,"amount":[^,}]+/,
      '',
    )
    expect(item).not.toContain('"amount"')
    const { client } = clientWith([page([item])])

    const error = await rejection(client.listTransactions(WINDOW))

    expect(error.message).toBe('transaction.amount is missing or not an amount')
  })

  it('gives integer cents in every *_cents field of every fixture', async () => {
    const accounts = await clientWith([
      fixture('akahu-accounts.json'),
    ]).client.listAccounts()
    const settled = await clientWith([
      singlePageTransactions(),
    ]).client.listTransactions(WINDOW)
    const pending = await clientWith([
      fixture('akahu-pending.json'),
    ]).client.listPendingTransactions()
    const settledFull = await clientWith([
      fixture('akahu-transactions-full.json'),
    ]).client.listTransactions(WINDOW)
    const pendingFull = await clientWith([
      fixture('akahu-pending-full.json'),
    ]).client.listPendingTransactions()

    const values = [
      ...accounts,
      ...settled,
      ...pending,
      ...settledFull,
      ...pendingFull,
    ].flatMap(centsValues)
    expect(values.length).toBeGreaterThan(0)
    // The conversion amounts, nested two objects deep, are among them.
    expect(values).toEqual(expect.arrayContaining([1234, 456]))
    for (const value of values) {
      expect(value === null || Number.isInteger(value)).toBe(true)
    }
  })
})

describe('reading the body exactly', () => {
  it('leaves digits, quotes and escapes inside strings untouched', async () => {
    const { client } = clientWith([singlePageTransactions()])

    const settled = await client.listTransactions(WINDOW)

    expect(settled[1].description).toBe('Pay "Example" 12.50')
    expect(settled[0].description).toBe('EXAMPLE CAFE 12 HIGH ST')
  })

  it('keeps digits after an odd number of escaped quotes inside the string', async () => {
    // An even number of `\"` pairs up, so a tokenizer that ends a string at
    // any quote still re-pairs them; an odd number leaves `12.50` outside its
    // string, where it would be quoted and the body would stop parsing.
    const item = settledItem('trans_fixture_escape').replace(
      '"description":"Example inline"',
      '"description":"x\\"y 12.50"',
    )
    expect(item).toContain('"description":"x\\"y 12.50"')
    const { client } = clientWith([page([item])])

    const [txn] = await client.listTransactions(WINDOW)

    expect(txn.description).toBe('x"y 12.50')
  })

  it.each([
    ['truncated', '{"success":true,"items":['],
    ['not JSON at all', '<html>gateway</html>'],
    ['empty', ''],
    ['a numeric key', '{"success":true,"items":[],1:2}'],
  ])('rejects a %s body as bad_response', async (_label, body) => {
    const { client } = clientWith([body])

    const error = await rejection(client.listAccounts())

    expect(error.code).toBe('bad_response')
    expect(error.status).toBe(200)
  })

  it.each([
    ['ends in a quote', `{"success":true,"items":["${'\\"'.repeat(100_000)}`],
    // A lone trailing `\`: an escape that needs a character after the
    // backslash (`\\[\s\S]`) rescans this body from every quote too.
    [
      'ends in a lone backslash',
      `{"success":true,"items":["${'\\"'.repeat(100_000)}\\`,
    ],
  ])(
    'rejects an unterminated string of escaped quotes in one pass (%s)',
    async (_label, body) => {
      // The tokenizer this replaced, whose escape was `\\.`, could not end a
      // string on the backslash before a quote, so it rescanned the rest of
      // this 200 kB body from every quote in it: measured at about eight
      // seconds, against well under a millisecond now. The limit is far from
      // both so a slow CI machine cannot flip it.
      const { client } = clientWith([body])

      const started = performance.now()
      const error = await rejection(client.listAccounts())

      expect(error.code).toBe('bad_response')
      expect(performance.now() - started).toBeLessThan(1_000)
    },
  )

  it.each([
    ['success is false', '{"success":false,"items":[]}'],
    ['success is missing', '{"items":[]}'],
    ['items is not a list', '{"success":true,"items":{}}'],
    ['the body is a list', '[]'],
  ])('rejects an envelope where %s', async (_label, body) => {
    const { client } = clientWith([body])

    await expect(client.listAccounts()).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})

describe('accounts', () => {
  it('maps each account with a pinned key set', async () => {
    const { client } = clientWith([fixture('akahu-accounts.json')])

    const accounts = await client.listAccounts()

    expect(accounts).toHaveLength(3)
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual([...ACCOUNT_KEYS].sort())
    }
    expect(accounts[0]).toEqual({
      id: 'acc_fixture0001everyday',
      name: 'Fixture Everyday',
      type: 'CHECKING',
      status: 'ACTIVE',
      connection_id: 'conn_fixture0001',
      connection_name: 'Example Bank',
      formatted_account: 'XX-XXXX-XXXXXXX-XX',
      currency: 'NZD',
      balance_current_cents: 123456,
      balance_available_cents: 118456,
      balance_limit_cents: null,
      refreshed_balance: '2026-10-24T20:15:00.000Z',
      refreshed_meta: '2026-10-24T20:15:01.000Z',
      refreshed_transactions: '2026-10-24T20:15:02.000Z',
    })
  })

  it('gives only the credit card a limit, and keeps its negative balance', async () => {
    const { client } = clientWith([fixture('akahu-accounts.json')])

    const accounts = await client.listAccounts()

    expect(
      accounts.map((a) => [
        a.type,
        a.balance_current_cents,
        a.balance_available_cents,
        a.balance_limit_cents,
      ]),
    ).toEqual([
      ['CHECKING', 123456, 118456, null],
      ['SAVINGS', 150000, 150000, null],
      ['CREDITCARD', -43217, 456783, 500000],
    ])
  })

  it('gives null for an account without the optional fields', async () => {
    const item =
      '{"_id":"acc_fixture_bare","name":"Fixture Bare","type":"SAVINGS","status":"ACTIVE","connection":{"_id":"conn_fixture_bare","name":"Example Bank"},"balance":{"current":10}}'
    const { client } = clientWith([page([item])])

    const [account] = await client.listAccounts()

    expect(Object.keys(account).sort()).toEqual([...ACCOUNT_KEYS].sort())
    expect(account).toMatchObject({
      balance_current_cents: 1000,
      balance_available_cents: null,
      balance_limit_cents: null,
      currency: null,
      formatted_account: null,
      refreshed_balance: null,
      refreshed_meta: null,
      refreshed_transactions: null,
    })
  })

  it.each([
    ['_id', /"_id":"acc_fixture_bare",/, 'account._id is missing or not text'],
    [
      'balance.current',
      /"current":10/,
      'account.balance.current is missing or not an amount',
    ],
    [
      'connection',
      /"connection":\{[^}]*\},/,
      'account.connection is not an object',
    ],
    ['balance', /,"balance":\{[^}]*\}/, 'account.balance is not an object'],
  ])('rejects an account missing %s', async (_label, cut, message) => {
    const item =
      '{"_id":"acc_fixture_bare","name":"Fixture Bare","type":"SAVINGS","status":"ACTIVE","connection":{"_id":"conn_fixture_bare","name":"Example Bank"},"balance":{"current":10}}'
    const broken = item.replace(cut, '')
    expect(broken).not.toBe(item)
    const { client } = clientWith([page([broken])])

    await expect(client.listAccounts()).rejects.toMatchObject({
      code: 'bad_response',
      message,
    })
  })
})

describe('settled transactions', () => {
  it('maps every item with a pinned key set and status settled', async () => {
    const { client } = clientWith([singlePageTransactions()])

    const settled = await client.listTransactions(WINDOW)

    expect(settled).toHaveLength(8)
    for (const txn of settled) {
      expect(Object.keys(txn).sort()).toEqual([...SETTLED_KEYS].sort())
      expect(txn.status).toBe('settled')
    }
    expect(settled.map((t) => [t.type, t.amount_cents])).toEqual([
      ['EFTPOS', -1999],
      ['CREDIT', 250000],
      ['DIRECT DEBIT', -230],
      ['PAYMENT', -7],
      ['STANDING ORDER', -15000],
      ['TRANSFER', 0],
      ['EFTPOS', 115],
      ['PAYMENT', -4567],
    ])
  })

  it('maps a full item, carrying only Akahu category and no internal fields', async () => {
    const { client } = clientWith([singlePageTransactions()])

    const [first] = await client.listTransactions(WINDOW)

    expect(first).toEqual({
      status: 'settled',
      id: 'trans_fixture0001',
      account_id: 'acc_fixture0001everyday',
      connection_id: 'conn_fixture0001',
      date: '2026-10-20T00:00:00.000Z',
      posted_date: '2026-10-21T00:00:00.000Z',
      created_at: '2026-10-20T03:00:00.000Z',
      updated_at: '2026-10-21T03:00:00.000Z',
      hash: 'hash_fixture0001',
      amount_cents: -1999,
      balance_cents: 121457,
      description: 'EXAMPLE CAFE 12 HIGH ST',
      type: 'EFTPOS',
      merchant: {
        id: 'merchant_fixture0001',
        name: 'Example Cafe',
        nzbn: 'fixture-nzbn-0001',
        website: 'https://example.com/cafe',
        logo: null,
      },
      meta: {
        code: 'FIXTURE',
        particulars: 'Example',
        reference: 'fixture-ref-0001',
        other_account: 'XX-XXXX-XXXXXXX-XX',
        logo: 'https://example.com/fixture-cafe-logo.png',
        card_suffix: null,
        conversion: null,
      },
      akahu_category: {
        id: 'nzfcc_fixture0001',
        name: 'Cafes and restaurants',
        group_id: 'group_fixture0001',
        group_name: 'Lifestyle',
      },
    })
    expect(Object.keys(first.merchant ?? {}).sort()).toEqual(
      [...MERCHANT_KEYS].sort(),
    )
    expect(Object.keys(first.meta ?? {}).sort()).toEqual([...META_KEYS].sort())
    expect(Object.keys(first.akahu_category ?? {}).sort()).toEqual(
      ['group_id', 'group_name', 'id', 'name'].sort(),
    )
  })

  it('gives null for each missing sub-object and for a missing balance', async () => {
    const { client } = clientWith([singlePageTransactions()])

    const byId = new Map(
      (await client.listTransactions(WINDOW)).map((t) => [t.id, t]),
    )

    expect(byId.get('trans_fixture0002')?.merchant).toBeNull()
    expect(byId.get('trans_fixture0003')?.akahu_category).toBeNull()
    expect(byId.get('trans_fixture0004')?.meta).toBeNull()
    expect(byId.get('trans_fixture0005')?.balance_cents).toBeNull()
    expect(byId.get('trans_fixture0004')?.balance_cents).toBe(371220)
  })

  it('gives null for the missing fields of a partial sub-object', async () => {
    const { client } = clientWith([singlePageTransactions()])

    const byId = new Map(
      (await client.listTransactions(WINDOW)).map((t) => [t.id, t]),
    )

    expect(byId.get('trans_fixture0007')?.merchant).toEqual({
      id: 'merchant_fixture0006',
      name: 'Example Bakery',
      nzbn: null,
      website: null,
      logo: null,
    })
    expect(byId.get('trans_fixture0008')?.akahu_category).toEqual({
      id: 'nzfcc_fixture0007',
      name: 'Supermarkets and grocery stores',
      group_id: null,
      group_name: null,
    })
  })

  it.each([
    [
      '_id',
      '"_id":"trans_fixture_req",',
      'transaction._id is missing or not text',
    ],
    [
      '_account',
      '"_account":"acc_fixture_inline",',
      'transaction._account is missing or not text',
    ],
    [
      'date',
      '"date":"2026-10-01T00:00:00.000Z",',
      'transaction.date is missing or not text',
    ],
    [
      'description',
      '"description":"Example inline",',
      'transaction.description is missing or not text',
    ],
    ['type', '"type":"EFTPOS",', 'transaction.type is missing or not text'],
  ])('rejects a settled item missing %s', async (_label, cut, message) => {
    const item = settledItem('trans_fixture_req')
    expect(item).toContain(cut)
    const { client } = clientWith([page([item.replace(cut, '')])])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message,
    })
  })

  it.each([
    [
      '_id',
      '"_id":"trans_fixture_req"',
      '"_id":""',
      'transaction._id is missing or not text',
    ],
    [
      '_account',
      '"_account":"acc_fixture_inline"',
      '"_account":""',
      'transaction._account is missing or not text',
    ],
    [
      'date',
      '"date":"2026-10-01T00:00:00.000Z"',
      '"date":""',
      'transaction.date is missing or not text',
    ],
  ])(
    'rejects a settled item whose %s is empty text',
    async (_label, field, empty, message) => {
      const item = settledItem('trans_fixture_req')
      expect(item).toContain(field)
      const { client } = clientWith([page([item.replace(field, empty)])])

      await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
        code: 'bad_response',
        message,
      })
    },
  )

  it('keeps an empty description, which identifies nothing', async () => {
    const item = settledItem('trans_fixture_blank').replace(
      '"description":"Example inline"',
      '"description":""',
    )
    expect(item).toContain('"description":""')
    const { client } = clientWith([page([item])])

    const [txn] = await client.listTransactions(WINDOW)

    expect(txn.description).toBe('')
  })

  it.each([
    ['text', '"Example"'],
    ['a list', '[]'],
  ])('rejects a merchant that is %s, not an object', async (_label, merchant) => {
    const { client } = clientWith([
      page([
        settledItem('trans_fixture_m', '-1.00', `,"merchant":${merchant}`),
      ]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.merchant is not an object',
    })
  })

  it.each([
    ['true', 'true'],
    ['an object', '{}'],
  ])('rejects an optional text field that is %s', async (_label, hash) => {
    const { client } = clientWith([
      page([settledItem('trans_fixture_h', '-1.00', `,"hash":${hash}`)]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.hash is not text',
    })
  })
})

describe('pending transactions', () => {
  it('maps items as status pending, with no id key', async () => {
    const { client } = clientWith([fixture('akahu-pending.json')])

    const pending = await client.listPendingTransactions()

    expect(pending).toHaveLength(2)
    for (const txn of pending) {
      expect(Object.keys(txn).sort()).toEqual([...PENDING_KEYS].sort())
      expect(txn.status).toBe('pending')
      expect('id' in txn).toBe(false)
    }
    expect(pending[0]).toEqual({
      status: 'pending',
      account_id: 'acc_fixture0001everyday',
      connection_id: 'conn_fixture0001',
      date: '2026-10-24T09:30:00.000Z',
      updated_at: '2026-10-24T09:31:00.000Z',
      amount_cents: -6420,
      description: 'EXAMPLE FUEL STOP 4',
      type: 'EFTPOS',
      merchant: {
        id: 'merchant_fixture0004',
        name: 'Example Fuel',
        nzbn: 'fixture-nzbn-0004',
        website: 'https://example.com/fuel',
        logo: null,
      },
      meta: {
        code: 'FIXTURE',
        particulars: 'Example',
        reference: 'fixture-ref-pending',
        other_account: 'XX-XXXX-XXXXXXX-XX',
        logo: 'https://example.com/fixture-fuel-logo.png',
        card_suffix: null,
        conversion: null,
      },
      akahu_category: {
        id: 'nzfcc_fixture0004',
        name: 'Fuel stations',
        group_id: 'group_fixture0003',
        group_name: 'Transport',
      },
    })
  })

  it('tolerates an item with only the required fields', async () => {
    const { client } = clientWith([fixture('akahu-pending.json')])

    const [, minimal] = await client.listPendingTransactions()

    expect(minimal).toEqual({
      status: 'pending',
      account_id: 'acc_fixture0003credit',
      connection_id: null,
      date: '2026-10-24T10:05:00.000Z',
      updated_at: null,
      amount_cents: -850,
      description: '',
      type: '',
      merchant: null,
      meta: null,
      akahu_category: null,
    })
  })

  it('ignores an _id on a pending item (prd-01 Ruling 1)', async () => {
    const { client } = clientWith([
      page([
        '{"_id":"trans_fixture_pending_id","_account":"acc_fixture_inline","date":"2026-10-24T00:00:00.000Z","amount":-1}',
      ]),
    ])

    const [txn] = await client.listPendingTransactions()

    expect(Object.keys(txn).sort()).toEqual([...PENDING_KEYS].sort())
    expect(JSON.stringify(txn)).not.toContain('trans_fixture_pending_id')
  })

  it.each([
    [
      'amount',
      /,?"amount":[^,}]+/,
      'pending transaction.amount is missing or not an amount',
    ],
    [
      'date',
      /,?"date":"[^"]*"/,
      'pending transaction.date is missing or not text',
    ],
    [
      '_account',
      /"_account":"[^"]*",?/,
      'pending transaction._account is missing or not text',
    ],
  ])('rejects a pending item missing %s', async (_label, cut, message) => {
    const item =
      '{"_account":"acc_fixture_inline","date":"2026-10-24T00:00:00.000Z","amount":-1}'
    const broken = item.replace(cut, '')
    expect(broken).not.toBe(item)
    const { client } = clientWith([page([broken])])

    await expect(client.listPendingTransactions()).rejects.toMatchObject({
      code: 'bad_response',
      message,
    })
  })

  it('returns an empty list for an empty response', async () => {
    const { client, calls } = clientWith(['{"success":true,"items":[]}'])

    expect(await client.listPendingTransactions()).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('follows a cursor on pending too', async () => {
    const item = (n: number) =>
      `{"_account":"acc_fixture_inline","date":"2026-10-24T00:00:00.000Z","amount":-${n}}`
    const { client, calls } = clientWith([
      page([item(1)], 'cursor_fixture_pending2'),
      page([item(2)]),
    ])

    const pending = await client.listPendingTransactions()

    expect(pending.map((p) => p.amount_cents)).toEqual([-100, -200])
    expect(calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([
      null,
      'cursor_fixture_pending2',
    ])
  })

  it('cannot be confused with a settled transaction at the type level', async () => {
    const [settled] = await clientWith([
      singlePageTransactions(),
    ]).client.listTransactions(WINDOW)
    const [pending] = await clientWith([
      fixture('akahu-pending.json'),
    ]).client.listPendingTransactions()

    // tsc fails the gate if either assignment below stops being an error.
    // @ts-expect-error a pending item has no id and is not status 'settled'
    const pendingAsSettled: SettledTransaction = pending
    // @ts-expect-error a settled item is not status 'pending'
    const settledAsPending: PendingTransaction = settled

    expect(pendingAsSettled.status).toBe('pending')
    expect(settledAsPending.status).toBe('settled')
  })
})

describe('full fields (#155, prd-01 Ruling 4)', () => {
  /** A minimal settled item carrying `extra` raw JSON members. */
  function itemWith(extra: string): string {
    return settledItem('trans_fixture_full_inline', '-1.00', extra)
  }

  async function onlySettled(extra: string): Promise<SettledTransaction> {
    const [txn] = await clientWith([page([itemWith(extra)])]).client.listTransactions(
      WINDOW,
    )
    return txn
  }

  it('maps the card suffix, conversion and merchant logo of a full item', async () => {
    const { client } = clientWith([fixture('akahu-transactions-full.json')])

    const [full] = await client.listTransactions(WINDOW)

    expect(Object.keys(full).sort()).toEqual([...SETTLED_KEYS].sort())
    expect(full.merchant).toEqual({
      id: 'merchant_fixture_full_a',
      name: 'Example Online Store',
      nzbn: 'fixture-nzbn-full-a',
      website: 'https://example.com/store',
      logo: 'https://example.com/fixture-store-logo.png',
    })
    expect(full.meta).toEqual({
      code: null,
      particulars: 'Example',
      reference: 'fixture-ref-full-a',
      other_account: null,
      logo: null,
      card_suffix: '0042',
      conversion: { amount_cents: 1234, currency: 'USD', rate: '0.6123' },
    })
    expect(Object.keys(full.merchant ?? {}).sort()).toEqual(
      [...MERCHANT_KEYS].sort(),
    )
    expect(Object.keys(full.meta ?? {}).sort()).toEqual([...META_KEYS].sort())
    expect(Object.keys(full.meta?.conversion ?? {}).sort()).toEqual(
      [...CONVERSION_KEYS].sort(),
    )
  })

  it('gives null for the parts of a conversion Akahu leaves out, and for no meta', async () => {
    const { client } = clientWith([fixture('akahu-transactions-full.json')])

    const [, currencyOnly, bare] = await client.listTransactions(WINDOW)

    expect(currencyOnly.meta?.conversion).toEqual({
      amount_cents: null,
      currency: 'AUD',
      rate: null,
    })
    expect(currencyOnly.meta?.card_suffix).toBeNull()
    expect(currencyOnly.merchant).toBeNull()
    expect(bare.meta).toBeNull()
    expect(bare.merchant?.logo).toBeNull()
  })

  it.each([
    ['an empty conversion', '{"conversion":{}}', { amount_cents: null, currency: null, rate: null }],
    ['a null conversion', '{"conversion":null}', null],
    ['no conversion', '{"code":"FIXTURE"}', null],
  ])('maps %s', async (_label, meta, conversion) => {
    const txn = await onlySettled(`,"meta":${meta}`)

    expect(txn.meta?.conversion).toEqual(conversion)
  })

  it('keeps a card suffix with a leading zero as text', async () => {
    const txn = await onlySettled(',"meta":{"card_suffix":"0123"}')

    expect(txn.meta?.card_suffix).toBe('0123')
  })

  it.each([
    ['a bare number', '0.6123', '0.6123'],
    ['quoted text', '"0.6123"', '0.6123'],
    ['zero', '0', '0'],
    ['a whole number', '2', '2'],
    ['the longest accepted text', `0.${'1'.repeat(28)}`, `0.${'1'.repeat(28)}`],
  ])('keeps a rate written as %s as its exact text', async (_label, raw, text) => {
    const txn = await onlySettled(`,"meta":{"conversion":{"rate":${raw}}}`)

    expect(txn.meta?.conversion?.rate).toBe(text)
  })

  it('reads a conversion amount in hundredths of the unit, even for a currency with none', async () => {
    // JPY has no minor unit, but conversion_amount_cents is hundredths of
    // whatever currency is named: 1500 yen is stored as 150000, the same
    // exact text-to-cents reading as every other amount. Pinned so a change
    // to per-currency scaling is a deliberate one.
    const txn = await onlySettled(
      ',"meta":{"conversion":{"amount":1500,"currency":"JPY","rate":0.0103}}',
    )

    expect(txn.meta?.conversion).toEqual({
      amount_cents: 150000,
      currency: 'JPY',
      rate: '0.0103',
    })
  })

  it('carries the same fields on a pending item', async () => {
    const { client } = clientWith([fixture('akahu-pending-full.json')])

    const [pending] = await client.listPendingTransactions()

    expect(Object.keys(pending).sort()).toEqual([...PENDING_KEYS].sort())
    expect(pending.merchant).toEqual({
      id: 'merchant_fixture_full_p',
      name: 'Example Streaming',
      nzbn: null,
      website: null,
      logo: 'https://example.com/fixture-streaming-logo.png',
    })
    expect(pending.meta).toEqual({
      code: null,
      particulars: null,
      reference: null,
      other_account: null,
      logo: null,
      card_suffix: '0077',
      conversion: { amount_cents: 456, currency: 'GBP', rate: '0.4565' },
    })
  })

  it.each([
    ['text', '"USD 12.34"'],
    ['a list', '[]'],
  ])('rejects a conversion that is %s, naming the field', async (_label, conversion) => {
    const { client } = clientWith([
      page([itemWith(`,"meta":{"conversion":${conversion}}`)]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.meta.conversion is not an object',
    })
  })

  it.each([
    // A bare 978 or 1e3 would be stored as a number by the float column.
    ['a bare number', '978'],
    ['a number as text', '"978"'],
    ['an exponent', '1e3'],
    ['two letters', '"us"'],
    ['four letters', '"USDX"'],
    ['empty text', '""'],
    ['padded text', '" USD"'],
    // `true` is refused by the letters pattern too, so this pins wording,
    // not the type guard.
    ['a boolean', 'true'],
  ])('rejects a currency that is %s, naming the field', async (_label, currency) => {
    const { client } = clientWith([
      page([itemWith(`,"meta":{"conversion":{"currency":${currency}}}`)]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.meta.conversion.currency is not a currency code',
    })
  })

  it.each([
    ['an exponent', '1e-7'],
    ['a quoted exponent', '"1e-7"'],
    ['a negative rate', '-0.5'],
    ['a leading zero', '"01.5"'],
    ['a trailing point', '"1."'],
    ['words', '"abc"'],
    ['empty text', '""'],
    ['text one past the longest accepted', `0.${'1'.repeat(29)}`],
    ['a list', '[1]'],
  ])('rejects a rate that is %s, naming the field', async (_label, rate) => {
    const { client } = clientWith([
      page([itemWith(`,"meta":{"conversion":{"rate":${rate}}}`)]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.meta.conversion.rate is not a rate',
    })
  })

  it('rejects a conversion amount with a third decimal place, as for any amount', async () => {
    const { client } = clientWith([
      page([itemWith(',"meta":{"conversion":{"amount":1.005}}')]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.meta.conversion.amount is missing or not an amount',
    })
  })

  // A bare number reaches the client as its text and is kept verbatim, as
  // for every optional text field; only a value that is not text is refused.
  it.each([
    ['card_suffix', ',"meta":{"card_suffix":true}', 'transaction.meta.card_suffix is not text'],
    ['card_suffix', ',"meta":{"card_suffix":{}}', 'transaction.meta.card_suffix is not text'],
    ['merchant.logo', ',"merchant":{"logo":true}', 'transaction.merchant.logo is not text'],
    ['merchant.logo', ',"merchant":{"logo":{}}', 'transaction.merchant.logo is not text'],
  ])('rejects a %s that is not text', async (_label, extra, message) => {
    const { client } = clientWith([page([itemWith(extra)])])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message,
    })
  })

  it('rejects a malformed conversion on a pending item, naming the field', async () => {
    const { client } = clientWith([
      page([
        '{"_account":"acc_fixture_inline","date":"2026-10-24T00:00:00.000Z","amount":-1,"meta":{"conversion":{"currency":"978"}}}',
      ]),
    ])

    await expect(client.listPendingTransactions()).rejects.toMatchObject({
      code: 'bad_response',
      message:
        'pending transaction.meta.conversion.currency is not a currency code',
    })
  })
})

describe('pagination (prd-01 Ruling 2)', () => {
  it('follows cursor.next to a second page and returns both, in order', async () => {
    const { client, calls } = clientWith([
      fixture('akahu-transactions.json'),
      page([
        settledItem('trans_fixture0009'),
        settledItem('trans_fixture0010'),
      ]),
    ])

    const settled = await client.listTransactions(WINDOW)

    expect(settled.map((t) => t.id)).toEqual([
      'trans_fixture0001',
      'trans_fixture0002',
      'trans_fixture0003',
      'trans_fixture0004',
      'trans_fixture0005',
      'trans_fixture0006',
      'trans_fixture0007',
      'trans_fixture0008',
      'trans_fixture0009',
      'trans_fixture0010',
    ])
    expect(
      calls.map((c) => ({
        path: c.url.pathname,
        start: c.url.searchParams.get('start'),
        end: c.url.searchParams.get('end'),
        cursor: c.url.searchParams.get('cursor'),
      })),
    ).toEqual([
      {
        path: '/v1/transactions',
        start: '2026-09-25T00:00:00.000Z',
        end: '2026-10-25T00:00:00.000Z',
        cursor: null,
      },
      {
        path: '/v1/transactions',
        start: '2026-09-25T00:00:00.000Z',
        end: '2026-10-25T00:00:00.000Z',
        cursor: 'cursor_fixture_page2',
      },
    ])
  })

  it('makes one request when cursor.next is null', async () => {
    const { client, calls } = clientWith([singlePageTransactions()], () =>
      page([settledItem('trans_fixture_extra')]),
    )

    const settled = await client.listTransactions(WINDOW)

    expect(calls).toHaveLength(1)
    expect(settled).toHaveLength(8)
  })

  it('makes one request when the envelope has no cursor', async () => {
    const { client, calls } = clientWith(
      [`{"success":true,"items":[${settledItem('trans_fixture_only')}]}`],
      () => page([settledItem('trans_fixture_extra')]),
    )

    expect(await client.listTransactions(WINDOW)).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['an empty string', '""'],
    ['true', 'true'],
    ['an object', '{}'],
  ])('rejects a cursor.next that is %s', async (_label, next) => {
    const body = `{"success":true,"items":[],"cursor":{"next":${next}}}`
    const { client } = clientWith([body])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: '/v1/transactions response.cursor.next is not a cursor',
    })
  })

  it('rejects a cursor that repeats instead of looping', async () => {
    const { client, calls } = clientWith([], () =>
      page([settledItem('trans_fixture_loop')], 'cursor_fixture_same'),
    )

    const error = await rejection(client.listTransactions(WINDOW))

    expect(error.code).toBe('bad_response')
    expect(error.message).toBe('/v1/transactions repeated a cursor')
    expect(calls).toHaveLength(2)
  })

  it('rejects a listing that never ends within MAX_PAGES', async () => {
    const { client, calls } = clientWith([], (n) =>
      page([settledItem(`trans_fixture_p${n}`)], `cursor_fixture_${n}`),
    )

    const error = await rejection(client.listTransactions(WINDOW))

    expect(error.code).toBe('bad_response')
    expect(error.message).toBe(
      `/v1/transactions did not end within ${MAX_PAGES} pages`,
    )
    expect(calls).toHaveLength(MAX_PAGES)
  })

  it('rejects a failure on page 2 instead of returning page 1 alone', async () => {
    const { client, calls } = clientWith([
      fixture('akahu-transactions.json'),
      { status: 503, body: '' },
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'server',
      status: 503,
    })
    expect(calls).toHaveLength(2)
  })

  it('rejects a malformed item on page 2 instead of returning page 1 alone', async () => {
    const { client } = clientWith([
      fixture('akahu-transactions.json'),
      page([settledItem('trans_fixture_bad', '"lots"')]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})

describe('an open window (issue #139)', () => {
  // Pages linked by cursor, so every page after the first is checked.
  function threePages(): Reply[] {
    return [
      page([settledItem('trans_fixture_p1')], 'cursor_fixture_a'),
      page([settledItem('trans_fixture_p2')], 'cursor_fixture_b'),
      page([settledItem('trans_fixture_p3')]),
    ]
  }

  /** The query one request carried: its parameter names, bounds and cursor. */
  function queryOf(call: RecordedCall) {
    const params = call.url.searchParams
    return {
      keys: [...params.keys()].sort(),
      start: params.get('start'),
      end: params.get('end'),
      cursor: params.get('cursor'),
    }
  }

  it('sends neither start nor end on every page when neither is given', async () => {
    const { client, calls } = clientWith(threePages())

    const settled = await client.listTransactions({})

    expect(settled.map((t) => t.id)).toEqual([
      'trans_fixture_p1',
      'trans_fixture_p2',
      'trans_fixture_p3',
    ])
    expect(calls.map(queryOf)).toEqual([
      { keys: [], start: null, end: null, cursor: null },
      {
        keys: ['cursor'],
        start: null,
        end: null,
        cursor: 'cursor_fixture_a',
      },
      {
        keys: ['cursor'],
        start: null,
        end: null,
        cursor: 'cursor_fixture_b',
      },
    ])
  })

  it('sends end and no start on every page when only end is given', async () => {
    const { client, calls } = clientWith(threePages())

    await client.listTransactions({ end: WINDOW.end })

    const end = WINDOW.end.toISOString()
    expect(calls.map(queryOf)).toEqual([
      { keys: ['end'], start: null, end, cursor: null },
      { keys: ['cursor', 'end'], start: null, end, cursor: 'cursor_fixture_a' },
      { keys: ['cursor', 'end'], start: null, end, cursor: 'cursor_fixture_b' },
    ])
  })

  it('sends start and no end on every page when only start is given', async () => {
    const { client, calls } = clientWith(threePages())

    await client.listTransactions({ start: WINDOW.start })

    const start = WINDOW.start.toISOString()
    expect(calls.map(queryOf)).toEqual([
      { keys: ['start'], start, end: null, cursor: null },
      { keys: ['cursor', 'start'], start, end: null, cursor: 'cursor_fixture_a' },
      { keys: ['cursor', 'start'], start, end: null, cursor: 'cursor_fixture_b' },
    ])
  })

  it.each([
    ['an invalid lone start', { start: new Date('nope') }],
    ['an invalid lone end', { end: new Date(Number.NaN) }],
  ])(
    'refuses %s as invalid_range before any request',
    async (_label, range) => {
      const { client, calls } = clientWith([singlePageTransactions()])

      const error = await rejection(client.listTransactions(range))

      expect(error.code).toBe('invalid_range')
      expect(error.status).toBeNull()
      expect(error.message).toBe(
        'Akahu transaction window is invalid or ends before it starts',
      )
      expect(calls).toHaveLength(0)
    },
  )
})

describe('requests', () => {
  const EVERY_CALL: [string, Reply, (c: AkahuClient) => Promise<unknown>][] = [
    ['/v1/accounts', fixture('akahu-accounts.json'), (c) => c.listAccounts()],
    [
      '/v1/transactions',
      singlePageTransactions(),
      (c) => c.listTransactions(WINDOW),
    ],
    [
      '/v1/transactions/pending',
      fixture('akahu-pending.json'),
      (c) => c.listPendingTransactions(),
    ],
  ]

  it.each(EVERY_CALL)(
    '%s is a GET to Akahu with both credentials and no body',
    async (path, reply, run) => {
      const { client, calls } = clientWith([reply])

      await run(client)

      expect(calls).toHaveLength(1)
      const [{ url, init }] = calls
      expect(url.origin).toBe('https://api.akahu.io')
      expect(url.pathname).toBe(path)
      expect(Object.keys(init).sort()).toEqual(
        ['headers', 'method', 'redirect', 'signal'].sort(),
      )
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect((init as { body?: unknown }).body).toBeUndefined()
      expect(init.headers).toEqual({
        Authorization: `Bearer ${SENTINEL_TOKEN}`,
        'X-Akahu-Id': SENTINEL_APP_ID,
        Accept: 'application/json',
      })
      expect(Object.keys(init.headers).sort()).toEqual(
        ['Accept', 'Authorization', 'X-Akahu-Id'].sort(),
      )
    },
  )

  it('sends no query to accounts or pending', async () => {
    const accounts = clientWith([fixture('akahu-accounts.json')])
    const pending = clientWith([fixture('akahu-pending.json')])

    await accounts.client.listAccounts()
    await pending.client.listPendingTransactions()

    expect([...accounts.calls[0].url.searchParams.keys()]).toEqual([])
    expect([...pending.calls[0].url.searchParams.keys()]).toEqual([])
  })

  it('uses globalThis.fetch, looked up per request, when none is given', async () => {
    const recorder = recordingFetch([fixture('akahu-accounts.json')])
    const client = createAkahuClient({
      token: SENTINEL_TOKEN,
      appId: SENTINEL_APP_ID,
    })
    vi.stubGlobal('fetch', recorder.fetch)
    try {
      await client.listAccounts()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(recorder.calls).toHaveLength(1)
  })
})

describe('timeouts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts a request after 30 seconds and rejects as network', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const client = clientFetching(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal
          init.signal.addEventListener('abort', () =>
            reject(new Error(`aborted ${SENTINEL_TOKEN}`)),
          )
        }),
    )

    const outcome = rejection(client.listAccounts())
    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome

    expect(signal?.aborted).toBe(true)
    expect(error.code).toBe('network')
    expect(error.status).toBeNull()
    expect(error.message).toBe('Akahu request timed out on /v1/accounts')
  })

  it('clears its timer once the request finishes', async () => {
    vi.useFakeTimers()
    const { client } = clientWith([fixture('akahu-accounts.json')])

    await client.listAccounts()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its timer when the request fails', async () => {
    vi.useFakeTimers()
    const { client } = clientWith([{ status: 500 }])

    await client.listAccounts().catch(() => undefined)

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('typed errors', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [599, 'server'],
    [404, 'http'],
    [400, 'http'],
  ])('rejects a %d as %s with the status', async (status, code) => {
    const { client } = clientWith([{ status, body: '{"success":false}' }])

    const error = await rejection(client.listAccounts())

    expect({
      code: error.code,
      status: error.status,
      name: error.name,
    }).toEqual({
      code,
      status,
      name: 'AkahuError',
    })
    expect(error.message).toContain(String(status))
  })

  it('rejects a 600 as http, not server', async () => {
    // `new Response` refuses a status outside 200..599, so the status is
    // set on the instance; `ok` is already false from the 599 underneath.
    const client = clientFetching(async () =>
      Object.defineProperty(new Response('', { status: 599 }), 'status', {
        value: 600,
      }),
    )

    const error = await rejection(client.listAccounts())

    expect({ code: error.code, status: error.status }).toEqual({
      code: 'http',
      status: 600,
    })
    expect(error.message).toBe('Akahu responded 600 on /v1/accounts')
  })

  it('rejects when fetch itself fails, as network with no cause', async () => {
    const client = clientFetching(async () => {
      throw new TypeError(`fetch failed for ${SENTINEL_TOKEN}`)
    })

    const error = await rejection(client.listTransactions(WINDOW))

    expect(error.code).toBe('network')
    expect(error.status).toBeNull()
    expect('cause' in error).toBe(false)
    expect(error.message).toBe(
      'Akahu request failed before a full response arrived on /v1/transactions',
    )
  })

  it('rejects when the body breaks off mid-read, as network', async () => {
    const client = clientFetching(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error(`reset ${SENTINEL_TOKEN}`))
            },
          }),
          { status: 200 },
        ),
    )

    const error = await rejection(client.listAccounts())

    expect(error.code).toBe('network')
    expect(error.status).toBeNull()
    expect('cause' in error).toBe(false)
  })

  it.each([
    ['an invalid start', { start: new Date('nope'), end: WINDOW.end }],
    ['an invalid end', { start: WINDOW.start, end: new Date(Number.NaN) }],
    ['a start after the end', { start: WINDOW.end, end: WINDOW.start }],
  ])(
    'rejects %s as invalid_range without a request',
    async (_label, range) => {
      const { client, calls } = clientWith([singlePageTransactions()])

      const error = await rejection(client.listTransactions(range))

      expect(error.code).toBe('invalid_range')
      expect(error.status).toBeNull()
      expect(error.message).toBe(
        'Akahu transaction window is invalid or ends before it starts',
      )
      expect(calls).toHaveLength(0)
    },
  )

  it('accepts a window that starts and ends at the same instant', async () => {
    const { client, calls } = clientWith([singlePageTransactions()])

    await client.listTransactions({ start: WINDOW.end, end: WINDOW.end })

    expect(calls).toHaveLength(1)
  })

  it('cancels the unread body of an error response', async () => {
    const cancelled: unknown[] = []
    const client = clientFetching(
      async () =>
        new Response(
          new ReadableStream({
            cancel(reason) {
              cancelled.push(reason)
            },
          }),
          { status: 503 },
        ),
    )

    const error = await rejection(client.listAccounts())

    expect(error.code).toBe('server')
    expect(error.status).toBe(503)
    expect(cancelled).toHaveLength(1)
  })

  it('keeps the status error when cancelling the body fails', async () => {
    let cancelCalls = 0
    const client = clientFetching(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelCalls += 1
              throw new Error(`cancel failed ${SENTINEL_TOKEN}`)
            },
          }),
          { status: 401 },
        ),
    )

    const error = await rejection(client.listAccounts())
    // Let a cancel rejection surface; vitest fails the run if it is unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancelCalls).toBe(1)
    expect(error.code).toBe('unauthorized')
    expect(error.status).toBe(401)
    expect(error.message).not.toContain(SENTINEL_TOKEN)
  })

  it.each([
    ['token', { token: '', appId: SENTINEL_APP_ID }],
    ['app id', { token: SENTINEL_TOKEN, appId: '' }],
    ['token (whitespace)', { token: '   ', appId: SENTINEL_APP_ID }],
  ])(
    'rejects an empty %s as missing_credentials without a request',
    async (_label, credentials) => {
      const recorder = recordingFetch([fixture('akahu-accounts.json')])
      const client = createAkahuClient({
        ...credentials,
        fetch: recorder.fetch,
      })

      const error = await rejection(client.listAccounts())

      expect(error.code).toBe('missing_credentials')
      expect(error.status).toBeNull()
      expect(recorder.calls).toHaveLength(0)
    },
  )
})

describe('no secret reaches an error or a log line', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const OUTCOMES: [string, () => AkahuClient][] = [
    ['success', () => clientWith([fixture('akahu-accounts.json')]).client],
    [
      '401 whose body echoes both credentials',
      () =>
        clientWith([
          {
            status: 401,
            body: `{"success":false,"message":"bad token ${SENTINEL_TOKEN} for ${SENTINEL_APP_ID}"}`,
          },
        ]).client,
    ],
    [
      '500 whose body echoes both credentials',
      () =>
        clientWith([
          { status: 500, body: `${SENTINEL_TOKEN} ${SENTINEL_APP_ID}` },
        ]).client,
    ],
    [
      'network failure whose error carries both credentials',
      () =>
        clientFetching(async () => {
          throw new TypeError(`connect ${SENTINEL_TOKEN} ${SENTINEL_APP_ID}`)
        }),
    ],
    [
      'missing token while the app id is set',
      () =>
        createAkahuClient({
          token: '',
          appId: SENTINEL_APP_ID,
          fetch: recordingFetch([]).fetch,
        }),
    ],
    [
      'missing app id while the token is set',
      () =>
        createAkahuClient({
          token: SENTINEL_TOKEN,
          appId: ' ',
          fetch: recordingFetch([]).fetch,
        }),
    ],
    [
      'malformed body containing both credentials',
      () => clientWith([`{"${SENTINEL_TOKEN}": ${SENTINEL_APP_ID}`]).client,
    ],
    [
      'bad_response field holding a credential',
      () =>
        clientWith([
          page([
            `{"_id":"acc_fixture_leak","name":"Fixture","type":"SAVINGS","status":"ACTIVE","connection":{"_id":"conn_fixture_leak","name":"Example Bank"},"balance":{"current":"${SENTINEL_TOKEN}"}}`,
          ]),
        ]).client,
    ],
  ]

  it.each(OUTCOMES)('on %s', async (label, makeClient) => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
    const consoleSpies = methods.map((m) => vi.spyOn(console, m))
    const stdout = vi.spyOn(process.stdout, 'write')
    const stderr = vi.spyOn(process.stderr, 'write')

    const outcome = await makeClient()
      .listAccounts()
      .catch((e: unknown) => e)

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    const written = [...stdout.mock.calls, ...stderr.mock.calls]
      .map((args) => String(args[0]))
      .join('\n')
    expect(written).not.toContain(SENTINEL_TOKEN)
    expect(written).not.toContain(SENTINEL_APP_ID)

    if (label === 'success') {
      expect(Array.isArray(outcome)).toBe(true)
      return
    }
    expect(outcome).toBeInstanceOf(AkahuError)
    const error = outcome as AkahuError
    const serialised = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`
    expect(serialised).not.toContain(SENTINEL_TOKEN)
    expect(serialised).not.toContain(SENTINEL_APP_ID)
  })
})

describe('the client source', () => {
  /** Production files under server/sync/, tests and fixtures excluded. */
  function productionSources(dir = syncDir): Map<string, string> {
    const sources = new Map<string, string>()
    for (const name of readdirSync(dir)) {
      const full = Path.join(dir, name)
      if (name === '__tests__' || name === '__fixtures__') continue
      if (statSync(full).isDirectory()) {
        for (const [k, v] of productionSources(full)) sources.set(k, v)
      } else if (/\.(ts|js)$/.test(name)) {
        sources.set(Path.relative(syncDir, full), readFileSync(full, 'utf8'))
      }
    }
    return sources
  }

  const client = readFileSync(Path.join(syncDir, 'akahu-client.ts'), 'utf8')

  it('has exactly one request site', () => {
    expect(client.match(/\bfetch\s*\(/g)).toHaveLength(1)
  })

  it.each([
    ['a float parser', /parseFloat/],
    ['a Number() conversion', /\bNumber\s*\(/],
    ['rounding', /Math\.round/],
    ['the float helper', /dollarsToCents/],
    ['the environment', /process\.env|import\.meta\.env/],
    ['console', /\bconsole\./],
    [
      'an import from xero, db or models',
      /from\s+['"][^'"]*\/(xero|db|models)\//,
    ],
  ])('uses no %s', (_label, pattern) => {
    expect(pattern.exec(client)?.[0] ?? null).toBeNull()
  })

  it('has no file under server/sync/ that multiplies or divides by 100', () => {
    const sources = productionSources()
    expect([...sources.keys()].sort()).toContain('akahu-client.ts')
    for (const [name, text] of sources) {
      expect({
        name,
        hit: /\*\s*100|\/\s*100/.exec(text)?.[0] ?? null,
      }).toEqual({
        name,
        hit: null,
      })
    }
  })
})

describe('the fixtures are scrubbed (this repository is public)', () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))

  it('exist', () => {
    expect(files.sort()).toEqual(
      [
        'akahu-accounts.json',
        'akahu-pending-full.json',
        'akahu-pending.json',
        'akahu-transactions-full.json',
        'akahu-transactions.json',
      ].sort(),
    )
  })

  it.each(files)('%s has no account number', (file) => {
    expect(
      /\d{2}-\d{4}-\d{7}-\d{2}/.exec(fixture(file))?.[0] ?? null,
    ).toBeNull()
  })

  it.each(files)('%s has only invented ids', (file) => {
    const ids = [...fixture(file).matchAll(/"_\w+":\s*"([^"]*)"/g)].map(
      (m) => m[1],
    )
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toContain('fixture')
  })

  it.each(files)(
    '%s names only Example merchants and no real party',
    (file) => {
      const text = fixture(file)
      const names: string[] = []
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk)
        else if (typeof value === 'object' && value !== null) {
          for (const [key, inner] of Object.entries(value)) {
            if (
              key === 'merchant' &&
              typeof inner === 'object' &&
              inner !== null
            ) {
              names.push(String((inner as { name?: unknown }).name))
            }
            walk(inner)
          }
        }
      }
      walk(JSON.parse(text))
      for (const name of names) expect(name.startsWith('Example')).toBe(true)
      expect(
        /\b(bnz|asb|anz|westpac|kiwibank|strawb|hannah|smith)\b/i.exec(
          text,
        )?.[0] ?? null,
      ).toBeNull()
    },
  )

  /**
   * Every `name` and `description` text in a fixture, with the key of the
   * object it sits in (`items` for an account or a transaction itself).
   */
  function namedTexts(file: string) {
    const found: { key: string; under: string; text: string }[] = []
    const walk = (value: unknown, under: string): void => {
      if (Array.isArray(value)) value.forEach((inner) => walk(inner, under))
      else if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if (
            (key === 'name' || key === 'description') &&
            typeof inner === 'string'
          ) {
            found.push({ key, under, text: inner })
          }
          walk(inner, key)
        }
      }
    }
    walk(JSON.parse(fixture(file)), 'root')
    return found
  }

  /** Akahu's category vocabulary is generic and names nobody. */
  const CATEGORY_NAMES = new Set([
    'Bank fees',
    'Cafes and restaurants',
    'Fuel stations',
    'Housing',
    'Income',
    'Lifestyle',
    'Professional services',
    'Rent',
    'Salary',
    'Supermarkets and grocery stores',
    'Transfers',
    'Transport',
  ])
  const isCategory = (under: string) =>
    under === 'category' || under === 'personal_finance'

  it('looks at descriptions, account, connection, merchant and category names', () => {
    const roles = new Set(
      files.flatMap((file) =>
        namedTexts(file).map(({ key, under }) => `${under}.${key}`),
      ),
    )

    expect([...roles].sort()).toEqual(
      [
        'items.description',
        'items.name',
        'connection.name',
        'merchant.name',
        'category.name',
        'personal_finance.name',
      ].sort(),
    )
  })

  it.each(files)(
    '%s marks every description and name as invented, or uses a generic category',
    (file) => {
      const offenders = namedTexts(file).filter(({ under, text }) =>
        isCategory(under)
          ? !CATEGORY_NAMES.has(text)
          : !/\b(example|fixture)\b/i.test(text),
      )

      expect(offenders).toEqual([])
    },
  )
})

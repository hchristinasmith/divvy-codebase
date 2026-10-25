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

    const values = [...accounts, ...settled, ...pending].flatMap(centsValues)
    expect(values.length).toBeGreaterThan(0)
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
      },
      meta: {
        code: 'FIXTURE',
        particulars: 'Example',
        reference: 'fixture-ref-0001',
        other_account: 'XX-XXXX-XXXXXXX-XX',
        logo: 'https://example.com/fixture-cafe-logo.png',
      },
      akahu_category: {
        id: 'nzfcc_fixture0001',
        name: 'Cafes and restaurants',
        group_id: 'group_fixture0001',
        group_name: 'Lifestyle',
      },
    })
    expect(Object.keys(first.merchant ?? {}).sort()).toEqual(
      ['id', 'name', 'nzbn', 'website'].sort(),
    )
    expect(Object.keys(first.meta ?? {}).sort()).toEqual(
      ['code', 'logo', 'other_account', 'particulars', 'reference'].sort(),
    )
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
  ])('rejects a settled item missing %s', async (_label, cut, message) => {
    const item = settledItem('trans_fixture_req')
    expect(item).toContain(cut)
    const { client } = clientWith([page([item.replace(cut, '')])])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message,
    })
  })

  it('rejects a merchant that is not an object', async () => {
    const { client } = clientWith([
      page([settledItem('trans_fixture_m', '-1.00', ',"merchant":"Example"')]),
    ])

    await expect(client.listTransactions(WINDOW)).rejects.toMatchObject({
      code: 'bad_response',
      message: 'transaction.merchant is not an object',
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
      },
      meta: {
        code: 'FIXTURE',
        particulars: 'Example',
        reference: 'fixture-ref-pending',
        other_account: 'XX-XXXX-XXXXXXX-XX',
        logo: 'https://example.com/fixture-fuel-logo.png',
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
        'akahu-pending.json',
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
})

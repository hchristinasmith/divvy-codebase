import { readdirSync, readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSync, STALE_RUN_AFTER_MS } from '../run.ts'
import { TRANSACTION_COLUMNS } from '../../db/__tests__/transactionColumns.ts'
import {
  at,
  closeDb,
  DAY_MS,
  db,
  fakeAkahu,
  fixture,
  freshDb,
  MINUTE_MS,
  NOW,
  page,
  replaceOnce,
  settledWindows,
  snapshot,
  syncRuns,
  withSettledItem,
} from './harness.ts'

// Issue #21 (prd-01 w2): a sync run upserts settled transactions on
// `akahu_id`, replaces the pending mirror, never deletes a settled row,
// never writes an account's scope or source, and runs one at a time.
// Done-when 1, 2, 3, 7 and the stale-run rule; failures are in
// run-failure.test.ts, category ownership in category-survival.test.ts.

beforeEach(async () => {
  await freshDb()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(closeDb)

const fixed = (date: Date) => () => date

const ACCOUNT_KEYS = [
  'id',
  'akahu_id',
  'source',
  'scope',
  'name',
  'formatted_account',
  'type',
  'status',
  'attributes',
  'connection_id',
  'connection_name',
  'connection_type',
  'connection_logo',
  'authorisation_id',
  'credentials_id',
  'currency',
  'balance_cents',
  'available_balance_cents',
  'credit_limit_cents',
  'refreshed_balance_at',
  'refreshed_meta_at',
  'refreshed_transactions_at',
  'created_at',
  'updated_at',
]

/** A settled item for account `acc_fixture0001everyday`, as raw JSON. */
function settledItem(id: string, description: string, amount: string): string {
  return `{"_id":"${id}","_account":"acc_fixture0001everyday","_connection":"conn_fixture0001","amount":${amount},"date":"2026-10-24T00:00:00.000Z","description":"${description}","hash":"hash_${id}","type":"EFTPOS","created_at":"2026-10-25T01:00:00.000Z","updated_at":"2026-10-25T01:00:00.000Z"}`
}

const CREDIT_PENDING =
  '{"_account":"acc_fixture0003credit","amount":-8.5,"date":"2026-10-24T10:05:00.000Z"}'

describe('a first run', () => {
  it('stores accounts, settled and pending rows as Akahu sent them, in cents', async () => {
    const result = await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })

    expect(result).toEqual({
      outcome: 'success',
      runId: 1,
      insertedCount: 8,
      updatedCount: 0,
      pendingMirroredCount: 2,
    })

    const settled = await db('transactions')
      .where({ akahu_id: 'trans_fixture0001' })
      .first()
    expect(Object.keys(settled).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
    expect(settled).toEqual({
      id: expect.any(Number),
      akahu_id: 'trans_fixture0001',
      account_id: 'acc_fixture0001everyday',
      user_id: null,
      connection_id: 'conn_fixture0001',
      created_at: '2026-10-20T03:00:00.000Z',
      updated_at: '2026-10-21T03:00:00.000Z',
      date: '2026-10-20T00:00:00.000Z',
      description: 'EXAMPLE CAFE 12 HIGH ST',
      type: 'EFTPOS',
      hash: 'hash_fixture0001',
      category_id: null,
      category_name: null,
      category_group_id: null,
      category_group_name: null,
      particulars: 'Example',
      code: 'FIXTURE',
      reference: 'fixture-ref-0001',
      other_account: 'XX-XXXX-XXXXXXX-XX',
      logo: 'https://example.com/fixture-cafe-logo.png',
      conversion_currency: null,
      conversion_rate: null,
      card_suffix: null,
      merchant_id: 'merchant_fixture0001',
      merchant_name: 'Example Cafe',
      merchant_website: 'https://example.com/cafe',
      merchant_logo: null,
      amount_cents: -1999,
      balance_cents: 121457,
      conversion_amount_cents: null,
      category: 'Cafes and restaurants',
      category_source: 'akahu',
      status: 'settled',
      source: 'akahu',
      akahu_category_id: 'nzfcc_fixture0001',
      akahu_category_name: 'Cafes and restaurants',
      akahu_category_group_id: 'group_fixture0001',
      akahu_category_group_name: 'Lifestyle',
      posted_date: '2026-10-21T00:00:00.000Z',
      merchant_nzbn: 'fixture-nzbn-0001',
    })

    const amounts = await db('transactions')
      .where({ status: 'settled' })
      .orderBy('akahu_id')
      .pluck('amount_cents')
    expect(amounts).toEqual([-1999, 250000, -230, -7, -15000, 0, 115, -4567])

    const run = (await syncRuns())[0]
    expect(run).toEqual({
      id: 1,
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      outcome: 'success',
      inserted_count: 8,
      updated_count: 0,
      pending_mirrored_count: 2,
      error_message: null,
    })
  })

  it('stores pending rows with status pending and no id, hash, balance or category', async () => {
    await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })

    const pending = await db('transactions')
      .where({ status: 'pending' })
      .orderBy('account_id')
      .select()
    expect(pending).toHaveLength(2)
    for (const row of pending) {
      expect(Object.keys(row).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
    }
    const blank = Object.fromEntries(
      TRANSACTION_COLUMNS.map((column) => [column, null]),
    )
    // The fixture's first pending item carries a category; it is dropped.
    expect(pending[0]).toEqual({
      ...blank,
      id: expect.any(Number),
      status: 'pending',
      source: 'akahu',
      category_source: 'akahu',
      account_id: 'acc_fixture0001everyday',
      connection_id: 'conn_fixture0001',
      updated_at: '2026-10-24T09:31:00.000Z',
      date: '2026-10-24T09:30:00.000Z',
      description: 'EXAMPLE FUEL STOP 4',
      amount_cents: -6420,
      type: 'EFTPOS',
      particulars: 'Example',
      code: 'FIXTURE',
      reference: 'fixture-ref-pending',
      other_account: 'XX-XXXX-XXXXXXX-XX',
      logo: 'https://example.com/fixture-fuel-logo.png',
      merchant_id: 'merchant_fixture0004',
      merchant_name: 'Example Fuel',
      merchant_website: 'https://example.com/fuel',
      merchant_nzbn: 'fixture-nzbn-0004',
    })
    expect(pending[1]).toEqual({
      ...blank,
      id: expect.any(Number),
      status: 'pending',
      source: 'akahu',
      category_source: 'akahu',
      account_id: 'acc_fixture0003credit',
      date: '2026-10-24T10:05:00.000Z',
      description: '',
      amount_cents: -850,
      type: '',
    })
  })

  it('creates accounts as personal and akahu, with Akahu fields in cents', async () => {
    await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })

    const accounts = await db('accounts').orderBy('akahu_id').select()
    expect(accounts.map((a) => [a.akahu_id, a.scope, a.source])).toEqual([
      ['acc_fixture0001everyday', 'personal', 'akahu'],
      ['acc_fixture0002savings', 'personal', 'akahu'],
      ['acc_fixture0003credit', 'personal', 'akahu'],
    ])
    const credit = accounts[2]
    expect(Object.keys(credit).sort()).toEqual([...ACCOUNT_KEYS].sort())
    expect(credit).toEqual({
      id: expect.any(Number),
      akahu_id: 'acc_fixture0003credit',
      source: 'akahu',
      scope: 'personal',
      name: 'Fixture Credit Card',
      formatted_account: 'XXXX-XXXX-XXXX-XXXX',
      type: 'CREDITCARD',
      status: 'ACTIVE',
      attributes: '["PAYMENT_TO","TRANSACTIONS","TRANSFER_TO"]',
      connection_id: 'conn_fixture0001',
      connection_name: 'Example Bank',
      connection_type: 'classic',
      connection_logo: 'https://example.com/fixture-bank-logo.png',
      authorisation_id: 'auth_fixture0001',
      credentials_id: 'creds_fixture0001',
      currency: 'NZD',
      balance_cents: -43217,
      available_balance_cents: 456783,
      credit_limit_cents: 500000,
      refreshed_balance_at: '2026-10-24T20:15:00.000Z',
      refreshed_meta_at: '2026-10-24T20:15:01.000Z',
      refreshed_transactions_at: '2026-10-24T20:15:02.000Z',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
  })

  it('reads accounts, then every settled page, then pending', async () => {
    const akahu = fakeAkahu()
    await runSync({ client: akahu.client, db, now: fixed(NOW) })
    expect(
      akahu.calls.map((url) => [url.pathname, url.searchParams.get('cursor')]),
    ).toEqual([
      ['/v1/accounts', null],
      ['/v1/transactions', null],
      ['/v1/transactions', 'cursor_fixture_page2'],
      ['/v1/transactions/pending', null],
    ])
  })

  it('writes to the app database connection when no db is given', async () => {
    const result = await runSync({ client: fakeAkahu().client, now: fixed(NOW) })
    expect(result.outcome).toBe('success')
    expect(await db('transactions').count({ n: '*' })).toEqual([{ n: 10 }])
  })
})

describe('Done-when 1: two runs over the same data change nothing', () => {
  it('leaves every row, updated_at included, as the first run left it', async () => {
    await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })
    const first = await snapshot()

    const second = await runSync({
      client: fakeAkahu().client,
      db,
      now: fixed(at(15 * MINUTE_MS)),
    })

    expect(second).toEqual({
      outcome: 'success',
      runId: 2,
      insertedCount: 0,
      updatedCount: 0,
      pendingMirroredCount: 2,
    })
    expect(await snapshot()).toEqual(first)
    expect(first.settled).toHaveLength(8)
    expect(first.pending).toHaveLength(2)
    expect(first.accounts).toHaveLength(3)
  })
})

describe('Done-when 2: a pending transaction that settles exists once, as settled', () => {
  it('replaces the pending row with the settled one in the next run', async () => {
    await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })
    expect(
      await db('transactions')
        .where({ description: 'EXAMPLE FUEL STOP 4' })
        .pluck('status'),
    ).toEqual(['pending'])

    const settledFuel = `{"_id":"trans_fixture_fuel_settled","_account":"acc_fixture0001everyday","_connection":"conn_fixture0001","amount":-64.2,"category":{"_id":"nzfcc_fixture0004","name":"Fuel stations","groups":{"personal_finance":{"_id":"group_fixture0003","name":"Transport"}}},"created_at":"2026-10-25T01:00:00.000Z","date":"2026-10-24T00:00:00.000Z","description":"EXAMPLE FUEL STOP 4","hash":"hash_fixture_fuel","type":"EFTPOS","updated_at":"2026-10-25T01:00:00.000Z"}`
    const second = await runSync({
      client: fakeAkahu({
        transactions: (url) =>
          url.searchParams.has('cursor')
            ? page([])
            : withSettledItem(fixture('akahu-transactions.json'), settledFuel),
        pending: page([CREDIT_PENDING]),
      }).client,
      db,
      now: fixed(at(15 * MINUTE_MS)),
    })

    expect(second).toMatchObject({ outcome: 'success', insertedCount: 1 })
    const fuel = await db('transactions')
      .where({ description: 'EXAMPLE FUEL STOP 4' })
      .select()
    expect(fuel).toHaveLength(1)
    expect(fuel[0]).toMatchObject({
      akahu_id: 'trans_fixture_fuel_settled',
      status: 'settled',
      amount_cents: -6420,
      category: 'Fuel stations',
      category_source: 'akahu',
      akahu_category_name: 'Fuel stations',
    })
    expect(
      await db('transactions')
        .where({ status: 'pending', account_id: 'acc_fixture0001everyday' })
        .count({ n: '*' }),
    ).toEqual([{ n: 0 }])
  })
})

describe('Done-when 3: sync never deletes a settled row', () => {
  beforeEach(async () => {
    // Any delete of a settled row aborts the statement, and so the run.
    await db.raw(
      `CREATE TRIGGER no_settled_delete BEFORE DELETE ON transactions
       WHEN OLD.status = 'settled'
       BEGIN SELECT RAISE(ABORT, 'settled row deleted'); END`,
    )
    await db('transactions').insert([
      {
        akahu_id: 'trans_outside_window',
        account_id: 'acc_fixture0001everyday',
        date: '2024-01-05T00:00:00.000Z',
        description: 'EXAMPLE OLD PURCHASE',
        amount_cents: -500,
        status: 'settled',
        source: 'akahu',
      },
      {
        akahu_id: 'trans_savings_only',
        account_id: 'acc_fixture0002savings',
        date: '2026-10-01T00:00:00.000Z',
        description: 'EXAMPLE INTEREST',
        amount_cents: 12,
        status: 'settled',
        source: 'akahu',
      },
    ])
  })

  it('clears a pending item that left the list, keeps the rest, and deletes no settled row', async () => {
    const first = await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })
    expect(first.outcome).toBe('success')
    const settledBefore = (await snapshot()).settled

    const second = await runSync({
      client: fakeAkahu({ pending: page([CREDIT_PENDING]) }).client,
      db,
      now: fixed(at(15 * MINUTE_MS)),
    })
    expect(second).toMatchObject({ outcome: 'success', pendingMirroredCount: 1 })
    const afterSecond = await snapshot()
    expect(afterSecond.settled).toEqual(settledBefore)
    expect(afterSecond.pending.map((row) => row.account_id)).toEqual([
      'acc_fixture0003credit',
    ])

    // Akahu now lists no pending items at all.
    const third = await runSync({
      client: fakeAkahu({ pending: page([]) }).client,
      db,
      now: fixed(at(30 * MINUTE_MS)),
    })
    expect(third).toMatchObject({ outcome: 'success', pendingMirroredCount: 0 })
    const afterThird = await snapshot()
    expect(afterThird.pending).toEqual([])
    expect(afterThird.settled).toEqual(settledBefore)
    expect(afterThird.settled.map((row) => row.akahu_id)).toEqual(
      expect.arrayContaining(['trans_outside_window', 'trans_savings_only']),
    )
  })
})

describe('accounts: scope and source are never written by sync', () => {
  it('keeps a strawb scope and a xero source through a re-sync that updates the account', async () => {
    await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })
    await db('accounts')
      .where({ akahu_id: 'acc_fixture0001everyday' })
      .update({ scope: 'strawb' })
    await db('accounts')
      .where({ akahu_id: 'acc_fixture0002savings' })
      .update({ source: 'xero' })

    const newAccount = `{"_id":"acc_fixture0004new","balance":{"current":10,"currency":"NZD"},"connection":{"_id":"conn_fixture0001","name":"Example Bank"},"name":"Fixture New","status":"ACTIVE","type":"SAVINGS"}`
    let accounts = fixture('akahu-accounts.json')
    accounts = replaceOnce(accounts, '"Fixture Everyday"', '"Fixture Everyday Renamed"')
    accounts = replaceOnce(accounts, '"Fixture Savings"', '"Fixture Savings Renamed"')
    accounts = replaceOnce(accounts, '"items": [', `"items": [${newAccount},`)
    const later = at(15 * MINUTE_MS)
    await runSync({ client: fakeAkahu({ accounts }).client, db, now: fixed(later) })

    const rows = await db('accounts').orderBy('akahu_id').select()
    expect(
      rows.map((a) => [a.akahu_id, a.name, a.scope, a.source, a.updated_at]),
    ).toEqual([
      ['acc_fixture0001everyday', 'Fixture Everyday Renamed', 'strawb', 'akahu', later.toISOString()],
      ['acc_fixture0002savings', 'Fixture Savings Renamed', 'personal', 'xero', later.toISOString()],
      ['acc_fixture0003credit', 'Fixture Credit Card', 'personal', 'akahu', NOW.toISOString()],
      ['acc_fixture0004new', 'Fixture New', 'personal', 'akahu', later.toISOString()],
    ])
    expect(rows[0].created_at).toBe(NOW.toISOString())
    expect(rows[3].balance_cents).toBe(1000)
  })
})

// #145: an account's role and a bill's account link hang off the account's id,
// so a re-sync that updates or drops the account must leave both in place.
describe('accounts: a role and a bill link survive re-sync', () => {
  it('keeps the account_settings role and the bills.account_id through an update and a dropped account', async () => {
    expect(
      (await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) }))
        .outcome,
    ).toBe('success')
    const credit = await db('accounts')
      .where({ akahu_id: 'acc_fixture0003credit' })
      .first()
    await db('account_settings').insert({
      account_id: credit.id,
      role: 'credit_card',
      updated_at: NOW.toISOString(),
    })
    await db('bills').insert({
      scope: 'personal',
      name: 'Card payment',
      amount_cents: 15000,
      repeat: 'monthly',
      first_due_date: '2026-11-05',
      account_id: credit.id,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
    const [role] = await db('account_settings').select()
    expect(Object.keys(role).sort()).toEqual(
      ['account_id', 'id', 'role', 'updated_at'].sort(),
    )

    async function expectRoleAndBillKept(): Promise<void> {
      expect(await db('account_settings').select()).toEqual([role])
      expect(await db('bills').select('account_id')).toEqual([
        { account_id: credit.id },
      ])
      const same = await db('accounts').where({ id: credit.id }).first()
      expect(same?.akahu_id).toBe('acc_fixture0003credit')
    }

    // Run 2: Akahu renames the card, so the account row is UPDATED in place.
    const accounts = fixture('akahu-accounts.json')
    const renamed = replaceOnce(
      accounts,
      '"Fixture Credit Card"',
      '"Fixture Credit Card Renamed"',
    )
    // A failed run rolls back and would keep both vacuously, so each run
    // must succeed.
    const second = await runSync({
      client: fakeAkahu({ accounts: renamed }).client,
      db,
      now: fixed(at(15 * MINUTE_MS)),
    })
    expect(second.outcome).toBe('success')
    expect((await db('accounts').where({ id: credit.id }).first()).name).toBe(
      'Fixture Credit Card Renamed',
    )
    await expectRoleAndBillKept()

    // Run 3: Akahu stops listing the card. Sync must not delete the account.
    // Cut as text, like the rest of the harness: parsing the fixture would
    // turn its balances into floats (docs/testing.md, Fixtures). The card is
    // the last item, so the cut runs from the comma before it to the `]`.
    const card = accounts.indexOf('"_id": "acc_fixture0003credit"')
    const withoutCard =
      accounts.slice(0, accounts.lastIndexOf(',', card)) +
      accounts.slice(accounts.indexOf('\n  ]', card))
    expect(withoutCard).not.toContain('acc_fixture0003credit')
    const third = await runSync({
      client: fakeAkahu({ accounts: withoutCard }).client,
      db,
      now: fixed(at(30 * MINUTE_MS)),
    })
    expect(third.outcome).toBe('success')
    expect(await db('accounts').select('id')).toHaveLength(3)
    await expectRoleAndBillKept()
  })
})

describe('the settled window (Ruling 2, amended by Ruling 10)', () => {
  async function windowAfter(
    priorRuns: { started_at: string; outcome: 'success' | 'failed' }[],
  ) {
    for (const run of priorRuns) {
      await db('sync_runs').insert({
        ...run,
        finished_at: run.started_at,
        error_message: run.outcome === 'failed' ? 'akahu_network' : null,
      })
    }
    const akahu = fakeAkahu()
    const result = await runSync({ client: akahu.client, db, now: fixed(NOW) })
    expect(result.outcome).toBe('success')
    return settledWindows(akahu.calls)[0]
  }

  it('asks for everything Akahu allows on the first run, with no start or end', async () => {
    expect(await windowAfter([])).toEqual({ start: null, end: null })
  })

  it('asks for everything Akahu allows when every earlier run failed', async () => {
    expect(
      await windowAfter([
        { started_at: at(-DAY_MS).toISOString(), outcome: 'failed' },
      ]),
    ).toEqual({ start: null, end: null })
  })

  it('sends neither bound on every page of the first run', async () => {
    // The default transactions route paginates (the fixture's cursor, then an
    // empty last page), so this checks each request, not only the first.
    const akahu = fakeAkahu()
    const result = await runSync({ client: akahu.client, db, now: fixed(NOW) })
    expect(result.outcome).toBe('success')

    const windows = settledWindows(akahu.calls)
    expect(windows.length).toBeGreaterThan(1)
    expect(windows).toEqual(windows.map(() => ({ start: null, end: null })))
  })

  it('starts 30 days before the last success started', async () => {
    expect(
      await windowAfter([
        { started_at: at(-15 * MINUTE_MS).toISOString(), outcome: 'success' },
      ]),
    ).toEqual({
      start: at(-30 * DAY_MS - 15 * MINUTE_MS).toISOString(),
      end: NOW.toISOString(),
    })
  })

  it('ignores a failed run after the last success', async () => {
    expect(
      await windowAfter([
        { started_at: at(-10 * DAY_MS).toISOString(), outcome: 'success' },
        { started_at: at(-DAY_MS).toISOString(), outcome: 'failed' },
      ]),
    ).toEqual({ start: at(-40 * DAY_MS).toISOString(), end: NOW.toISOString() })
  })

  it('covers an outage longer than the overlap', async () => {
    expect(
      await windowAfter([
        { started_at: at(-45 * DAY_MS).toISOString(), outcome: 'success' },
      ]),
    ).toEqual({ start: at(-75 * DAY_MS).toISOString(), end: NOW.toISOString() })
  })

  it('asks for everything Akahu allows when the last success has an unreadable start', async () => {
    expect(
      await windowAfter([{ started_at: 'not-a-timestamp', outcome: 'success' }]),
    ).toEqual({ start: null, end: null })
  })

  it('uses the latest success with a readable start, even when an unreadable one came after it (#169)', async () => {
    // 'not-a-timestamp' sorts after every ISO string as text, so an ordering
    // on the raw column would pick it and send the first-run window forever.
    expect(
      await windowAfter([
        { started_at: at(-15 * MINUTE_MS).toISOString(), outcome: 'success' },
        { started_at: 'not-a-timestamp', outcome: 'success' },
      ]),
    ).toEqual({
      start: at(-30 * DAY_MS - 15 * MINUTE_MS).toISOString(),
      end: NOW.toISOString(),
    })
  })

  it("skips a start SQLite reads but Date.parse does not, such as 'now' (#169)", async () => {
    // julianday('now') is the wall clock, later than every real start, while
    // windowFor cannot parse 'now'; ranking it would send the first-run
    // window forever, the bug above by another spelling.
    expect(
      await windowAfter([
        { started_at: at(-15 * MINUTE_MS).toISOString(), outcome: 'success' },
        { started_at: 'now', outcome: 'success' },
      ]),
    ).toEqual({
      start: at(-30 * DAY_MS - 15 * MINUTE_MS).toISOString(),
      end: NOW.toISOString(),
    })
  })

  it("skips an ISO start toISOString() never writes, such as '2999-01-01T00:00:00Z' (#206)", async () => {
    // Date.parse reads it and it ends in Z, but it has no milliseconds:
    // ranked, it would beat every real start, and the window would start 30
    // days before now instead of 30 days before the real last success.
    expect(
      await windowAfter([
        { started_at: at(-15 * MINUTE_MS).toISOString(), outcome: 'success' },
        { started_at: '2999-01-01T00:00:00Z', outcome: 'success' },
      ]),
    ).toEqual({
      start: at(-30 * DAY_MS - 15 * MINUTE_MS).toISOString(),
      end: NOW.toISOString(),
    })
  })

  it('follows the most recent success, not the oldest or the first inserted', async () => {
    // The recent success has the lower id, so neither ascending start order
    // nor descending id order alone finds it.
    expect(
      await windowAfter([
        { started_at: at(-15 * MINUTE_MS).toISOString(), outcome: 'success' },
        { started_at: at(-40 * DAY_MS).toISOString(), outcome: 'success' },
      ]),
    ).toEqual({
      start: at(-30 * DAY_MS - 15 * MINUTE_MS).toISOString(),
      end: NOW.toISOString(),
    })
  })

  it('uses the shared start when two successes started at the same instant', async () => {
    // The window can only show the start time, which is the same for both
    // rows, so this pins that duplicates read cleanly; it cannot see which
    // row the `id desc` tie-break picks.
    const sameStart = at(-2 * DAY_MS).toISOString()
    expect(
      await windowAfter([
        { started_at: at(-20 * DAY_MS).toISOString(), outcome: 'success' },
        { started_at: sameStart, outcome: 'success' },
        { started_at: sameStart, outcome: 'success' },
      ]),
    ).toEqual({ start: at(-32 * DAY_MS).toISOString(), end: NOW.toISOString() })
  })

  it('never starts later than 30 days before now, even if the clock went back', async () => {
    expect(
      await windowAfter([
        { started_at: at(60 * MINUTE_MS).toISOString(), outcome: 'success' },
      ]),
    ).toEqual({ start: at(-30 * DAY_MS).toISOString(), end: NOW.toISOString() })
  })
})

describe('one run at a time (Ruling 6)', () => {
  it('names a stale timeout of 30 minutes', () => {
    expect(STALE_RUN_AFTER_MS).toBe(30 * MINUTE_MS)
  })

  it('closes a running row older than the timeout as abandoned, then runs', async () => {
    await db('sync_runs').insert({
      started_at: at(-31 * MINUTE_MS).toISOString(),
      outcome: 'running',
    })

    const result = await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })

    expect(result).toMatchObject({ outcome: 'success', runId: 2 })
    expect(await syncRuns()).toEqual([
      {
        id: 1,
        started_at: at(-31 * MINUTE_MS).toISOString(),
        finished_at: NOW.toISOString(),
        outcome: 'failed',
        inserted_count: 0,
        updated_count: 0,
        pending_mirrored_count: 0,
        error_message: 'sync_abandoned: run did not finish within the stale timeout',
      },
      expect.objectContaining({ id: 2, outcome: 'success' }),
    ])
  })

  it('treats a running row whose start does not parse as abandoned, then runs', async () => {
    await db('sync_runs').insert({
      started_at: 'not-a-timestamp',
      outcome: 'running',
    })
    const akahu = fakeAkahu()

    const result = await runSync({ client: akahu.client, db, now: fixed(NOW) })

    expect(result).toMatchObject({ outcome: 'success', runId: 2 })
    expect(akahu.calls.length).toBeGreaterThan(0)
    expect(await syncRuns()).toEqual([
      {
        id: 1,
        started_at: 'not-a-timestamp',
        finished_at: NOW.toISOString(),
        outcome: 'failed',
        inserted_count: 0,
        updated_count: 0,
        pending_mirrored_count: 0,
        error_message: 'sync_abandoned: run did not finish within the stale timeout',
      },
      expect.objectContaining({ id: 2, outcome: 'success' }),
    ])
  })

  it('skips without a request or a write while a fresh run is running', async () => {
    await db('sync_runs').insert({
      started_at: at(-5 * MINUTE_MS).toISOString(),
      outcome: 'running',
    })
    const runsBefore = await syncRuns()
    const before = await snapshot()
    const akahu = fakeAkahu()

    const result = await runSync({ client: akahu.client, db, now: fixed(NOW) })

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'already_running',
      runningRunId: 1,
    })
    expect(akahu.calls).toEqual([])
    expect(await syncRuns()).toEqual(runsBefore)
    expect(await snapshot()).toEqual(before)
  })

  it('lets only one of two overlapping runs proceed', async () => {
    const a = fakeAkahu()
    const b = fakeAkahu()
    const results = await Promise.all([
      runSync({ client: a.client, db, now: fixed(NOW) }),
      runSync({ client: b.client, db, now: fixed(NOW) }),
    ])

    const success = results.find((r) => r.outcome === 'success')
    const skipped = results.find((r) => r.outcome === 'skipped')
    expect(success).toMatchObject({ runId: 1 })
    expect(skipped).toEqual({
      outcome: 'skipped',
      reason: 'already_running',
      runningRunId: 1,
    })
    expect(a.calls.length + b.calls.length).toBe(4)
    expect(await syncRuns()).toHaveLength(1)
  })

  // One connection serialises claims in this process; these stand in for a
  // second process whose claim committed first, so the unique index
  // `sync_runs_one_running` refused this one.
  it('skips when another process claimed between the read and the insert', async () => {
    vi.spyOn(db, 'transaction').mockImplementationOnce(async () => {
      await db('sync_runs').insert({ started_at: NOW.toISOString(), outcome: 'running' })
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: sync_runs.outcome')
    })
    const akahu = fakeAkahu()

    const result = await runSync({ client: akahu.client, db, now: fixed(NOW) })

    expect(result).toEqual({ outcome: 'skipped', reason: 'already_running', runningRunId: 1 })
    expect(akahu.calls).toEqual([])
    expect(await syncRuns()).toHaveLength(1)
  })

  it('rejects when the claim fails and no other run holds sync', async () => {
    vi.spyOn(db, 'transaction').mockImplementationOnce(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error')
    })
    const akahu = fakeAkahu()

    await expect(
      runSync({ client: akahu.client, db, now: fixed(NOW) }),
    ).rejects.toThrow('SQLITE_IOERR')
    expect(akahu.calls).toEqual([])
    expect(await syncRuns()).toEqual([])
  })
})

describe('duplicates in one response', () => {
  it('writes one row per Akahu id, the last one sent winning', async () => {
    const transactions = page([
      settledItem('trans_dup', 'EXAMPLE FIRST COPY', '-1.00'),
      settledItem('trans_dup', 'EXAMPLE LAST COPY', '-2.00'),
    ])
    const account = (name: string) =>
      `{"_id":"acc_fixture0001everyday","balance":{"current":1},"connection":{"_id":"conn_fixture0001","name":"Example Bank"},"name":"${name}","status":"ACTIVE","type":"CHECKING"}`
    const result = await runSync({
      client: fakeAkahu({
        accounts: page([account('Fixture First'), account('Fixture Last')]),
        transactions,
        pending: page([]),
      }).client,
      db,
      now: fixed(NOW),
    })

    expect(result).toMatchObject({ outcome: 'success', insertedCount: 1 })
    expect(
      await db('transactions').select('akahu_id', 'description', 'amount_cents'),
    ).toEqual([
      { akahu_id: 'trans_dup', description: 'EXAMPLE LAST COPY', amount_cents: -200 },
    ])
    expect(await db('accounts').pluck('name')).toEqual(['Fixture Last'])
  })
})

describe('a response larger than one SQLite statement can bind', () => {
  // Each settled row binds one variable per column, so a single insert of
  // this many rows is far past SQLite's 999-variable bound, and the second
  // run looks up more ids than one lookup may bind. This SQLite build allows
  // far more than 999, so the bound is checked on the statements themselves
  // rather than left to the database to refuse.
  const COUNT = 1100
  const SQLITE_MAX_VARIABLES = 999

  /** Invented settled items; `cents` is an integer and is sent as dollars text. */
  function bulkItems(): string[] {
    return Array.from({ length: COUNT }, (_, i) => {
      const cents = -(i * 7 + 1)
      return settledItem(
        `trans_bulk_${String(i).padStart(4, '0')}`,
        `EXAMPLE BULK ${i}`,
        (cents / 100).toFixed(2),
      )
    })
  }

  const bulkClient = () =>
    fakeAkahu({ transactions: page(bulkItems()), pending: page([]) }).client

  /** The number of values bound by each statement issued while `body` runs. */
  async function boundVariables(body: () => Promise<void>): Promise<number[]> {
    const counts: number[] = []
    const listener = (query: { bindings?: readonly unknown[] }) => {
      counts.push(query.bindings?.length ?? 0)
    }
    db.on('query', listener)
    try {
      await body()
    } finally {
      db.off('query', listener)
    }
    return counts
  }

  it('inserts every row once, then finds every row again and changes none', async () => {
    const firstBound = await boundVariables(async () => {
      const first = await runSync({ client: bulkClient(), db, now: fixed(NOW) })
      expect(first).toMatchObject({
        outcome: 'success',
        insertedCount: COUNT,
        updatedCount: 0,
      })
    })
    expect(await db('transactions').count({ n: '*' })).toEqual([{ n: COUNT }])
    expect(
      await db('transactions').countDistinct({ n: 'akahu_id' }),
    ).toEqual([{ n: COUNT }])
    expect(
      await db('transactions')
        .where({ akahu_id: 'trans_bulk_1099' })
        .pluck('amount_cents'),
    ).toEqual([-7694])

    const before = await snapshot()
    const secondBound = await boundVariables(async () => {
      const second = await runSync({
        client: bulkClient(),
        db,
        now: fixed(at(15 * MINUTE_MS)),
      })
      expect(second).toMatchObject({
        outcome: 'success',
        insertedCount: 0,
        updatedCount: 0,
      })
    })
    expect(await db('transactions').count({ n: '*' })).toEqual([{ n: COUNT }])
    expect(await snapshot()).toEqual(before)

    // The first run split its inserts, the second split its id lookups; the
    // largest statement of either stays under SQLite's documented bound,
    // though the second run alone bound at least COUNT ids across them.
    expect(Math.max(...firstBound)).toBeLessThanOrEqual(SQLITE_MAX_VARIABLES)
    expect(Math.max(...secondBound)).toBeLessThanOrEqual(SQLITE_MAX_VARIABLES)
    expect(secondBound.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(COUNT)
  })
})

describe('the pending mirror only replaces Akahu pending rows', () => {
  // `transactions.source` accepts only 'akahu' and 'xero' (migration
  // 20261024100003), so the non-Akahu pending row is a Xero one.
  it('keeps a pending row that is not from Akahu, run after run', async () => {
    await db('transactions').insert({
      account_id: 'acc_fixture0001everyday',
      date: '2026-10-24T00:00:00.000Z',
      description: 'EXAMPLE XERO PENDING',
      amount_cents: -1250,
      status: 'pending',
      source: 'xero',
    })
    const xeroRow = () =>
      db('transactions').where({ description: 'EXAMPLE XERO PENDING' }).select()

    const first = await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })
    expect(first).toMatchObject({ outcome: 'success', pendingMirroredCount: 2 })
    const kept = await xeroRow()
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({
      status: 'pending',
      source: 'xero',
      amount_cents: -1250,
    })

    // Akahu now lists no pending items: its rows go, the Xero one stays.
    const second = await runSync({
      client: fakeAkahu({ pending: page([]) }).client,
      db,
      now: fixed(at(15 * MINUTE_MS)),
    })
    expect(second).toMatchObject({ outcome: 'success', pendingMirroredCount: 0 })
    expect(await xeroRow()).toEqual(kept)
    expect(
      await db('transactions').where({ status: 'pending' }).pluck('source'),
    ).toEqual(['xero'])
  })
})

describe('static guards on server/sync', () => {
  const syncDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = (name: string) => readFileSync(Path.join(syncDir, name), 'utf8')

  it('converts no money in run.ts or upsert.ts', () => {
    for (const name of ['run.ts', 'upsert.ts']) {
      expect(source(name)).not.toMatch(/\*\s*100|\/\s*100/)
    }
  })

  it('has exactly one delete, and it names pending Akahu rows', () => {
    const files = readdirSync(syncDir).filter((name) => name.endsWith('.ts'))
    expect(files).toEqual(expect.arrayContaining(['run.ts', 'upsert.ts']))
    const deletes = files.flatMap((name) =>
      [...source(name).matchAll(/\.del(?:ete)?\(|\.raw\(|\.truncate\(/g)].map(
        (match) => ({ name, index: match.index ?? -1 }),
      ),
    )
    expect(deletes.map((d) => d.name)).toEqual(['upsert.ts'])
    expect(source('upsert.ts')).toMatch(
      /trx\('transactions'\)\.where\(\{ status: 'pending', source: 'akahu' \}\)\.del\(\)/,
    )
  })
})

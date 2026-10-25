import { readdirSync, readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

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
      attributes: '[]',
      connection_id: 'conn_fixture0001',
      connection_name: 'Example Bank',
      connection_type: null,
      connection_logo: null,
      authorisation_id: null,
      credentials_id: null,
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

  it('reaches back 730 days on the first run', async () => {
    expect(await windowAfter([])).toEqual({
      start: at(-730 * DAY_MS).toISOString(),
      end: NOW.toISOString(),
    })
  })

  it('reaches back 730 days when every earlier run failed', async () => {
    expect(
      await windowAfter([
        { started_at: at(-DAY_MS).toISOString(), outcome: 'failed' },
      ]),
    ).toEqual({ start: at(-730 * DAY_MS).toISOString(), end: NOW.toISOString() })
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

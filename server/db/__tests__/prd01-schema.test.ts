// prd-01 wave 1 (#19): the sync schema. Covers the four migrations
// 20261024100001…100004 together, from a database holding the M1 #7
// fixture as legacy rows, through `migrate:latest`, and back down.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../knexfile.js'
import { migrateToJustBefore } from './migrateToJustBefore.ts'
import { omit } from './omit.ts'
import { TRANSACTION_COLUMNS } from './transactionColumns.ts'
import { dollarsToCents } from '../../../shared/money.ts'
import type { AkahuTransaction } from '../../../models/akahu.ts'
import type {
  Account,
  AccountScope,
  CategoryCorrection,
  CorrectionSource,
  DataSource,
  SyncRun,
  TransactionStatus,
} from '../../../models/sync.ts'

const FIRST = '20261024100001_accounts.js'
const OURS = [
  FIRST,
  '20261024100002_sync_runs.js',
  '20261024100003_transactions_status_source_category.js',
  '20261024100004_category_corrections.js',
]

const NEW_TABLES = ['accounts', 'sync_runs', 'category_corrections']
const NEW_TRANSACTION_COLUMNS = [
  'status',
  'source',
  'akahu_category_id',
  'akahu_category_name',
  'akahu_category_group_id',
  'akahu_category_group_name',
]
const LEGACY_CATEGORY = [
  'category_id',
  'category_name',
  'category_group_id',
  'category_group_name',
] as const

// Each table's columns, tied to its row type: adding a field to the type
// without a column (or the reverse) fails the key-set tests below, and
// TypeScript refuses a key here that the type does not have.
const ACCOUNT_KEYS: Record<keyof Account, true> = {
  id: true,
  akahu_id: true,
  source: true,
  scope: true,
  name: true,
  formatted_account: true,
  type: true,
  status: true,
  attributes: true,
  connection_id: true,
  connection_name: true,
  connection_type: true,
  connection_logo: true,
  authorisation_id: true,
  credentials_id: true,
  currency: true,
  balance_cents: true,
  available_balance_cents: true,
  credit_limit_cents: true,
  refreshed_balance_at: true,
  refreshed_meta_at: true,
  refreshed_transactions_at: true,
  created_at: true,
  updated_at: true,
}
const SYNC_RUN_KEYS: Record<keyof SyncRun, true> = {
  id: true,
  started_at: true,
  finished_at: true,
  outcome: true,
  inserted_count: true,
  updated_count: true,
  pending_mirrored_count: true,
  error_message: true,
}
const CORRECTION_KEYS: Record<keyof CategoryCorrection, true> = {
  id: true,
  transaction_id: true,
  from_category: true,
  to_category: true,
  corrected_at: true,
  source: true,
}

// Every value of each domain, as the types declare them. A `satisfies`
// list cannot miss a member silently: `Record<Union, true>` requires each.
const SCOPES = Object.keys({ personal: true, strawb: true } satisfies Record<
  AccountScope,
  true
>)
const SOURCES = Object.keys({ akahu: true, xero: true } satisfies Record<
  DataSource,
  true
>)
const STATUSES = Object.keys({ settled: true, pending: true } satisfies Record<
  TransactionStatus,
  true
>)
const CORRECTION_SOURCES = Object.keys({
  user: true,
  rule: true,
  claude: true,
} satisfies Record<CorrectionSource, true>)

const AT = '2026-10-25T03:00:00.000Z'
const LATER = '2026-10-25T03:05:00.000Z'

type Row = Record<string, unknown>

let db: Knex

async function columns(table: string): Promise<string[]> {
  const info: { name: string }[] = await db.raw('PRAGMA table_info(??)', [table])
  return info.map((c) => c.name)
}

async function sequence(table: string): Promise<number | undefined> {
  const row = await db('sqlite_sequence').where({ name: table }).first('seq')
  return row?.seq
}

async function applied(): Promise<string[]> {
  const [completed] = (await db.migrate.list()) as [{ name: string }[], unknown]
  return completed.map((m) => m.name)
}

function fixtureItems(): AkahuTransaction[] {
  const text = readFileSync(
    new URL('../fixtures/transactions.json', import.meta.url),
    'utf8',
  )
  return JSON.parse(text).items
}

// A row as the M1 seed wrote it, in the schema just before 100001.
function legacyRow(t: AkahuTransaction): Row {
  const group = t.category?.groups?.personal_finance
  return {
    akahu_id: t._id,
    account_id: t._account,
    user_id: t._user,
    connection_id: t._connection,
    created_at: t.created_at,
    updated_at: t.updated_at,
    date: t.date,
    description: t.description,
    amount_cents: dollarsToCents(t.amount),
    balance_cents: t.balance === undefined ? null : dollarsToCents(t.balance),
    type: t.type,
    hash: t.hash ?? null,
    category_id: t.category?._id ?? null,
    category_name: t.category?.name ?? null,
    category_group_id: group?._id ?? null,
    category_group_name: group?.name ?? null,
    category: t.category?.name ?? null,
    category_source: 'akahu',
  }
}

const BAKERIES = {
  category_id: 'nzfcc_fixture_bakeries',
  category_name: 'Bakeries',
  category_group_id: 'group_fixture_food',
  category_group_name: 'Food',
}

// R1: Akahu sent a category but the row has no effective one. R2: the user
// changed the category; Akahu's stays as it was.
const R1 = 'trans_legacy_no_effective'
const R2 = 'trans_legacy_user_set'

let before: Row[]
let beforeColumns: string[]
let beforeSequence: number | undefined

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, FIRST)

  await db.batchInsert('transactions', fixtureItems().map(legacyRow), 25)
  await db('transactions').insert([
    {
      akahu_id: R1,
      account_id: 'acc_fixture_everyday',
      amount_cents: -450,
      ...BAKERIES,
      category: null,
      category_source: 'akahu',
    },
    {
      akahu_id: R2,
      account_id: 'acc_fixture_everyday',
      amount_cents: -620,
      ...BAKERIES,
      category: 'Convenience stores',
      category_source: 'user',
    },
  ])
  // Leave the AUTOINCREMENT high-water mark above max(id), so a table
  // rebuild (which resets it to max(id)) is visible.
  const [discarded] = await db('transactions').insert({ akahu_id: 'trans_discarded' })
  await db('transactions').where({ id: discarded }).del()

  before = await db('transactions').orderBy('id')
  beforeColumns = await columns('transactions')
  beforeSequence = await sequence('transactions')
})

afterEach(async () => {
  await db.destroy()
})

describe('backfill of existing transactions (Done-when 1)', () => {
  it('marks every existing row settled and from Akahu, with Akahu category copied', async () => {
    expect(before.length).toBeGreaterThan(40)
    expect(before.some((r) => r.category_name === null)).toBe(true)

    await db.migrate.latest()

    const after: Row[] = await db('transactions').orderBy('id')
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))

    after.forEach((row, i) => {
      const old = before[i]
      expect(row.status).toBe('settled')
      expect(row.source).toBe('akahu')
      expect(row.category_source).toBe(old.category_source)
      expect(row.akahu_category_id).toBe(old.category_id)
      expect(row.akahu_category_name).toBe(old.category_name)
      expect(row.akahu_category_group_id).toBe(old.category_group_id)
      expect(row.akahu_category_group_name).toBe(old.category_group_name)
      for (const legacy of LEGACY_CATEGORY) expect(row[legacy]).toBe(old[legacy])
      if (old.category_name === null) expect(row.category).toBeNull()
      else expect(row.category).not.toBeNull()
    })

    const nulls = await db('transactions')
      .whereNull('status')
      .orWhereNull('source')
      .orWhereNull('category_source')
      .count('* as n')
      .first()
    expect(nulls).toEqual({ n: 0 })
  })

  it("gives a row with Akahu's category but no effective one Akahu's name", async () => {
    await db.migrate.latest()

    expect(
      await db('transactions')
        .where({ akahu_id: R1 })
        .first('category', 'category_source', 'akahu_category_name'),
    ).toEqual({
      category: 'Bakeries',
      category_source: 'akahu',
      akahu_category_name: 'Bakeries',
    })
  })

  it("keeps the user's category and source where they differ from Akahu's", async () => {
    await db.migrate.latest()

    expect(
      await db('transactions')
        .where({ akahu_id: R2 })
        .first('category', 'category_source', 'akahu_category_name'),
    ).toEqual({
      category: 'Convenience stores',
      category_source: 'user',
      akahu_category_name: 'Bakeries',
    })
  })

  it("leaves an Akahu-owned row's existing category alone even when Akahu's differs", async () => {
    await db('transactions').insert({
      akahu_id: 'trans_legacy_akahu_differs',
      account_id: 'acc_fixture_everyday',
      amount_cents: -300,
      ...BAKERIES,
      category: 'Convenience stores',
      category_source: 'akahu',
    })

    await db.migrate.latest()

    expect(
      await db('transactions')
        .where({ akahu_id: 'trans_legacy_akahu_differs' })
        .first('category', 'category_source', 'akahu_category_name'),
    ).toEqual({
      category: 'Convenience stores',
      category_source: 'akahu',
      akahu_category_name: 'Bakeries',
    })
  })

  it("never fills in a missing category on a row a user, rule or Claude owns", async () => {
    const owners = ['user', 'rule', 'claude']
    await db('transactions').insert(
      owners.map((owner) => ({
        akahu_id: `trans_legacy_${owner}_no_category`,
        account_id: 'acc_fixture_everyday',
        amount_cents: -300,
        ...BAKERIES,
        category: null,
        category_source: owner,
      })),
    )

    await db.migrate.latest()

    expect(
      await db('transactions')
        .whereIn('category_source', owners)
        .whereNull('category')
        .orderBy('id')
        .pluck('category_source'),
    ).toEqual(owners)
  })

  it('changes nothing else in any row, and does not rebuild the table', async () => {
    // Without this gap a rebuild would land on the same counter value.
    expect(beforeSequence).toBeGreaterThan(Math.max(...before.map((r) => Number(r.id))))

    await db.migrate.latest()

    const after: Row[] = await db('transactions').orderBy('id')
    const kept = after.map((row) => {
      const copy = { ...row }
      for (const c of NEW_TRANSACTION_COLUMNS) delete copy[c]
      return copy
    })
    const expected = before.map((row) =>
      row.akahu_id === R1 ? { ...row, category: 'Bakeries' } : row,
    )
    expect(kept).toStrictEqual(expected)
    expect(await sequence('transactions')).toBe(beforeSequence)
  })

  it('keeps the legacy category and money columns (Done-when 7)', async () => {
    await db.migrate.latest()

    const names = await columns('transactions')
    for (const legacy of [...LEGACY_CATEGORY, 'amount_cents', 'balance_cents']) {
      expect(names).toContain(legacy)
    }
    expect([...names].sort()).toEqual([...TRANSACTION_COLUMNS].sort())
  })
})

describe('transactions.status and transactions.source (Done-when 2, 5)', () => {
  beforeEach(async () => {
    await db.migrate.latest()
  })

  it('defaults a new row to settled and akahu', async () => {
    await db('transactions').insert({ akahu_id: 'new', amount_cents: 1 })

    expect(
      await db('transactions').where({ akahu_id: 'new' }).first('status', 'source'),
    ).toEqual({ status: 'settled', source: 'akahu' })
  })

  it('accepts each status and source, and refuses anything else', async () => {
    await db('transactions').insert({ akahu_id: 'new', amount_cents: 1 })
    const row = () => db('transactions').where({ akahu_id: 'new' })

    for (const status of STATUSES) await row().update({ status })
    for (const source of SOURCES) await row().update({ source })
    expect(await row().first('status', 'source')).toEqual({
      status: STATUSES[STATUSES.length - 1],
      source: SOURCES[SOURCES.length - 1],
    })

    await expect(row().update({ status: 'bogus' })).rejects.toThrow(
      /CHECK constraint failed: status/,
    )
    await expect(row().update({ source: 'bogus' })).rejects.toThrow(
      /CHECK constraint failed: source/,
    )
    await expect(row().update({ status: null })).rejects.toThrow(
      /NOT NULL constraint failed: transactions.status/,
    )
    await expect(row().update({ source: null })).rejects.toThrow(
      /NOT NULL constraint failed: transactions.source/,
    )
  })

  it('holds identical pending rows with no akahu_id or hash side by side', async () => {
    const pending = {
      account_id: 'acc_fixture_everyday',
      status: 'pending',
      date: AT,
      description: 'PENDING SAMPLE',
      amount_cents: -1200,
    }
    await db('transactions').insert([pending, pending])

    const rows = await db('transactions')
      .where({ account_id: 'acc_fixture_everyday', status: 'pending' })
      .select('akahu_id', 'hash', 'category', 'akahu_category_name')
    expect(rows).toEqual([
      { akahu_id: null, hash: null, category: null, akahu_category_name: null },
      { akahu_id: null, hash: null, category: null, akahu_category_name: null },
    ])
  })

  it('indexes transactions by account then status', async () => {
    const info: { seqno: number; name: string }[] = await db.raw(
      'PRAGMA index_info(transactions_account_status_idx)',
    )
    expect(info.sort((a, b) => a.seqno - b.seqno).map((c) => c.name)).toEqual([
      'account_id',
      'status',
    ])
  })
})

describe('accounts (Done-when 2)', () => {
  beforeEach(async () => {
    await db.migrate.latest()
  })

  const account = (fields: Row) => ({
    name: 'Everyday',
    created_at: AT,
    updated_at: AT,
    ...fields,
  })

  it('has exactly the columns of the Account type', async () => {
    expect((await columns('accounts')).sort()).toEqual(
      Object.keys(ACCOUNT_KEYS).sort(),
    )
  })

  it('defaults scope to personal, source to akahu and attributes to an empty list', async () => {
    await db('accounts').insert(account({ akahu_id: 'acc_a' }))

    const row = await db('accounts').where({ akahu_id: 'acc_a' }).first()
    expect(row).toMatchObject({ scope: 'personal', source: 'akahu', attributes: '[]' })
  })

  it('round-trips a full Akahu account', async () => {
    const full: Omit<Account, 'id'> = {
      akahu_id: 'acc_full',
      source: 'akahu',
      scope: 'strawb',
      name: 'Business',
      formatted_account: '00-0000-0000000-00',
      type: 'CHECKING',
      status: 'ACTIVE',
      attributes: '["TRANSACTIONS"]',
      connection_id: 'conn_fixture_bank',
      connection_name: 'Sample Bank',
      connection_type: 'classic',
      connection_logo: 'https://example.com/logo.png',
      authorisation_id: 'auth_fixture',
      credentials_id: 'creds_fixture',
      currency: 'NZD',
      balance_cents: 608452,
      available_balance_cents: 598452,
      credit_limit_cents: 500000,
      refreshed_balance_at: AT,
      refreshed_meta_at: AT,
      refreshed_transactions_at: AT,
      created_at: AT,
      updated_at: LATER,
    }
    await db('accounts').insert(full)

    const row = await db('accounts').where({ akahu_id: 'acc_full' }).first()
    expect(Object.keys(row).sort()).toEqual(Object.keys(ACCOUNT_KEYS).sort())
    expect(row).toStrictEqual({ id: row.id, ...full })
  })

  it('accepts every scope and source, and refuses anything else', async () => {
    let n = 0
    for (const scope of SCOPES) {
      for (const source of SOURCES) {
        await db('accounts').insert(account({ akahu_id: `acc_${n++}`, scope, source }))
      }
    }
    expect(await db('accounts').count('* as n').first()).toEqual({
      n: SCOPES.length * SOURCES.length,
    })

    await expect(
      db('accounts').insert(account({ akahu_id: 'acc_x', scope: 'bogus' })),
    ).rejects.toThrow(/CHECK constraint failed: scope/)
    await expect(
      db('accounts').insert(account({ akahu_id: 'acc_y', source: 'bogus' })),
    ).rejects.toThrow(/CHECK constraint failed: source/)
    await expect(
      db('accounts').insert(account({ akahu_id: 'acc_z', scope: null })),
    ).rejects.toThrow(/NOT NULL constraint failed: accounts.scope/)
  })

  it("refuses a second account with the same Akahu id", async () => {
    await db('accounts').insert(account({ akahu_id: 'acc_dup' }))

    await expect(db('accounts').insert(account({ akahu_id: 'acc_dup' }))).rejects.toThrow(
      /UNIQUE constraint failed: accounts.akahu_id/,
    )
  })

  it('lets Xero accounts have no Akahu id, but not Akahu ones', async () => {
    await db('accounts').insert([
      account({ name: 'Xero one', source: 'xero' }),
      account({ name: 'Xero two', source: 'xero' }),
    ])
    expect(await db('accounts').whereNull('akahu_id').count('* as n').first()).toEqual({
      n: 2,
    })

    await expect(db('accounts').insert(account({ source: 'akahu' }))).rejects.toThrow(
      /CHECK constraint failed: accounts_akahu_has_akahu_id/,
    )
  })
})

describe('sync_runs (Done-when 3)', () => {
  beforeEach(async () => {
    await db.migrate.latest()
  })

  it('has exactly the columns of the SyncRun type', async () => {
    expect((await columns('sync_runs')).sort()).toEqual(
      Object.keys(SYNC_RUN_KEYS).sort(),
    )
  })

  it('starts a run as running, unfinished, with zero counts', async () => {
    const [id] = await db('sync_runs').insert({ started_at: AT })

    const row = await db('sync_runs').where({ id }).first()
    expect(Object.keys(row).sort()).toEqual(Object.keys(SYNC_RUN_KEYS).sort())
    expect(row).toStrictEqual({
      id,
      started_at: AT,
      finished_at: null,
      outcome: 'running',
      inserted_count: 0,
      updated_count: 0,
      pending_mirrored_count: 0,
      error_message: null,
    } satisfies SyncRun)
  })

  it('records a failed run with its error text', async () => {
    const failed: Omit<SyncRun, 'id'> = {
      started_at: AT,
      finished_at: LATER,
      outcome: 'failed',
      inserted_count: 3,
      updated_count: 1,
      pending_mirrored_count: 2,
      error_message: 'Akahu returned 503',
    }
    const [id] = await db('sync_runs').insert(failed)

    expect(await db('sync_runs').where({ id }).first()).toStrictEqual({ id, ...failed })
  })

  it('refuses a failed run without error text', async () => {
    await expect(
      db('sync_runs').insert({ started_at: AT, finished_at: LATER, outcome: 'failed' }),
    ).rejects.toThrow(/CHECK constraint failed: sync_runs_failed_has_error/)
  })

  it('is running exactly while it has no finished_at', async () => {
    await expect(
      db('sync_runs').insert({ started_at: AT, finished_at: LATER, outcome: 'running' }),
    ).rejects.toThrow(/CHECK constraint failed: sync_runs_running_iff_unfinished/)
    await expect(
      db('sync_runs').insert({ started_at: AT, outcome: 'success' }),
    ).rejects.toThrow(/CHECK constraint failed: sync_runs_running_iff_unfinished/)
  })

  it('refuses a negative count', async () => {
    for (const count of ['inserted_count', 'updated_count', 'pending_mirrored_count']) {
      await expect(
        db('sync_runs').insert({ started_at: AT, [count]: -1 }),
      ).rejects.toThrow(/CHECK constraint failed: sync_runs_counts_non_negative/)
    }
    expect(await db('sync_runs').count('* as n').first()).toEqual({ n: 0 })
  })

  it('refuses an unknown outcome', async () => {
    await expect(
      db('sync_runs').insert({ started_at: AT, finished_at: LATER, outcome: 'bogus' }),
    ).rejects.toThrow(/CHECK constraint failed: outcome/)
  })

  it('allows one running run at a time (prd-01 Ruling 6)', async () => {
    const [first] = await db('sync_runs').insert({ started_at: AT })

    await expect(db('sync_runs').insert({ started_at: LATER })).rejects.toThrow(
      /UNIQUE constraint failed: sync_runs.outcome/,
    )

    await db('sync_runs')
      .where({ id: first })
      .update({ outcome: 'success', finished_at: LATER })
    await db('sync_runs').insert({ started_at: LATER })
    await db('sync_runs')
      .where({ outcome: 'running' })
      .update({ outcome: 'success', finished_at: LATER })
    expect(
      await db('sync_runs').where({ outcome: 'success' }).count('* as n').first(),
    ).toEqual({ n: 2 })
  })
})

describe('category_corrections (Done-when 4)', () => {
  let settledId: number
  let pendingId: number

  beforeEach(async () => {
    await db.migrate.latest()
    settledId = (await db('transactions').where({ akahu_id: R2 }).first('id')).id
    ;[pendingId] = await db('transactions').insert({
      account_id: 'acc_fixture_everyday',
      status: 'pending',
      amount_cents: -1200,
    })
  })

  const correction = (fields: Row) => ({
    to_category: 'Convenience stores',
    corrected_at: AT,
    source: 'user',
    ...fields,
  })

  it('has exactly the columns of the CategoryCorrection type', async () => {
    expect((await columns('category_corrections')).sort()).toEqual(
      Object.keys(CORRECTION_KEYS).sort(),
    )
  })

  it('holds a correction for an existing transaction, from a category or from none', async () => {
    const rows: Omit<CategoryCorrection, 'id'>[] = [
      {
        transaction_id: settledId,
        from_category: 'Bakeries',
        to_category: 'Convenience stores',
        corrected_at: AT,
        source: 'user',
      },
      {
        transaction_id: settledId,
        from_category: null,
        to_category: 'Bakeries',
        corrected_at: LATER,
        source: 'claude',
      },
    ]
    for (const row of rows) await db('category_corrections').insert(row)

    const stored = await db('category_corrections').orderBy('id')
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(CORRECTION_KEYS).sort())
    }
    expect(stored).toStrictEqual(rows.map((row, i) => ({ id: stored[i].id, ...row })))
  })

  it('accepts every correction source, and refuses akahu, unknown or none', async () => {
    for (const source of CORRECTION_SOURCES) {
      await db('category_corrections').insert(
        correction({ transaction_id: settledId, source }),
      )
    }
    expect(await db('category_corrections').pluck('source')).toEqual(CORRECTION_SOURCES)

    for (const source of ['akahu', 'bogus']) {
      await expect(
        db('category_corrections').insert(correction({ transaction_id: settledId, source })),
      ).rejects.toThrow(/CHECK constraint failed: source/)
    }
    const refusal = /NOT NULL constraint failed: category_corrections\.source$/
    await expect(
      db('category_corrections').insert(correction({ transaction_id: settledId, source: null })),
      'set to null',
    ).rejects.toThrow(refusal)
    await expect(
      db('category_corrections').insert(
        omit(correction({ transaction_id: settledId }), 'source'),
      ),
      'left out',
    ).rejects.toThrow(refusal)
  })

  it('refuses a correction for a transaction that does not exist', async () => {
    const top = await db('transactions').max('id as id').first()

    await expect(
      db('category_corrections').insert(correction({ transaction_id: top!.id + 1 })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it("deletes a transaction's corrections with it, and only its own", async () => {
    await db('category_corrections').insert([
      correction({ transaction_id: pendingId }),
      correction({ transaction_id: settledId }),
    ])

    await db('transactions').where({ id: pendingId }).del()

    expect(await db('category_corrections').pluck('transaction_id')).toEqual([settledId])
  })
})

describe('rollback (Done-when 8)', () => {
  it('removes every new table, index and column without rebuilding transactions', async () => {
    await db.migrate.latest()
    const settledId = (await db('transactions').where({ akahu_id: R2 }).first('id')).id
    await db('accounts').insert({ akahu_id: 'acc_a', name: 'A', created_at: AT, updated_at: AT })
    await db('sync_runs').insert({ started_at: AT })
    await db('category_corrections').insert({
      transaction_id: settledId,
      to_category: 'Bakeries',
      corrected_at: AT,
      source: 'user',
    })
    for (const table of NEW_TABLES) expect(await sequence(table)).toBe(1)

    while ((await applied()).includes(FIRST)) await db.migrate.down()

    for (const file of OURS) expect(await applied()).not.toContain(file)
    expect(
      await db('sqlite_master')
        .whereIn('tbl_name', NEW_TABLES)
        .orWhereIn('name', ['transactions_account_status_idx', 'sync_runs_one_running'])
        .pluck('name'),
    ).toEqual([])
    expect(
      await db('sqlite_sequence').whereIn('name', NEW_TABLES).pluck('name'),
    ).toEqual([])

    expect(await columns('transactions')).toEqual(beforeColumns)
    // `up` repaired R1's missing category; `down` cannot tell a repaired
    // category from one that was always there, so it stays repaired.
    expect(await db('transactions').orderBy('id')).toStrictEqual(
      before.map((row) => (row.akahu_id === R1 ? { ...row, category: 'Bakeries' } : row)),
    )
    expect(await sequence('transactions')).toBe(beforeSequence)

    await db.migrate.latest()
    expect((await columns('transactions')).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
  })

  it('deletes pending rows, so none is left looking settled', async () => {
    await db.migrate.latest()
    await db('transactions').insert([
      { account_id: 'acc_fixture_everyday', status: 'pending', amount_cents: -1200 },
      { account_id: 'acc_fixture_everyday', status: 'pending', amount_cents: -1200 },
    ])

    while ((await applied()).includes(FIRST)) await db.migrate.down()

    expect(await db('transactions').count('* as n').first()).toEqual({ n: before.length })
    expect(await db('transactions').whereNull('akahu_id').count('* as n').first()).toEqual({
      n: 0,
    })
  })
})

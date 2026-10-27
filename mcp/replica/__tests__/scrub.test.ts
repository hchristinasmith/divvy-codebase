// The replica scrub (prd-03 Ruling 2; Done when 2, 3). This test fails if:
//   - a sentinel planted in a column or table the allowlist does not name
//     (transaction reference, particulars, code, card suffix, other account,
//     a token column, sync error text, users' passwords, agent and insight
//     text, settings rows outside SETTING_KEYS) is found in any cell of the
//     replica, or anywhere in its bytes;
//   - the full account number appears, or its last four digits do not;
//   - any xero_* table reaches the replica;
//   - a column or table added to the live schema reaches the replica without
//     an allowlist edit;
//   - the replica's tables or columns differ from the list written out here,
//     which is the list the PR states for review.
//
// The live fixture is the real migrations run against a scratch file, by
// path (mcp/ never imports server/, Ruling 6), then filled with sentinels.

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import knex from 'knex'
import type { Knex } from 'knex'
import sqlite3 from 'sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { systemClock } from '../../contracts.ts'
import { refreshReplica } from '../refresh.ts'
import { all, close, openDatabase } from '../scrub.ts'

const MIGRATIONS = fileURLToPath(new URL('../../../server/db/migrations', import.meta.url))

// Written out independently of allowlist.ts, so an allowlist edit has to
// edit this list too, in the same diff a reviewer reads.
const EXPECTED_REPLICA: Record<string, string[]> = {
  accounts: ['id', 'akahu_id', 'source', 'scope', 'name', 'balance_cents', 'account_last4'],
  account_settings: ['account_id', 'role'],
  bills: ['id', 'scope', 'name', 'amount_cents', 'repeat', 'first_due_date'],
  bill_payments: ['bill_id', 'due_date'],
  budgets: ['id', 'scope', 'category', 'limit_cents'],
  goals: ['id', 'name', 'target_cents', 'target_date'],
  goal_contributions: ['goal_id', 'amount_cents'],
  habit_verdicts: ['transaction_id', 'verdict'],
  settings: ['key', 'value'],
  sync_runs: ['started_at', 'finished_at', 'outcome'],
  transactions: [
    'id',
    'account_id',
    'source',
    'date',
    'description',
    'amount_cents',
    'merchant_name',
    'category',
    'category_source',
    'status',
  ],
  replica_meta: ['built_at', 'last_sync_at', 'data_as_of'],
}

const FULL_ACCOUNT_NUMBER = '02-0108-0987654-321'
const ACCOUNT_DIGITS = '0201080987654321'
const LAST_FOUR = '4321'

/** Every value that must never reach the replica, by where it was planted. */
const SENTINELS = {
  reference: 'SNTL-REFERENCE',
  particulars: 'SNTL-PARTICULARS',
  code: 'SNTL-CODE',
  cardSuffix: 'SNTL-CARD-SUFFIX',
  otherAccount: 'SNTL-OTHER-ACCOUNT',
  txnConnectionId: 'SNTL-TXN-CONNECTION',
  akahuCategory: 'SNTL-AKAHU-CATEGORY',
  merchantNzbn: 'SNTL-NZBN',
  accessToken: 'SNTL-XERO-ACCESS-TOKEN-0000000000000',
  refreshToken: 'SNTL-XERO-REFRESH-TOKEN-000000000000',
  tenantId: 'SNTL-XERO-TENANT-ID-0000000000000000',
  xeroScopes: 'SNTL-XERO-SCOPES',
  xeroBill: 'SNTL-XERO-BILL',
  xeroInvoice: 'SNTL-XERO-INVOICE',
  xeroPayRun: 'SNTL-XERO-PAYRUN',
  syncError: 'SNTL-SYNC-ERROR',
  authorisationId: 'SNTL-AUTHORISATION-ID',
  credentialsId: 'SNTL-CREDENTIALS-ID',
  accountConnectionId: 'SNTL-ACCOUNT-CONNECTION',
  password: 'SNTL-PASSWORD',
  settingsToken: 'SNTL-SETTINGS-TOKEN',
  budgetNote: 'SNTL-BUDGET-NOTE',
  proposalReason: 'SNTL-PROPOSAL-REASON',
  insightBody: 'SNTL-INSIGHT-BODY',
  agentCursor: 'SNTL-AGENT-CURSOR',
  correction: 'SNTL-CORRECTION',
  wishlist: 'SNTL-WISHLIST',
  challenge: 'SNTL-CHALLENGE',
  subscriptionMark: 'm:SNTL-SUBSCRIPTION',
  alert: 'SNTL-ALERT',
} as const

const NOW = '2026-10-28T01:00:00.000Z'

function liveDb(filename: string): Knex {
  return knex({ client: 'sqlite3', connection: { filename }, useNullAsDefault: true, migrations: { directory: MIGRATIONS } })
}

/** Fills every table with one row that carries a sentinel where it can. */
async function plantSentinels(db: Knex): Promise<void> {
  const [accountId] = await db('accounts').insert({
    akahu_id: 'acc_personal',
    source: 'akahu',
    scope: 'personal',
    name: 'Everyday',
    formatted_account: FULL_ACCOUNT_NUMBER,
    authorisation_id: SENTINELS.authorisationId,
    credentials_id: SENTINELS.credentialsId,
    connection_id: SENTINELS.accountConnectionId,
    balance_cents: 150000,
    created_at: NOW,
    updated_at: NOW,
  })
  await db('account_settings').insert({ account_id: accountId, role: 'current', updated_at: NOW })
  const [transactionId] = await db('transactions').insert({
    akahu_id: 'trans_1',
    account_id: 'acc_personal',
    connection_id: SENTINELS.txnConnectionId,
    date: '2026-10-27T03:00:00.000Z',
    description: 'Flat white',
    amount_cents: -550,
    merchant_name: 'Corner Cafe',
    category: 'Eating out',
    category_source: 'user',
    status: 'settled',
    source: 'akahu',
    reference: SENTINELS.reference,
    particulars: SENTINELS.particulars,
    code: SENTINELS.code,
    card_suffix: SENTINELS.cardSuffix,
    other_account: SENTINELS.otherAccount,
    akahu_category_name: SENTINELS.akahuCategory,
    merchant_nzbn: SENTINELS.merchantNzbn,
  })
  await db('sync_runs').insert({ started_at: NOW, finished_at: NOW, outcome: 'failed', error_message: SENTINELS.syncError })
  await db('settings').insert([
    { key: 'tax_rate_bp', value: '2800', updated_at: NOW },
    { key: 'akahu_user_token', value: SENTINELS.settingsToken, updated_at: NOW },
  ])
  const [billId] = await db('bills').insert({
    scope: 'personal',
    name: 'Power',
    amount_cents: 12000,
    repeat: 'monthly',
    first_due_date: '2026-11-03',
    created_at: NOW,
    updated_at: NOW,
  })
  await db('bill_payments').insert({ bill_id: billId, due_date: '2026-11-03', amount_cents: 12000, paid_at: NOW })
  await db('budgets').insert({
    scope: 'personal',
    category: 'Eating out',
    limit_cents: 20000,
    note: SENTINELS.budgetNote,
    created_at: NOW,
    updated_at: NOW,
  })
  const [goalId] = await db('goals').insert({ name: 'Bike', target_cents: 90000, target_date: '2027-03-01', created_at: NOW, updated_at: NOW })
  await db('goal_contributions').insert({ goal_id: goalId, amount_cents: 5000, contributed_at: NOW })
  await db('habit_verdicts').insert({ transaction_id: transactionId, verdict: 'worth_it', created_at: NOW, updated_at: NOW })
  await db('category_corrections').insert({
    transaction_id: transactionId,
    from_category: SENTINELS.correction,
    to_category: 'Eating out',
    corrected_at: NOW,
    source: 'user',
  })
  await db('category_proposals').insert({
    transaction_id: transactionId,
    proposed_category: 'Eating out',
    confidence: 0.5,
    reason: SENTINELS.proposalReason,
    origin: 'rule',
    status: 'pending',
    created_at: NOW,
  })
  await db('insights').insert({
    kind: 'report',
    title: 'Week',
    body_md: SENTINELS.insightBody,
    scope: 'personal',
    period: '2026-W44',
    created_at: NOW,
  })
  await db('agent_runs').insert({
    kind: 'category',
    trigger: 'manual',
    started_at: NOW,
    finished_at: NOW,
    outcome: 'success',
    cursor: SENTINELS.agentCursor,
  })
  await db('alert_dismissals').insert({ alert_id: SENTINELS.alert, dismissed_at: NOW })
  await db('subscription_marks').insert({
    scope: 'personal',
    merchant_key: SENTINELS.subscriptionMark,
    answer: 'subscription',
    created_at: NOW,
    updated_at: NOW,
  })
  const [userId] = await db('users').insert({ email: 'h@example.com', password: SENTINELS.password })
  await db('user_challenges').insert({ id: 'c1', user_id: userId, challenge_id: SENTINELS.challenge })
  await db('wishlist_items').insert({ user_id: userId, name: SENTINELS.wishlist, target_amt: 1 })
  await db('xero_connection').insert({
    id: 1,
    access_token_enc: Buffer.from(SENTINELS.accessToken),
    refresh_token_enc: Buffer.from(SENTINELS.refreshToken),
    tenant_id_enc: Buffer.from(SENTINELS.tenantId),
    expires_at: NOW,
    status: 'connected',
    scopes: SENTINELS.xeroScopes,
    connected_at: NOW,
  })
  const xeroDoc = {
    status: 'AUTHORISED',
    date: '2026-10-01',
    currency: 'NZD',
    total_cents: 100,
    amount_due_cents: 100,
    amount_paid_cents: 0,
    synced_at: NOW,
  }
  await db('xero_bills').insert({ ...xeroDoc, invoice_id: 'b1', contact_name: SENTINELS.xeroBill, type: 'ACCPAY' })
  await db('xero_invoices').insert({ ...xeroDoc, invoice_id: 'i1', contact_name: SENTINELS.xeroInvoice, type: 'ACCREC' })
  await db('xero_pay_runs').insert({
    pay_run_id: SENTINELS.xeroPayRun,
    period_start: '2026-10-01',
    period_end: '2026-10-14',
    payment_date: '2026-10-15',
    status: 'POSTED',
    total_cost_cents: 80000,
    total_pay_cents: 80000,
    synced_at: NOW,
  })
  await db('xero_profit_loss').insert({
    period_from: '2026-04-01',
    period_to: '2026-09-30',
    basis: 'accrual',
    net_profit_cents: 1,
    fetched_at: NOW,
  })
}

type Cell = string | number | null | Buffer
type Row = Record<string, Cell>

async function readAll(path: string): Promise<Map<string, Row[]>> {
  const db = await openDatabase(path, sqlite3.OPEN_READONLY)
  try {
    const tables = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    const out = new Map<string, Row[]>()
    for (const { name } of tables) out.set(name, await all<Row>(db, `SELECT * FROM "${name}"`))
    return out
  } finally {
    await close(db)
  }
}

async function columnsOf(path: string): Promise<Map<string, string[]>> {
  const db = await openDatabase(path, sqlite3.OPEN_READONLY)
  try {
    const tables = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
    const out = new Map<string, string[]>()
    for (const { name } of tables) {
      out.set(name, (await all<{ name: string }>(db, `PRAGMA table_info("${name}")`)).map((c) => c.name))
    }
    return out
  } finally {
    await close(db)
  }
}

function cellText(cell: Cell): string {
  return Buffer.isBuffer(cell) ? cell.toString('latin1') : String(cell)
}

/** Every `table.column` cell whose text contains `needle`. */
function cellsContaining(tables: Map<string, Row[]>, needle: string): string[] {
  const hits: string[] = []
  for (const [table, rows] of tables) {
    for (const row of rows) {
      for (const [column, cell] of Object.entries(row)) {
        if (cellText(cell).includes(needle)) hits.push(`${table}.${column}`)
      }
    }
  }
  return hits
}

let template: string
let templateDir: string
let dir: string
let livePath: string
let replicaPath: string

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), 'divvy-scrub-template-'))
  template = join(templateDir, 'live.sqlite3')
  const db = liveDb(template)
  try {
    await db.migrate.latest()
    await plantSentinels(db)
  } finally {
    await db.destroy()
  }
}, 30_000)
afterAll(() => rmSync(templateDir, { recursive: true, force: true }))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'divvy-scrub-'))
  livePath = join(dir, 'live.sqlite3')
  replicaPath = join(dir, 'replica.sqlite3')
  copyFileSync(template, livePath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function refresh(): Promise<void> {
  await refreshReplica({ livePath, replicaPath, clock: systemClock })
}

describe('the sentinel scan', () => {
  it('the live fixture really holds every sentinel and the full account number', async () => {
    const live = await readAll(livePath)
    for (const sentinel of [...Object.values(SENTINELS), FULL_ACCOUNT_NUMBER]) {
      expect(cellsContaining(live, sentinel), sentinel).not.toEqual([])
    }
  })

  it('finds no sentinel in any cell of any table of the replica', async () => {
    await refresh()
    const replica = await readAll(replicaPath)
    const found = Object.values(SENTINELS).flatMap((sentinel) =>
      cellsContaining(replica, sentinel).map((where) => `${sentinel} in ${where}`),
    )
    expect(found).toEqual([])
  })

  it('finds no sentinel anywhere in the replica file bytes, free pages included', async () => {
    await refresh()
    const bytes = readFileSync(replicaPath).toString('latin1')
    const found = [...Object.values(SENTINELS), FULL_ACCOUNT_NUMBER, ACCOUNT_DIGITS].filter((s) => bytes.includes(s))
    expect(found).toEqual([])
  })

  it('carries the account number only as its last four digits', async () => {
    await refresh()
    const replica = await readAll(replicaPath)
    expect(cellsContaining(replica, FULL_ACCOUNT_NUMBER)).toEqual([])
    expect(cellsContaining(replica, ACCOUNT_DIGITS)).toEqual([])
    expect(cellsContaining(replica, '0987654')).toEqual([])
    expect(replica.get('accounts')?.map((row) => row.account_last4)).toEqual([LAST_FOUR])
  })

  it('still carries the allowlisted values, so an empty replica cannot pass the scan', async () => {
    await refresh()
    const replica = await readAll(replicaPath)
    const [transaction] = replica.get('transactions') ?? []
    expect(transaction).toMatchObject({
      account_id: 'acc_personal',
      date: '2026-10-27T03:00:00.000Z',
      description: 'Flat white',
      amount_cents: -550,
      merchant_name: 'Corner Cafe',
      category: 'Eating out',
      category_source: 'user',
      status: 'settled',
    })
    expect(replica.get('accounts')?.[0]).toMatchObject({ akahu_id: 'acc_personal', name: 'Everyday', balance_cents: 150000 })
    expect(replica.get('sync_runs')).toEqual([{ started_at: NOW, finished_at: NOW, outcome: 'failed' }])
  })

  it('copies only the settings rows whose key is in SETTING_KEYS', async () => {
    await refresh()
    const replica = await readAll(replicaPath)
    expect(replica.get('settings')).toEqual([{ key: 'tax_rate_bp', value: '2800' }])
  })
})

describe('the allowlist is the whole replica', () => {
  it('has exactly the listed tables, each with exactly the listed columns', async () => {
    await refresh()
    const columns = await columnsOf(replicaPath)
    expect([...columns.keys()].sort()).toEqual(Object.keys(EXPECTED_REPLICA).sort())
    for (const [table, expected] of Object.entries(EXPECTED_REPLICA)) {
      expect([...(columns.get(table) ?? [])].sort(), table).toEqual([...expected].sort())
    }
  })

  it('fails closed: a column or table added to the live database without an allowlist edit is absent', async () => {
    const db = liveDb(livePath)
    try {
      await db.raw('ALTER TABLE transactions ADD COLUMN new_secret TEXT')
      await db.raw('ALTER TABLE accounts ADD COLUMN new_secret TEXT')
      await db('transactions').update({ new_secret: 'SNTL-NEW-COLUMN' })
      await db('accounts').update({ new_secret: 'SNTL-NEW-ACCOUNT-COLUMN' })
      await db.raw('CREATE TABLE new_table (secret TEXT)')
      await db('new_table').insert({ secret: 'SNTL-NEW-TABLE' })
    } finally {
      await db.destroy()
    }
    await refresh()
    const columns = await columnsOf(replicaPath)
    expect(columns.has('new_table')).toBe(false)
    expect(columns.get('transactions')).not.toContain('new_secret')
    expect(columns.get('accounts')).not.toContain('new_secret')
    const replica = await readAll(replicaPath)
    for (const sentinel of ['SNTL-NEW-COLUMN', 'SNTL-NEW-ACCOUNT-COLUMN', 'SNTL-NEW-TABLE']) {
      expect(cellsContaining(replica, sentinel), sentinel).toEqual([])
    }
  })
})

describe('Xero tables (prd-05)', () => {
  it('every xero_* table is populated in the live fixture and absent from the replica', async () => {
    const live = await readAll(livePath)
    const xeroTables = [...live.keys()].filter((name) => name.startsWith('xero_'))
    expect(xeroTables).toEqual(expect.arrayContaining(['xero_connection', 'xero_pay_runs']))
    for (const table of xeroTables) expect(live.get(table)?.length, table).toBeGreaterThan(0)

    await refresh()
    const replicaTables = [...(await columnsOf(replicaPath)).keys()]
    expect(replicaTables.filter((name) => name.startsWith('xero_'))).toEqual([])
  })
})

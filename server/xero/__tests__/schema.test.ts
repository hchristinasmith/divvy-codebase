// prd-05 wave 1 (#25): the `xero_*` tables, Rulings 2, 3, 6 and 7. Covers
// 20261025130000_xero_tables.js from the schema just before it, up and back
// down. Every fixture value here is invented; nothing calls Xero.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../db/knexfile.js'
import { migrateToJustBefore } from '../../db/__tests__/migrateToJustBefore.ts'
import type {
  XeroBill,
  XeroInvoice,
  XeroPayRun,
  XeroProfitLoss,
} from '../../../models/xero.ts'

const OURS = '20261025130000_xero_tables.js'
const MIGRATION_TEXT = readFileSync(
  new URL(`../../db/migrations/${OURS}`, import.meta.url),
  'utf8',
)

type Row = Record<string, unknown>

// Every column of every table, as `PRAGMA table_info` reports its declared
// type and nullability. The schema tests below fail if a column is added,
// dropped, retyped or loosened without this changing too.
const SCHEMA: Record<string, Record<string, string>> = {
  xero_connection: {
    id: 'integer not null',
    access_token_enc: 'blob',
    refresh_token_enc: 'blob',
    tenant_id_enc: 'blob',
    expires_at: 'datetime',
    version: 'integer not null',
    status: 'text not null',
    scopes: 'text',
    connected_at: 'datetime',
    last_refresh_at: 'datetime',
  },
  xero_invoices: {
    invoice_id: 'text not null',
    invoice_number: 'text',
    contact_name: 'text not null',
    type: 'text not null',
    status: 'text not null',
    date: 'text not null',
    due_date: 'text',
    currency: 'text not null',
    total_cents: 'integer not null',
    amount_due_cents: 'integer not null',
    amount_paid_cents: 'integer not null',
    synced_at: 'datetime not null',
  },
  xero_bills: {
    invoice_id: 'text not null',
    invoice_number: 'text',
    contact_name: 'text not null',
    type: 'text not null',
    status: 'text not null',
    date: 'text not null',
    due_date: 'text',
    currency: 'text not null',
    total_cents: 'integer not null',
    amount_due_cents: 'integer not null',
    amount_paid_cents: 'integer not null',
    synced_at: 'datetime not null',
  },
  xero_pay_runs: {
    pay_run_id: 'text not null',
    period_start: 'text not null',
    period_end: 'text not null',
    payment_date: 'text not null',
    status: 'text not null',
    total_cost_cents: 'integer not null',
    total_pay_cents: 'integer not null',
    synced_at: 'datetime not null',
  },
  xero_profit_loss: {
    id: 'integer not null',
    period_from: 'text not null',
    period_to: 'text not null',
    basis: 'text not null',
    net_profit_cents: 'integer not null',
    fetched_at: 'datetime not null',
  },
}
const XERO_TABLES = Object.keys(SCHEMA).sort()

// Each field the client returns (`models/xero.ts`), and the column that
// stores it. `Record<keyof …>` makes TypeScript refuse this file if the
// client gains a field with no column here; the test checks each named
// column exists.
const INVOICE_FIELDS: Record<keyof XeroInvoice, string> = {
  invoiceId: 'invoice_id',
  invoiceNumber: 'invoice_number',
  contactName: 'contact_name',
  type: 'type',
  status: 'status',
  date: 'date',
  dueDate: 'due_date',
  currency: 'currency',
  totalCents: 'total_cents',
  amountDueCents: 'amount_due_cents',
  amountPaidCents: 'amount_paid_cents',
}
const BILL_FIELDS: Record<keyof XeroBill, string> = { ...INVOICE_FIELDS }
const PAY_RUN_FIELDS: Record<keyof XeroPayRun, string> = {
  payRunId: 'pay_run_id',
  periodStart: 'period_start',
  periodEnd: 'period_end',
  paymentDate: 'payment_date',
  status: 'status',
  totalCostCents: 'total_cost_cents',
  totalPayCents: 'total_pay_cents',
}
const PROFIT_LOSS_FIELDS: Record<keyof XeroProfitLoss, string> = {
  from: 'period_from',
  to: 'period_to',
  basis: 'basis',
  netProfitCents: 'net_profit_cents',
}
// What each table stores beyond the client's fields.
const CLIENT_TABLES: [table: string, fields: Record<string, string>, extra: string[]][] = [
  ['xero_invoices', INVOICE_FIELDS, ['synced_at']],
  ['xero_bills', BILL_FIELDS, ['synced_at']],
  ['xero_pay_runs', PAY_RUN_FIELDS, ['synced_at']],
  ['xero_profit_loss', PROFIT_LOSS_FIELDS, ['id', 'fetched_at']],
]

const AT = '2026-10-25T03:00:00.000Z'
const LATER = '2026-10-25T04:30:00.000Z'
const ID_1 = '00000000-0000-0000-0000-000000000001'
const ID_2 = '00000000-0000-0000-0000-000000000002'
const CIPHER = Buffer.alloc(29, 1)
const CIPHER_2 = Buffer.alloc(48, 2)

const invoice = (fields: Row = {}): Row => ({
  invoice_id: ID_1,
  invoice_number: 'INV-0001',
  contact_name: 'Fixture Customer Ltd',
  type: 'ACCREC',
  status: 'AUTHORISED',
  date: '2026-10-01',
  due_date: '2026-10-31',
  currency: 'NZD',
  total_cents: 115000,
  amount_due_cents: 115000,
  amount_paid_cents: 0,
  synced_at: AT,
  ...fields,
})

const bill = (fields: Row = {}): Row => ({
  invoice_id: ID_1,
  invoice_number: 'SUP-REF-1',
  contact_name: 'Fixture Supplier Ltd',
  type: 'ACCPAY',
  status: 'AUTHORISED',
  date: '2026-10-02',
  due_date: '2026-11-20',
  currency: 'NZD',
  total_cents: 23000,
  amount_due_cents: 23000,
  amount_paid_cents: 0,
  synced_at: AT,
  ...fields,
})

const payRun = (fields: Row = {}): Row => ({
  pay_run_id: ID_1,
  period_start: '2026-10-13',
  period_end: '2026-10-19',
  payment_date: '2026-10-21',
  status: 'POSTED',
  total_cost_cents: 250000,
  total_pay_cents: 200000,
  synced_at: AT,
  ...fields,
})

const profitLoss = (fields: Row = {}): Row => ({
  period_from: '2026-04-01',
  period_to: '2026-10-25',
  basis: 'accrual',
  net_profit_cents: 1234500,
  fetched_at: AT,
  ...fields,
})

const vault = (fields: Row = {}): Row => ({
  id: 1,
  access_token_enc: CIPHER,
  refresh_token_enc: CIPHER,
  tenant_id_enc: CIPHER,
  expires_at: LATER,
  status: 'connected',
  scopes: 'offline_access accounting.reports.read',
  connected_at: AT,
  last_refresh_at: AT,
  ...fields,
})

// One valid row per table.
const VALID: Record<string, () => Row> = {
  xero_connection: () => vault(),
  xero_invoices: () => invoice(),
  xero_bills: () => bill(),
  xero_pay_runs: () => payRun(),
  xero_profit_loss: () => profitLoss(),
}

// `row` without `column`, so the insert leaves it out. Not `{ column: undefined }`:
// with `useNullAsDefault` knex binds that as NULL, which a column default
// never sees, so it could not catch a default creeping in.
function omit(row: Row, column: string): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== column))
}

const refusedBy = (check: string) => new RegExp(`CHECK constraint failed: ${check}$`)
const notNull = (table: string, column: string) =>
  new RegExp(`NOT NULL constraint failed: ${table}\\.${column}$`)

let db: Knex

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

async function tableInfo(table: string): Promise<ColumnInfo[]> {
  return db.raw('PRAGMA table_info(??)', [table])
}

async function tables(): Promise<string[]> {
  return db('sqlite_master').where({ type: 'table' }).orderBy('name').pluck('name')
}

// Every schema object (table, index, trigger) that does not belong to a
// `xero_` table, as SQLite stores it.
async function otherObjects(): Promise<Row[]> {
  const rows: Row[] = await db('sqlite_master')
    .orderBy(['type', 'name'])
    .select('type', 'name', 'tbl_name', 'sql')
  return rows.filter((r) => !String(r.tbl_name).startsWith('xero_'))
}

// The name of every CHECK on `table`, from the SQL SQLite stored for it.
async function checkNames(table: string): Promise<string[]> {
  const { sql } = await db('sqlite_master').where({ type: 'table', name: table }).first('sql')
  return [...String(sql).matchAll(/constraint (\w+) check/g)].map((m) => m[1])
}

async function count(table: string): Promise<number> {
  const row = await db(table).count('* as n').first()
  return Number(row?.n)
}

async function storedType(table: string, column: string): Promise<{ v: unknown; t: string }> {
  return db(table).first(db.raw('?? as v, typeof(??) as t', [column, column]))
}

async function applied(): Promise<string[]> {
  const [completed] = (await db.migrate.list()) as [{ name: string }[], unknown]
  return completed.map((m) => m.name)
}

let tablesBefore: string[]
let objectsBefore: Row[]

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore(db, OURS)
  tablesBefore = await tables()
  objectsBefore = await otherObjects()
  await db.migrate.up()
})

afterEach(async () => {
  await db.destroy()
})

describe('migration (Done-when 1, 7)', () => {
  it('creates exactly the xero_ tables and changes nothing else', async () => {
    expect(tablesBefore.filter((t) => t.startsWith('xero_'))).toEqual([])
    expect(await applied()).toContain(OURS)

    const after = await tables()
    expect(after.filter((t) => t.startsWith('xero_'))).toEqual(XERO_TABLES)
    expect(after.filter((t) => !t.startsWith('xero_'))).toEqual(tablesBefore)
    expect(await otherObjects()).toStrictEqual(objectsBefore)
  })

  it('rolls back to the schema it started from, with rows present', async () => {
    for (const table of XERO_TABLES) await db(table).insert(VALID[table]())
    for (const table of XERO_TABLES) expect(await count(table), table).toBe(1)

    await db.migrate.down()

    expect(await applied()).not.toContain(OURS)
    expect(await tables()).toEqual(tablesBefore)
    expect(await otherObjects()).toStrictEqual(objectsBefore)
  })

  it('names, creates and drops only xero_ tables, and never alters one', () => {
    expect(MIGRATION_TEXT).not.toMatch(/\b(accounts|transactions|sync_runs|settings)\b/i)
    expect(MIGRATION_TEXT).not.toMatch(/alterTable|dropColumn|renameTable|schema\.table\(/)
    expect(MIGRATION_TEXT).not.toMatch(/\.references\(|\.inTable\(/)

    const created = [...MIGRATION_TEXT.matchAll(/createTable\(\s*'([^']+)'/g)].map((m) => m[1])
    const dropped = [...MIGRATION_TEXT.matchAll(/dropTable\(\s*'([^']+)'/g)].map((m) => m[1])
    // Every createTable/dropTable call names its table as a literal, so the
    // two lists above see each one.
    expect(MIGRATION_TEXT.match(/createTable\(/g)).toHaveLength(created.length)
    expect(MIGRATION_TEXT.match(/dropTable\(/g)).toHaveLength(dropped.length)
    expect([...created].sort()).toEqual(XERO_TABLES)
    expect([...dropped].sort()).toEqual(XERO_TABLES)
  })
})

describe('schema (Done-when 2, 3)', () => {
  it.each(XERO_TABLES)('%s has exactly its columns, each with its type and nullability', async (table) => {
    const info = await tableInfo(table)
    expect(info.map((c) => c.name).sort()).toEqual(Object.keys(SCHEMA[table]).sort())
    for (const c of info) {
      expect(`${c.type.toLowerCase()}${c.notnull ? ' not null' : ''}`, `${table}.${c.name}`).toBe(
        SCHEMA[table][c.name],
      )
    }
  })

  it.each(CLIENT_TABLES)('%s stores every field the client returns', async (table, fields, extra) => {
    const columns = (await tableInfo(table)).map((c) => c.name)
    expect([...Object.values(fields), ...extra].sort()).toEqual(columns.sort())
  })

  it.each(XERO_TABLES)('%s names every CHECK after its table', async (table) => {
    const { sql } = await db('sqlite_master').where({ type: 'table', name: table }).first('sql')
    const names = await checkNames(table)
    expect(names.length).toBeGreaterThan(0)
    expect(String(sql).match(/check \(/g)).toHaveLength(names.length)
    for (const name of names) expect(name).toMatch(new RegExp(`^${table}_[a-z_]+$`))
  })

  it("keys invoices, bills and pay runs on Xero's own id", async () => {
    for (const [table, key] of [
      ['xero_invoices', 'invoice_id'],
      ['xero_bills', 'invoice_id'],
      ['xero_pay_runs', 'pay_run_id'],
    ]) {
      const pk = (await tableInfo(table)).filter((c) => c.pk).map((c) => c.name)
      expect(pk, table).toEqual([key])
    }
  })

  it('has no plaintext token or tenant column, and every _enc column is a blob', async () => {
    let encrypted = 0
    for (const table of XERO_TABLES) {
      for (const c of await tableInfo(table)) {
        expect(c.name, `${table}.${c.name}`).not.toMatch(/^(access_token|refresh_token|tenant_id)$/)
        if (/token|tenant/.test(c.name)) {
          expect(c.name, `${table}.${c.name}`).toMatch(/_enc$/)
        }
        if (c.name.endsWith('_enc')) {
          encrypted++
          expect(c.type.toLowerCase(), `${table}.${c.name}`).toBe('blob')
        }
      }
    }
    expect(encrypted).toBeGreaterThan(0)
  })

  it('makes every _cents column INTEGER, no column decimal, and version = 0 the only default', async () => {
    let cents = 0
    const defaults: string[] = []
    for (const table of XERO_TABLES) {
      for (const c of await tableInfo(table)) {
        expect(c.type.toLowerCase(), `${table}.${c.name}`).not.toMatch(
          /decimal|float|real|numeric|double/,
        )
        if (c.name.endsWith('_cents')) {
          cents++
          expect(c.type.toLowerCase(), `${table}.${c.name}`).toBe('integer')
        }
        if (c.dflt_value !== null) {
          expect(c.dflt_value, `${table}.${c.name}`).not.toContain('.')
          defaults.push(`${table}.${c.name}=${c.dflt_value}`)
        }
      }
    }
    expect(cents).toBeGreaterThan(0)
    expect(defaults).toEqual(["xero_connection.version='0'"])
  })
})

// Each `*_cents` column, whether it may be negative, and the CHECK that
// guards it. The first test pins this list to the schema.
const CENTS: [table: string, column: string, nonNegative: boolean, check: string][] = [
  ['xero_invoices', 'total_cents', false, 'xero_invoices_total_is_cents'],
  ['xero_invoices', 'amount_due_cents', true, 'xero_invoices_amount_due_non_negative'],
  ['xero_invoices', 'amount_paid_cents', false, 'xero_invoices_amount_paid_is_cents'],
  ['xero_bills', 'total_cents', false, 'xero_bills_total_is_cents'],
  ['xero_bills', 'amount_due_cents', true, 'xero_bills_amount_due_non_negative'],
  ['xero_bills', 'amount_paid_cents', false, 'xero_bills_amount_paid_is_cents'],
  ['xero_pay_runs', 'total_cost_cents', true, 'xero_pay_runs_total_cost_non_negative'],
  ['xero_pay_runs', 'total_pay_cents', true, 'xero_pay_runs_total_pay_non_negative'],
  ['xero_profit_loss', 'net_profit_cents', false, 'xero_profit_loss_net_profit_is_cents'],
]

describe('cents columns (Done-when 2)', () => {
  it('lists every _cents column the schema has, and no other', () => {
    const actual = XERO_TABLES.flatMap((table) =>
      Object.keys(SCHEMA[table])
        .filter((c) => c.endsWith('_cents'))
        .map((c) => `${table}.${c}`),
    )
    expect(CENTS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual.sort())
  })

  it.each(CENTS)(
    '%s.%s holds only integer cents',
    async (table, column, nonNegative, check) => {
      const row = VALID[table]()

      await db(table).insert({ ...row, [column]: 115000 })
      expect(await storedType(table, column)).toStrictEqual({ v: 115000, t: 'integer' })
      await db(table).del()

      for (const value of [12.5, '12.5', 0.1, '1e-2', 'bogus', '']) {
        await expect(db(table).insert({ ...row, [column]: value }), String(value)).rejects.toThrow(
          refusedBy(check),
        )
      }

      // SQLite's INTEGER affinity turns a lossless '100', REAL 100.0 or
      // '1e2' into the integer 100 before any CHECK runs. What lands is an
      // integer, which is the rule; this pins that nothing else lands.
      for (const value of ['100', db.raw('CAST(100 AS REAL)'), '1e2']) {
        await db(table).insert({ ...row, [column]: value })
        expect(await storedType(table, column), String(value)).toStrictEqual({ v: 100, t: 'integer' })
        await db(table).del()
      }

      if (nonNegative) {
        await expect(db(table).insert({ ...row, [column]: -1 })).rejects.toThrow(refusedBy(check))
      } else {
        await db(table).insert({ ...row, [column]: -1 })
        expect(await storedType(table, column)).toStrictEqual({ v: -1, t: 'integer' })
      }
      await db(table).del()
      await db(table).insert({ ...row, [column]: 0 })
      expect(await storedType(table, column)).toStrictEqual({ v: 0, t: 'integer' })
    },
  )
})

// Each date column, whether it may be NULL, its CHECK, and the column it
// must not come after or before (so an accepted value can be set on both).
const DATES: [table: string, column: string, nullable: boolean, check: string, partner?: string][] =
  [
    ['xero_invoices', 'date', false, 'xero_invoices_date_is_date'],
    ['xero_invoices', 'due_date', true, 'xero_invoices_due_date_is_date'],
    ['xero_bills', 'date', false, 'xero_bills_date_is_date'],
    ['xero_bills', 'due_date', true, 'xero_bills_due_date_is_date'],
    ['xero_pay_runs', 'period_start', false, 'xero_pay_runs_period_start_is_date', 'period_end'],
    ['xero_pay_runs', 'period_end', false, 'xero_pay_runs_period_end_is_date', 'period_start'],
    ['xero_pay_runs', 'payment_date', false, 'xero_pay_runs_payment_date_is_date'],
    ['xero_profit_loss', 'period_from', false, 'xero_profit_loss_period_from_is_date', 'period_to'],
    ['xero_profit_loss', 'period_to', false, 'xero_profit_loss_period_to_is_date', 'period_from'],
  ]

const REAL_DATES = ['2026-10-25', '2028-02-29']
const NOT_DATES: unknown[] = [
  '2026-02-29',
  '2026-02-30',
  '2026-13-01',
  '2026-2-3',
  20261025,
  '',
  'bogus',
  '2026-10-25 ',
  '2026-10-25T03:00:00.000Z',
]

describe('date columns', () => {
  it('lists every date CHECK the schema has, and no other', async () => {
    const actual: string[] = []
    for (const table of XERO_TABLES) {
      actual.push(...(await checkNames(table)).filter((name) => name.endsWith('_is_date')))
    }
    expect(DATES.map(([, , , check]) => check).sort()).toEqual(actual.sort())
  })

  it.each(DATES)('%s.%s holds only a real YYYY-MM-DD date', async (table, column, nullable, check, partner) => {
    const row = VALID[table]()

    for (const value of REAL_DATES) {
      await db(table).insert({ ...row, [column]: value, ...(partner ? { [partner]: value } : {}) })
      expect(await storedType(table, column), value).toStrictEqual({ v: value, t: 'text' })
      await db(table).del()
    }

    for (const value of NOT_DATES) {
      await expect(db(table).insert({ ...row, [column]: value }), String(value)).rejects.toThrow(
        refusedBy(check),
      )
    }
    expect(await count(table)).toBe(0)

    if (nullable) {
      await db(table).insert({ ...row, [column]: null })
      expect(await storedType(table, column)).toStrictEqual({ v: null, t: 'null' })
    }
  })
})

// Each instant column, whether it may be NULL, and its CHECK.
const INSTANTS: [table: string, column: string, nullable: boolean, check: string][] = [
  ['xero_connection', 'expires_at', true, 'xero_connection_expires_at_is_instant'],
  ['xero_connection', 'connected_at', true, 'xero_connection_connected_at_is_instant'],
  ['xero_connection', 'last_refresh_at', true, 'xero_connection_last_refresh_at_is_instant'],
  ['xero_invoices', 'synced_at', false, 'xero_invoices_synced_at_is_instant'],
  ['xero_bills', 'synced_at', false, 'xero_bills_synced_at_is_instant'],
  ['xero_pay_runs', 'synced_at', false, 'xero_pay_runs_synced_at_is_instant'],
  ['xero_profit_loss', 'fetched_at', false, 'xero_profit_loss_fetched_at_is_instant'],
]

const NOT_INSTANTS: unknown[] = [
  '2026-10-25T03:00:00Z',
  '2026-10-25T16:00:00.000+13:00',
  '2026-10-25T03:00:00.000',
  '2026-10-25 03:00:00',
  '2026-02-30T03:00:00.000Z',
  '2026-10-25T25:00:00.000Z',
  '2026-10-25',
  1761361200000,
  '',
]

describe('instant columns', () => {
  it('lists every datetime column the schema has', () => {
    const actual = XERO_TABLES.flatMap((table) =>
      Object.entries(SCHEMA[table])
        .filter(([, type]) => type.startsWith('datetime'))
        .map(([c]) => `${table}.${c}`),
    )
    expect(INSTANTS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual.sort())
  })

  it.each(INSTANTS)('%s.%s holds only an ISO-8601 UTC instant with millis', async (table, column, nullable, check) => {
    // A needs_reconnect vault requires nothing, so only the column under test decides.
    const row = table === 'xero_connection' ? vault({ status: 'needs_reconnect' }) : VALID[table]()

    for (const value of [AT, '2028-02-29T23:59:59.999Z']) {
      await db(table).insert({ ...row, [column]: value })
      expect(await storedType(table, column), value).toStrictEqual({ v: value, t: 'text' })
      await db(table).del()
    }

    for (const value of NOT_INSTANTS) {
      await expect(db(table).insert({ ...row, [column]: value }), String(value)).rejects.toThrow(
        refusedBy(check),
      )
    }
    expect(await count(table)).toBe(0)

    if (nullable) {
      await db(table).insert({ ...row, [column]: null })
      expect(await storedType(table, column)).toStrictEqual({ v: null, t: 'null' })
    }
  })
})

// Every NOT NULL column a writer must supply. Rowid-alias keys are filled in
// when left out, and `version` has a default; both are tested on their own.
const ROWID_KEYS = ['xero_connection.id', 'xero_profit_loss.id']
const DEFAULTED = ['xero_connection.version']
const NOT_NULL: [table: string, column: string][] = XERO_TABLES.flatMap((table) =>
  Object.entries(SCHEMA[table])
    .filter(([column, type]) => type.endsWith('not null') && ![...ROWID_KEYS, ...DEFAULTED].includes(`${table}.${column}`))
    .map(([column]): [string, string] => [table, column]),
)

describe('NOT NULL columns', () => {
  it('matches what SQLite reports, in both directions', async () => {
    const actual: string[] = []
    for (const table of XERO_TABLES) {
      for (const c of await tableInfo(table)) if (c.notnull) actual.push(`${table}.${c.name}`)
    }
    expect([...NOT_NULL.map(([t, c]) => `${t}.${c}`), ...ROWID_KEYS, ...DEFAULTED].sort()).toEqual(
      actual.sort(),
    )
    // The keys, synced_at and fetched_at must be among them.
    for (const required of [
      'xero_invoices.invoice_id',
      'xero_bills.invoice_id',
      'xero_pay_runs.pay_run_id',
      'xero_invoices.synced_at',
      'xero_bills.synced_at',
      'xero_pay_runs.synced_at',
      'xero_profit_loss.fetched_at',
      'xero_invoices.currency',
      'xero_bills.currency',
    ]) {
      expect(NOT_NULL.map(([t, c]) => `${t}.${c}`)).toContain(required)
    }
  })

  it.each(NOT_NULL)('%s.%s refuses NULL, and refuses being left out (no default)', async (table, column) => {
    const row = VALID[table]()

    await expect(db(table).insert({ ...row, [column]: null }), 'set to null').rejects.toThrow(
      notNull(table, column),
    )
    await expect(db(table).insert(omit(row, column)), 'left out').rejects.toThrow(
      notNull(table, column),
    )
    expect(await count(table)).toBe(0)
    await expect(db(table).insert(row), 'the valid row').resolves.toBeDefined()
  })
})

describe('xero_invoices and xero_bills (Ruling 6, 7)', () => {
  const DOCUMENTS: [table: string, build: (f?: Row) => Row, own: string, other: string][] = [
    ['xero_invoices', invoice, 'ACCREC', 'ACCPAY'],
    ['xero_bills', bill, 'ACCPAY', 'ACCREC'],
  ]

  it.each(DOCUMENTS)('%s round-trips a row with every column', async (table, build) => {
    const row = build({ invoice_number: null, due_date: null, currency: 'USD' })
    await db(table).insert(row)

    const stored = await db(table).first()
    expect(Object.keys(stored).sort()).toEqual(Object.keys(SCHEMA[table]).sort())
    expect(stored).toStrictEqual(row)
  })

  it.each(DOCUMENTS)('%s holds only its own Xero type', async (table, build, own, other) => {
    const check = `${table}_type_is_${own.toLowerCase()}`
    for (const type of [other, own.toLowerCase(), '']) {
      await expect(db(table).insert(build({ type })), type).rejects.toThrow(refusedBy(check))
    }
    await db(table).insert(build({ type: own }))
    expect(await db(table).pluck('type')).toEqual([own])
  })

  it.each(DOCUMENTS)('%s requires a three-letter upper-case currency, never assumed', async (table, build) => {
    for (const currency of ['nzd', 'NZ', 'NZDX', '', 'N$D', ' NZD']) {
      await expect(db(table).insert(build({ currency })), currency).rejects.toThrow(
        refusedBy(`${table}_currency_is_code`),
      )
    }
    await expect(db(table).insert(omit(build(), 'currency'))).rejects.toThrow(notNull(table, 'currency'))

    await db(table).insert(build({ invoice_id: ID_1, currency: 'NZD' }))
    await db(table).insert(build({ invoice_id: ID_2, currency: 'USD' }))
    expect(await db(table).orderBy('invoice_id').pluck('currency')).toEqual(['NZD', 'USD'])
  })
})

describe("upsert on Xero's own id (Done-when 4)", () => {
  const KEYED: [table: string, key: string, first: Row, second: Row][] = [
    [
      'xero_invoices',
      'invoice_id',
      invoice(),
      invoice({ amount_due_cents: 50000, amount_paid_cents: 65000, synced_at: LATER }),
    ],
    [
      'xero_bills',
      'invoice_id',
      bill(),
      bill({ due_date: '2026-11-27', amount_due_cents: 0, amount_paid_cents: 23000, synced_at: LATER }),
    ],
    [
      'xero_pay_runs',
      'pay_run_id',
      payRun(),
      payRun({ status: 'PAID', total_cost_cents: 251000, total_pay_cents: 201000, synced_at: LATER }),
    ],
  ]

  it.each(KEYED)('%s: the same id upserted twice is one row with the second values', async (table, key, first, second) => {
    await db(table).insert(first).onConflict(key).merge()
    await db(table).insert(second).onConflict(key).merge()

    const rows = await db(table)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(SCHEMA[table]).sort())
    expect(rows[0]).toStrictEqual(second)
  })

  it.each(KEYED)('%s: a different id is a second row', async (table, key, first) => {
    await db(table).insert(first).onConflict(key).merge()
    await db(table).insert({ ...first, [key]: ID_2 }).onConflict(key).merge()

    expect(await db(table).orderBy(key).pluck(key)).toEqual([ID_1, ID_2])
  })

  it.each(KEYED)('%s: a plain insert of the same id, or an empty id, is refused', async (table, key, first) => {
    await db(table).insert(first)

    await expect(db(table).insert(first)).rejects.toThrow(
      new RegExp(`UNIQUE constraint failed: ${table}\\.${key}$`),
    )
    await expect(db(table).insert({ ...first, [key]: '' })).rejects.toThrow(
      refusedBy(`${table}_${key}_not_empty`),
    )
    expect(await count(table)).toBe(1)
  })
})

describe('xero_pay_runs', () => {
  it('round-trips a pay run', async () => {
    const row = payRun()
    await db('xero_pay_runs').insert(row)

    const stored = await db('xero_pay_runs').first()
    expect(Object.keys(stored).sort()).toEqual(Object.keys(SCHEMA.xero_pay_runs).sort())
    expect(stored).toStrictEqual(row)
  })

  it('refuses a period that ends before it starts, and accepts a one-day period', async () => {
    await expect(
      db('xero_pay_runs').insert(payRun({ period_start: '2026-10-20', period_end: '2026-10-19' })),
    ).rejects.toThrow(refusedBy('xero_pay_runs_period_in_order'))

    await db('xero_pay_runs').insert(payRun({ period_start: '2026-10-19', period_end: '2026-10-19' }))
    expect(await count('xero_pay_runs')).toBe(1)
  })
})

describe('xero_profit_loss (Done-when 5)', () => {
  const PERIOD = ['period_from', 'period_to']

  it('round-trips a loss as negative cents', async () => {
    const row = profitLoss({ net_profit_cents: -4200 })
    const [id] = await db('xero_profit_loss').insert(row)

    const stored = await db('xero_profit_loss').first()
    expect(Object.keys(stored).sort()).toEqual(Object.keys(SCHEMA.xero_profit_loss).sort())
    expect(stored).toStrictEqual({ id, ...row })
  })

  it('keeps one row per period: a refetch replaces it with the newer fetched_at', async () => {
    await db('xero_profit_loss').insert(profitLoss()).onConflict(PERIOD).merge()
    const [first] = await db('xero_profit_loss')

    const refetch = profitLoss({ net_profit_cents: 1300000, fetched_at: LATER })
    await db('xero_profit_loss').insert(refetch).onConflict(PERIOD).merge()

    const rows = await db('xero_profit_loss')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toStrictEqual({ id: first.id, ...refetch })
  })

  it('adds a row for a different period', async () => {
    await db('xero_profit_loss').insert(profitLoss()).onConflict(PERIOD).merge()
    await db('xero_profit_loss')
      .insert(profitLoss({ period_to: '2026-09-30' }))
      .onConflict(PERIOD)
      .merge()

    expect(await db('xero_profit_loss').orderBy('period_to').pluck('period_to')).toEqual([
      '2026-09-30',
      '2026-10-25',
    ])
  })

  it('refuses a plain second insert of the same period', async () => {
    await db('xero_profit_loss').insert(profitLoss())

    await expect(db('xero_profit_loss').insert(profitLoss({ fetched_at: LATER }))).rejects.toThrow(
      /UNIQUE constraint failed: xero_profit_loss\.period_from, xero_profit_loss\.period_to$/,
    )
  })

  it('refuses a row with no fetch time', async () => {
    await expect(db('xero_profit_loss').insert(omit(profitLoss(), 'fetched_at'))).rejects.toThrow(
      notNull('xero_profit_loss', 'fetched_at'),
    )
  })

  it('refuses a period that ends before it starts, and any basis but accrual', async () => {
    await expect(
      db('xero_profit_loss').insert(profitLoss({ period_from: '2026-10-26', period_to: '2026-10-25' })),
    ).rejects.toThrow(refusedBy('xero_profit_loss_period_in_order'))

    for (const basis of ['cash', 'Accrual', '']) {
      await expect(db('xero_profit_loss').insert(profitLoss({ basis })), basis).rejects.toThrow(
        refusedBy('xero_profit_loss_basis_is_accrual'),
      )
    }
    expect(await count('xero_profit_loss')).toBe(0)
  })
})

describe('xero_connection (Done-when 6; Rulings 2, 3)', () => {
  const ENC = ['access_token_enc', 'refresh_token_enc', 'tenant_id_enc']
  const CONNECTED_REQUIRES = [...ENC, 'expires_at', 'scopes', 'connected_at']

  it('round-trips a connected vault with id 1 and version 0 by default', async () => {
    await db('xero_connection').insert(vault())

    const stored = await db('xero_connection').first()
    expect(Object.keys(stored).sort()).toEqual(Object.keys(SCHEMA.xero_connection).sort())
    expect(stored).toStrictEqual({ ...vault(), version: 0 })
  })

  it('holds at most one row', async () => {
    await db('xero_connection').insert(vault())

    for (const id of [2, 0]) {
      await expect(db('xero_connection').insert(vault({ id })), String(id)).rejects.toThrow(
        refusedBy('xero_connection_single_row'),
      )
    }
    // Left out, the rowid alias becomes 2, which is refused the same way.
    await expect(db('xero_connection').insert(omit(vault(), 'id'))).rejects.toThrow(
      refusedBy('xero_connection_single_row'),
    )
    await expect(db('xero_connection').insert(vault())).rejects.toThrow(
      /UNIQUE constraint failed: xero_connection\.id$/,
    )
    expect(await count('xero_connection')).toBe(1)
  })

  it('stores a first row inserted without an id as id 1', async () => {
    await db('xero_connection').insert(omit(vault(), 'id'))
    expect(await db('xero_connection').pluck('id')).toEqual([1])
  })

  it("is written by upsert on id: the second write replaces the first", async () => {
    await db('xero_connection').insert(vault()).onConflict('id').merge()
    const refreshed = vault({
      access_token_enc: CIPHER_2,
      refresh_token_enc: CIPHER_2,
      expires_at: '2026-10-25T05:00:00.000Z',
      version: 1,
      last_refresh_at: LATER,
    })
    await db('xero_connection').insert(refreshed).onConflict('id').merge()

    const rows = await db('xero_connection')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toStrictEqual(refreshed)
  })

  it('refuses an unknown status, and a row that does not say', async () => {
    for (const status of ['bogus', '', 'Connected', 'expired']) {
      await expect(db('xero_connection').insert(vault({ status })), status).rejects.toThrow(
        refusedBy('xero_connection_status_known'),
      )
    }
    await expect(db('xero_connection').insert(omit(vault(), 'status'))).rejects.toThrow(
      notNull('xero_connection', 'status'),
    )
  })

  it('defaults version to 0 and holds only a non-negative integer', async () => {
    await expect(db('xero_connection').insert(vault({ version: null }))).rejects.toThrow(
      notNull('xero_connection', 'version'),
    )
    for (const version of [-1, 1.5, '1.5', 'one']) {
      await expect(db('xero_connection').insert(vault({ version })), String(version)).rejects.toThrow(
        refusedBy('xero_connection_version_non_negative'),
      )
    }

    await db('xero_connection').insert(omit(vault(), 'version'))
    expect(await storedType('xero_connection', 'version')).toStrictEqual({ v: 0, t: 'integer' })

    // Affinity turns '1' into the integer 1 before the CHECK; an integer lands.
    await db('xero_connection').update({ version: '1' })
    expect(await storedType('xero_connection', 'version')).toStrictEqual({ v: 1, t: 'integer' })
  })

  it.each(CONNECTED_REQUIRES)('refuses a connected vault without %s', async (column) => {
    await expect(db('xero_connection').insert(vault({ [column]: null })), 'null').rejects.toThrow(
      refusedBy('xero_connection_connected_has_tokens'),
    )
    await expect(db('xero_connection').insert(omit(vault(), column)), 'left out').rejects.toThrow(
      refusedBy('xero_connection_connected_has_tokens'),
    )
    expect(await count('xero_connection')).toBe(0)
  })

  it.each(ENC)('refuses a disconnected vault that keeps %s', async (column) => {
    const disconnected = { id: 1, status: 'disconnected', [column]: CIPHER }
    await expect(db('xero_connection').insert(disconnected)).rejects.toThrow(
      refusedBy('xero_connection_disconnected_has_no_tokens'),
    )
  })

  it('accepts a disconnected vault with no ciphertext', async () => {
    await db('xero_connection').insert({ id: 1, status: 'disconnected' })

    const stored = await db('xero_connection').first()
    expect(Object.keys(stored).sort()).toEqual(Object.keys(SCHEMA.xero_connection).sort())
    for (const column of [...ENC, 'expires_at', 'scopes', 'connected_at', 'last_refresh_at']) {
      expect(stored[column], column).toBeNull()
    }
  })

  it('accepts a needs_reconnect vault with its old ciphertext, or with none', async () => {
    await db('xero_connection').insert(vault({ status: 'needs_reconnect' }))
    expect(await count('xero_connection')).toBe(1)
    await db('xero_connection').del()

    await db('xero_connection').insert({ id: 1, status: 'needs_reconnect' })
    expect(await db('xero_connection').pluck('status')).toEqual(['needs_reconnect'])
  })

  it.each(ENC)('%s holds only a ciphertext blob of at least 29 bytes, or NULL', async (column) => {
    const check = `xero_connection_${column}_is_ciphertext`
    const row = vault({ status: 'needs_reconnect' })

    for (const value of [
      'plaintext-token-value-that-is-long-enough',
      CIPHER.toString('hex'),
      Buffer.alloc(28, 1),
      Buffer.alloc(0),
      12345,
    ]) {
      await expect(db('xero_connection').insert({ ...row, [column]: value }), String(value)).rejects.toThrow(
        refusedBy(check),
      )
    }

    await db('xero_connection').insert({ ...row, [column]: Buffer.alloc(29, 7) })
    expect(await storedType('xero_connection', column)).toStrictEqual({
      v: Buffer.alloc(29, 7),
      t: 'blob',
    })
    await db('xero_connection').del()

    await db('xero_connection').insert({ ...row, [column]: null })
    expect(await storedType('xero_connection', column)).toStrictEqual({ v: null, t: 'null' })
  })

  it('reads ciphertext back byte for byte', async () => {
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256))
    await db('xero_connection').insert(vault({ refresh_token_enc: bytes }))

    const { refresh_token_enc: stored } = await db('xero_connection').first('refresh_token_enc')
    expect(Buffer.isBuffer(stored)).toBe(true)
    expect(Buffer.compare(stored, bytes)).toBe(0)
  })
})

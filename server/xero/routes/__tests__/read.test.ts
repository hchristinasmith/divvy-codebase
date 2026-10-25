import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../test-utils/app.ts'
import connection from '../../../db/connection.ts'

// /api/v1/xero (issue #67; prd-05 Rulings 2, 4, 6, 7, Done-when 1, 3, 8):
// the totals and connection health the Overview, the tax hold and the Sync
// screen read. Every row is seeded straight into the `xero_*` tables with
// invented values; nothing calls Xero. `server.ts` loads `dotenv/config`, so
// every XERO_ variable is stubbed with an invented value and `fetch` rejects.
//
// The clock is frozen at NOW (Date only), after the server is listening, so
// staleness and the seven-day window are exact.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

const NOW = Date.parse('2026-10-25T03:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const FRESH = iso(-MINUTE)

const TOTALS_KEYS = [
  'connection',
  'lastSyncedAt',
  'payRuns',
  'payables',
  'profit',
  'receivables',
]
const STATUS_KEYS = ['lastRun', 'lastSyncedAt', 'pulledThisWeek', 'state']
const PULLED_KEYS = ['payRuns', 'payables', 'profit', 'receivables', 'since']
const OUTSTANDING_KEYS = ['nzd', 'otherCurrencies']
const PAYABLES_KEYS = ['bills', 'nzd', 'otherCurrencies']
const AMOUNT_KEYS = ['amountDueCents', 'count']
const CURRENCY_KEYS = ['amountDueCents', 'count', 'currency']
const BILL_KEYS = [
  'amountDueCents',
  'contactName',
  'currency',
  'dueDate',
  'invoiceId',
  'invoiceNumber',
]
const PROFIT_KEYS = ['fetchedAt', 'netProfitCents', 'periodFrom', 'periodTo']
const PAY_RUN_KEYS = [
  'payRunId',
  'paymentDate',
  'periodEnd',
  'periodStart',
  'status',
  'totalCostCents',
  'totalPayCents',
]
const WEEK_PAY_RUN_KEYS = ['count', 'totalCostCents', 'totalPayCents']
const WEEK_PROFIT_KEYS = ['count', 'netProfitCents']

const keys = (value: object) => Object.keys(value).sort()

const ZERO = { nzd: { amountDueCents: 0, count: 0 }, otherCurrencies: [] }

const XERO_ENV = [
  'XERO_CLIENT_ID',
  'XERO_CLIENT_SECRET',
  'XERO_TOKEN_KEY',
  'XERO_REDIRECT_URI',
]
const envValue = (name: string) => `invented-${name.toLowerCase()}`

beforeEach(async () => {
  for (const name of XERO_ENV) vi.stubEnv(name, envValue(name))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must not be called'))),
  )
  served = await serveOnLoopback(await freshApp())
  api = served.api
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(async () => {
  vi.useRealTimers()
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(closeDb)

// ---- seed helpers ---------------------------------------------------------

/** A ciphertext-shaped blob (≥ 29 bytes) carrying `text`, so a leak is findable. */
function enc(text: string): Buffer {
  return Buffer.concat([Buffer.alloc(28, 7), Buffer.from(text, 'utf8')])
}

type ConnectionStatus = 'connected' | 'needs_reconnect' | 'disconnected'

function seedConnection(
  status: ConnectionStatus,
  over: Record<string, unknown> = {},
) {
  const tokens =
    status === 'disconnected'
      ? {
          access_token_enc: null,
          refresh_token_enc: null,
          tenant_id_enc: null,
        }
      : {
          access_token_enc: enc('invented-access'),
          refresh_token_enc: enc('invented-refresh'),
          tenant_id_enc: enc('invented-tenant'),
        }
  return connection('xero_connection').insert({
    id: 1,
    ...tokens,
    expires_at: iso(30 * MINUTE),
    version: 0,
    status,
    scopes: 'accounting.transactions.read',
    connected_at: iso(-30 * DAY),
    last_refresh_at: null,
    ...over,
  })
}

let seq = 0
function nextId(prefix: string) {
  seq += 1
  return `${prefix}-${String(seq).padStart(4, '0')}`
}

interface DocOver {
  invoice_id?: string
  invoice_number?: string | null
  contact_name?: string
  due_date?: string | null
  currency?: string
  total_cents?: number
  amount_due_cents?: number
  synced_at?: string
}

function documentRow(type: 'ACCREC' | 'ACCPAY', over: DocOver) {
  const total = over.total_cents ?? over.amount_due_cents ?? 10_000
  const due = over.amount_due_cents ?? total
  return {
    invoice_id: over.invoice_id ?? nextId(type === 'ACCREC' ? 'inv' : 'bill'),
    invoice_number: over.invoice_number === undefined ? 'INV-1' : over.invoice_number,
    contact_name: over.contact_name ?? 'Invented Contact Ltd',
    type,
    status: 'AUTHORISED',
    date: '2026-10-01',
    due_date: over.due_date === undefined ? '2026-11-20' : over.due_date,
    currency: over.currency ?? 'NZD',
    total_cents: total,
    amount_due_cents: due,
    amount_paid_cents: total - due,
    synced_at: over.synced_at ?? FRESH,
  }
}

function invoice(over: DocOver = {}) {
  return connection('xero_invoices').insert(documentRow('ACCREC', over))
}

function bill(over: DocOver = {}) {
  return connection('xero_bills').insert(documentRow('ACCPAY', over))
}

interface PayRunOver {
  pay_run_id?: string
  payment_date?: string
  status?: string
  total_cost_cents?: number
  total_pay_cents?: number
  synced_at?: string
}

function payRun(over: PayRunOver = {}) {
  return connection('xero_pay_runs').insert({
    pay_run_id: over.pay_run_id ?? nextId('pr'),
    period_start: '2026-10-06',
    period_end: '2026-10-12',
    payment_date: over.payment_date ?? '2026-10-14',
    status: over.status ?? 'POSTED',
    total_cost_cents: over.total_cost_cents ?? 250_000,
    total_pay_cents: over.total_pay_cents ?? 200_000,
    synced_at: over.synced_at ?? FRESH,
  })
}

interface ProfitOver {
  period_from?: string
  period_to?: string
  net_profit_cents?: number
  fetched_at?: string
}

let plSeq = 0
function pl(over: ProfitOver = {}) {
  plSeq += 1
  return connection('xero_profit_loss').insert({
    // Distinct periods by default: (period_from, period_to) is unique.
    period_from: over.period_from ?? '2026-04-01',
    period_to: over.period_to ?? `2026-10-${String(plSeq % 28 + 1).padStart(2, '0')}`,
    basis: 'accrual',
    net_profit_cents: over.net_profit_cents ?? 1_234_500,
    fetched_at: over.fetched_at ?? FRESH,
  })
}

const getTotals = () => api.get('/api/v1/xero/totals')
const getStatus = () => api.get('/api/v1/xero/status')

// ---- totals ---------------------------------------------------------------

describe('GET /api/v1/xero/totals', () => {
  it('receivables sum amount due, not total, NZD alone and every other currency apart (Done-when 1, Ruling 7)', async () => {
    await seedConnection('connected')
    await invoice({ total_cents: 150_000, amount_due_cents: 100_000 })
    await invoice({ total_cents: 30_050, amount_due_cents: 30_050 })
    await invoice({ currency: 'USD', total_cents: 40_000, amount_due_cents: 20_000 })
    await invoice({ currency: 'USD', total_cents: 9_000, amount_due_cents: 5_025 })
    await invoice({ currency: 'AUD', total_cents: 8_800, amount_due_cents: 7_700 })

    const res = await getTotals()

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(keys(res.body.receivables)).toEqual(OUTSTANDING_KEYS)
    expect(keys(res.body.receivables.nzd)).toEqual(AMOUNT_KEYS)
    for (const item of res.body.receivables.otherCurrencies) {
      expect(keys(item)).toEqual(CURRENCY_KEYS)
    }
    expect(res.body.receivables).toStrictEqual({
      nzd: { amountDueCents: 130_050, count: 2 },
      otherCurrencies: [
        { currency: 'AUD', amountDueCents: 7_700, count: 1 },
        { currency: 'USD', amountDueCents: 25_025, count: 2 },
      ],
    })
  })

  it('payables sum amount due the same way, and list every bill by due date ascending, undated last', async () => {
    await seedConnection('connected')
    await bill({
      invoice_id: 'bill-b',
      invoice_number: 'SUP-77',
      contact_name: 'Invented Flour Co',
      due_date: '2026-11-01',
      total_cents: 45_000,
      amount_due_cents: 40_000,
    })
    await bill({
      invoice_id: 'bill-undated',
      invoice_number: null,
      contact_name: 'Invented Packaging',
      due_date: null,
      total_cents: 12_345,
    })
    await bill({
      invoice_id: 'bill-a',
      invoice_number: 'SUP-12',
      contact_name: 'Invented Dairy',
      due_date: '2026-11-01',
      total_cents: 1_100,
    })
    await bill({
      invoice_id: 'bill-soon',
      invoice_number: 'SUP-3',
      contact_name: 'Invented Rent',
      due_date: '2026-10-28',
      total_cents: 9_900,
    })
    await bill({
      invoice_id: 'bill-usd',
      invoice_number: 'US-1',
      contact_name: 'Invented Software Inc',
      due_date: '2026-10-30',
      currency: 'USD',
      total_cents: 4_000,
      amount_due_cents: 3_000,
    })

    const res = await getTotals()

    expect(res.status).toBe(200)
    expect(keys(res.body.payables)).toEqual(PAYABLES_KEYS)
    for (const item of res.body.payables.bills) {
      expect(keys(item)).toEqual(BILL_KEYS)
    }
    expect(res.body.payables).toStrictEqual({
      nzd: { amountDueCents: 40_000 + 12_345 + 1_100 + 9_900, count: 4 },
      otherCurrencies: [{ currency: 'USD', amountDueCents: 3_000, count: 1 }],
      bills: [
        {
          invoiceId: 'bill-soon',
          invoiceNumber: 'SUP-3',
          contactName: 'Invented Rent',
          dueDate: '2026-10-28',
          amountDueCents: 9_900,
          currency: 'NZD',
        },
        {
          invoiceId: 'bill-usd',
          invoiceNumber: 'US-1',
          contactName: 'Invented Software Inc',
          dueDate: '2026-10-30',
          amountDueCents: 3_000,
          currency: 'USD',
        },
        {
          invoiceId: 'bill-a',
          invoiceNumber: 'SUP-12',
          contactName: 'Invented Dairy',
          dueDate: '2026-11-01',
          amountDueCents: 1_100,
          currency: 'NZD',
        },
        {
          invoiceId: 'bill-b',
          invoiceNumber: 'SUP-77',
          contactName: 'Invented Flour Co',
          dueDate: '2026-11-01',
          amountDueCents: 40_000,
          currency: 'NZD',
        },
        {
          invoiceId: 'bill-undated',
          invoiceNumber: null,
          contactName: 'Invented Packaging',
          dueDate: null,
          amountDueCents: 12_345,
          currency: 'NZD',
        },
      ],
    })
  })

  it('profit is the most recently fetched row, even when its period is older', async () => {
    await seedConnection('connected')
    await pl({
      period_from: '2026-04-01',
      period_to: '2026-10-24',
      net_profit_cents: 777_700,
      fetched_at: iso(-10 * MINUTE),
    })
    await pl({
      period_from: '2025-04-01',
      period_to: '2026-03-31',
      net_profit_cents: -42_000,
      fetched_at: iso(-2 * MINUTE),
    })

    const res = await getTotals()

    expect(keys(res.body.profit)).toEqual(PROFIT_KEYS)
    expect(res.body.profit).toStrictEqual({
      netProfitCents: -42_000,
      periodFrom: '2025-04-01',
      periodTo: '2026-03-31',
      fetchedAt: iso(-2 * MINUTE),
    })
  })

  it('profit rows fetched at the same instant: the later-stored row (higher id) wins', async () => {
    await seedConnection('connected')
    await pl({
      period_from: '2026-04-01',
      period_to: '2026-10-23',
      net_profit_cents: 111_100,
      fetched_at: FRESH,
    })
    await pl({
      period_from: '2026-04-01',
      period_to: '2026-10-24',
      net_profit_cents: 222_200,
      fetched_at: FRESH,
    })

    const totals = await getTotals()
    const status = await getStatus()

    expect(totals.body.profit).toStrictEqual({
      netProfitCents: 222_200,
      periodFrom: '2026-04-01',
      periodTo: '2026-10-24',
      fetchedAt: FRESH,
    })
    // The week's figure comes from the same pick.
    expect(status.body.pulledThisWeek.profit).toStrictEqual({
      count: 2,
      netProfitCents: 222_200,
    })
  })

  it('profit is null when no profit row is stored but other Xero data is', async () => {
    await seedConnection('connected')
    await invoice({ amount_due_cents: 5_000 })

    const res = await getTotals()

    expect(res.body.connection).toBe('connected')
    expect(res.body.profit).toBeNull()
    expect(res.body.payRuns).toStrictEqual([])
    expect(res.body.payables).toStrictEqual({ ...ZERO, bills: [] })
  })

  it('pay runs are listed by payment date descending', async () => {
    await seedConnection('connected')
    await payRun({
      pay_run_id: 'pr-oct-07',
      payment_date: '2026-10-07',
      total_cost_cents: 310_000,
      total_pay_cents: 260_000,
    })
    await payRun({
      pay_run_id: 'pr-oct-21',
      payment_date: '2026-10-21',
      status: 'DRAFT',
      total_cost_cents: -1_500,
      total_pay_cents: 0,
    })
    await payRun({
      pay_run_id: 'pr-oct-14',
      payment_date: '2026-10-14',
      total_cost_cents: 305_050,
      total_pay_cents: 255_050,
    })

    const res = await getTotals()

    for (const item of res.body.payRuns) expect(keys(item)).toEqual(PAY_RUN_KEYS)
    expect(res.body.payRuns).toStrictEqual([
      {
        payRunId: 'pr-oct-21',
        periodStart: '2026-10-06',
        periodEnd: '2026-10-12',
        paymentDate: '2026-10-21',
        status: 'DRAFT',
        totalCostCents: -1_500,
        totalPayCents: 0,
      },
      {
        payRunId: 'pr-oct-14',
        periodStart: '2026-10-06',
        periodEnd: '2026-10-12',
        paymentDate: '2026-10-14',
        status: 'POSTED',
        totalCostCents: 305_050,
        totalPayCents: 255_050,
      },
      {
        payRunId: 'pr-oct-07',
        periodStart: '2026-10-06',
        periodEnd: '2026-10-12',
        paymentDate: '2026-10-07',
        status: 'POSTED',
        totalCostCents: 310_000,
        totalPayCents: 260_000,
      },
    ])
  })

  it('pay runs on the same payment date are ordered by pay run id descending', async () => {
    await seedConnection('connected')
    // Stored in neither id order nor its reverse, so neither the table's
    // insertion order nor the primary-key index can supply the expected order.
    for (const id of ['pr-same-b', 'pr-same-c', 'pr-same-a']) {
      await payRun({ pay_run_id: id, payment_date: '2026-10-14' })
    }
    await payRun({ pay_run_id: 'pr-same-0', payment_date: '2026-10-21' })

    const res = await getTotals()

    expect(res.body.payRuns.map((run: { payRunId: string }) => run.payRunId)).toStrictEqual([
      'pr-same-0',
      'pr-same-c',
      'pr-same-b',
      'pr-same-a',
    ])
  })

  it('connected and synced with nothing outstanding is a real zero', async () => {
    await seedConnection('connected')
    await pl({
      period_from: '2026-04-01',
      period_to: '2026-10-24',
      net_profit_cents: 0,
    })

    const res = await getTotals()

    expect(res.status).toBe(200)
    expect(keys(res.body)).toEqual(TOTALS_KEYS)
    expect(res.body).toStrictEqual({
      connection: 'connected',
      lastSyncedAt: FRESH,
      receivables: ZERO,
      payables: { ...ZERO, bills: [] },
      profit: {
        netProfitCents: 0,
        periodFrom: '2026-04-01',
        periodTo: '2026-10-24',
        fetchedAt: FRESH,
      },
      payRuns: [],
    })
  })
})

// ---- not connected --------------------------------------------------------

describe('not connected is flagged, never zero', () => {
  async function seedEveryTable() {
    await invoice({ amount_due_cents: 1_000 })
    await bill({ amount_due_cents: 2_000 })
    await payRun()
    await pl()
  }

  it.each([
    ['no connection row', async () => {}],
    ['a disconnected row', () => seedConnection('disconnected')],
  ] as const)(
    'with %s, both routes answer not_connected with null figures, though Xero rows exist',
    async (_name, seed) => {
      await seed()
      await seedEveryTable()

      const totals = await getTotals()
      expect(totals.status).toBe(200)
      expect(keys(totals.body)).toEqual(TOTALS_KEYS)
      expect(totals.body).toStrictEqual({
        connection: 'not_connected',
        lastSyncedAt: null,
        receivables: null,
        payables: null,
        profit: null,
        payRuns: null,
      })

      const status = await getStatus()
      expect(status.status).toBe(200)
      expect(keys(status.body)).toEqual(STATUS_KEYS)
      expect(status.body).toStrictEqual({
        state: 'not_connected',
        lastSyncedAt: null,
        lastRun: null,
        pulledThisWeek: null,
      })
    },
  )

  it('connected with nothing ever stored is stale, with null figures', async () => {
    await seedConnection('connected')

    const totals = await getTotals()
    expect(totals.body).toStrictEqual({
      connection: 'stale',
      lastSyncedAt: null,
      receivables: null,
      payables: null,
      profit: null,
      payRuns: null,
    })

    // Nothing was pulled this week, which is true, so the week is zeros.
    const status = await getStatus()
    expect(keys(status.body)).toEqual(STATUS_KEYS)
    expect(status.body).toStrictEqual({
      state: 'stale',
      lastSyncedAt: null,
      lastRun: null,
      pulledThisWeek: {
        since: iso(-7 * DAY),
        receivables: ZERO,
        payables: ZERO,
        payRuns: { count: 0, totalCostCents: 0, totalPayCents: 0 },
        profit: { count: 0, netProfitCents: null },
      },
    })
  })
})

// ---- connection state -----------------------------------------------------

describe('connection state (Done-when 8)', () => {
  it.each([
    ['exactly two intervals old', iso(-30 * MINUTE), 'connected'],
    ['two intervals and 1 ms old', iso(-30 * MINUTE - 1), 'stale'],
    ['1 ms inside two intervals', iso(-30 * MINUTE + 1), 'connected'],
    ['in the future', iso(5 * MINUTE), 'connected'],
    ['a day old', iso(-DAY), 'stale'],
  ] as const)(
    'connected, newest row %s (%s), is %s',
    async (_name, at, state) => {
      await seedConnection('connected')
      await invoice({ synced_at: at, amount_due_cents: 8_000 })

      const totals = await getTotals()
      const status = await getStatus()

      expect(totals.body.connection).toBe(state)
      expect(totals.body.lastSyncedAt).toBe(at)
      // A stale connection keeps its last-known figures beside the flag.
      expect(totals.body.receivables).toStrictEqual({
        nzd: { amountDueCents: 8_000, count: 1 },
        otherCurrencies: [],
      })
      expect(status.body.state).toBe(state)
      expect(status.body.lastSyncedAt).toBe(at)
    },
  )

  it.each([
    ['fresh', FRESH],
    ['a day old', iso(-DAY)],
  ])(
    'needs_reconnect with %s data says so, with last-known figures',
    async (_name, at) => {
      await seedConnection('needs_reconnect')
      await invoice({ synced_at: at, amount_due_cents: 6_500 })

      const totals = await getTotals()
      const status = await getStatus()

      expect(totals.body.connection).toBe('needs_reconnect')
      expect(totals.body.lastSyncedAt).toBe(at)
      expect(totals.body.receivables).toStrictEqual({
        nzd: { amountDueCents: 6_500, count: 1 },
        otherCurrencies: [],
      })
      expect(status.body.state).toBe('needs_reconnect')
      expect(status.body.lastSyncedAt).toBe(at)
      // Needing a reconnect still reports what this week's syncs stored.
      expect(keys(status.body.pulledThisWeek)).toEqual(PULLED_KEYS)
      expect(status.body.pulledThisWeek).toStrictEqual({
        since: iso(-7 * DAY),
        receivables: {
          nzd: { amountDueCents: 6_500, count: 1 },
          otherCurrencies: [],
        },
        payables: ZERO,
        payRuns: { count: 0, totalCostCents: 0, totalPayCents: 0 },
        profit: { count: 0, netProfitCents: null },
      })
    },
  )

  it('needs_reconnect with nothing ever stored says so, with null figures and a zero week', async () => {
    await seedConnection('needs_reconnect')

    const totals = await getTotals()
    expect(totals.status).toBe(200)
    expect(keys(totals.body)).toEqual(TOTALS_KEYS)
    expect(totals.body).toStrictEqual({
      connection: 'needs_reconnect',
      lastSyncedAt: null,
      receivables: null,
      payables: null,
      profit: null,
      payRuns: null,
    })

    const status = await getStatus()
    expect(status.status).toBe(200)
    expect(keys(status.body)).toEqual(STATUS_KEYS)
    expect(keys(status.body.pulledThisWeek)).toEqual(PULLED_KEYS)
    expect(status.body).toStrictEqual({
      state: 'needs_reconnect',
      lastSyncedAt: null,
      lastRun: null,
      pulledThisWeek: {
        since: iso(-7 * DAY),
        receivables: ZERO,
        payables: ZERO,
        payRuns: { count: 0, totalCostCents: 0, totalPayCents: 0 },
        profit: { count: 0, netProfitCents: null },
      },
    })
  })

  const OLD = iso(-2 * 60 * MINUTE)
  const seeders = {
    xero_invoices: (at: string) => invoice({ synced_at: at }),
    xero_bills: (at: string) => bill({ synced_at: at }),
    xero_pay_runs: (at: string) => payRun({ synced_at: at }),
    xero_profit_loss: (at: string) => pl({ fetched_at: at }),
  }
  const tables = Object.keys(seeders) as Array<keyof typeof seeders>

  it.each(tables)(
    'the newest row in %s alone decides lastSyncedAt and keeps the connection fresh',
    async (table) => {
      await seedConnection('connected')
      for (const other of tables) await seeders[other](OLD)
      const newest = iso(-29 * MINUTE)
      await seeders[table](newest)

      const totals = await getTotals()
      const status = await getStatus()

      expect(totals.body.connection).toBe('connected')
      expect(totals.body.lastSyncedAt).toBe(newest)
      expect(status.body.state).toBe('connected')
      expect(status.body.lastSyncedAt).toBe(newest)
    },
  )
})

// ---- pulled this week -----------------------------------------------------

describe('GET /api/v1/xero/status pulled this week', () => {
  it('counts rows stored at or after seven days ago, in every table, NZD apart', async () => {
    const edge = iso(-7 * DAY)
    const before = iso(-7 * DAY - 1)
    await seedConnection('connected')

    await invoice({ synced_at: edge, amount_due_cents: 11_000, total_cents: 20_000 })
    await invoice({ synced_at: FRESH, amount_due_cents: 2_500 })
    await invoice({ synced_at: FRESH, currency: 'USD', amount_due_cents: 900 })
    await invoice({ synced_at: before, amount_due_cents: 99_999 })

    await bill({ synced_at: edge, amount_due_cents: 3_300 })
    await bill({ synced_at: FRESH, currency: 'EUR', amount_due_cents: 1_200 })
    await bill({ synced_at: before, amount_due_cents: 88_888 })

    await payRun({ synced_at: edge, total_cost_cents: 100_000, total_pay_cents: 80_000 })
    await payRun({ synced_at: FRESH, total_cost_cents: 50_050, total_pay_cents: 40_040 })
    await payRun({ synced_at: before, total_cost_cents: 7_777_777, total_pay_cents: 6_666_666 })

    await pl({ period_to: '2026-10-20', fetched_at: edge, net_profit_cents: 500_000 })
    await pl({ period_to: '2026-10-24', fetched_at: FRESH, net_profit_cents: 612_300 })
    await pl({ period_to: '2026-10-10', fetched_at: before, net_profit_cents: 9_999_999 })

    const res = await getStatus()

    expect(res.status).toBe(200)
    expect(keys(res.body)).toEqual(STATUS_KEYS)
    expect(keys(res.body.pulledThisWeek)).toEqual(PULLED_KEYS)
    expect(keys(res.body.pulledThisWeek.receivables)).toEqual(OUTSTANDING_KEYS)
    expect(keys(res.body.pulledThisWeek.payables)).toEqual(OUTSTANDING_KEYS)
    expect(keys(res.body.pulledThisWeek.payRuns)).toEqual(WEEK_PAY_RUN_KEYS)
    expect(keys(res.body.pulledThisWeek.profit)).toEqual(WEEK_PROFIT_KEYS)
    expect(res.body).toStrictEqual({
      state: 'connected',
      lastSyncedAt: FRESH,
      lastRun: null,
      pulledThisWeek: {
        since: edge,
        receivables: {
          nzd: { amountDueCents: 13_500, count: 2 },
          otherCurrencies: [{ currency: 'USD', amountDueCents: 900, count: 1 }],
        },
        payables: {
          nzd: { amountDueCents: 3_300, count: 1 },
          otherCurrencies: [{ currency: 'EUR', amountDueCents: 1_200, count: 1 }],
        },
        payRuns: { count: 2, totalCostCents: 150_050, totalPayCents: 120_040 },
        profit: { count: 2, netProfitCents: 612_300 },
      },
    })
  })

  it('a week with nothing stored is zeros, and no profit figure', async () => {
    const old = iso(-8 * DAY)
    await seedConnection('connected')
    await invoice({ synced_at: old })
    await payRun({ synced_at: old })
    await pl({ fetched_at: old })

    const res = await getStatus()

    expect(res.body.state).toBe('stale')
    expect(res.body.pulledThisWeek).toStrictEqual({
      since: iso(-7 * DAY),
      receivables: ZERO,
      payables: ZERO,
      payRuns: { count: 0, totalCostCents: 0, totalPayCents: 0 },
      profit: { count: 0, netProfitCents: null },
    })
  })
})

// ---- no leak --------------------------------------------------------------

describe('no response carries a token, tenant, scope or ciphertext (Ruling 2, Done-when 3)', () => {
  const ACCESS = 'sentinel-xero-access-9f2c41'
  const REFRESH = 'sentinel-xero-refresh-3d7a08'
  const TENANT = 'sentinel-xero-tenant-b61e55'
  const SCOPES = 'sentinel.scope.e0c4f2 offline_access'
  const EXPIRES = '2031-01-02T03:04:05.678Z'
  const FORBIDDEN_KEY =
    /token|tenant|(^|_)enc|enc$|scope|secret|cash|balance|expire|refresh/i

  function walkKeys(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const item of value) walkKeys(item, found)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        found.push(key)
        walkKeys(inner, found)
      }
    }
    return found
  }

  it.each([
    ['connected', 'connected', FRESH],
    ['needs_reconnect', 'needs_reconnect', FRESH],
    ['stale', 'connected', iso(-DAY)],
  ] as const)('%s', async (_name, status, at) => {
    await seedConnection(status, {
      access_token_enc: enc(ACCESS),
      refresh_token_enc: enc(REFRESH),
      tenant_id_enc: enc(TENANT),
      scopes: SCOPES,
      expires_at: EXPIRES,
    })
    await invoice({ synced_at: at })
    await bill({ synced_at: at })
    await payRun({ synced_at: at })
    await pl({ fetched_at: at })

    const forbidden = [
      ACCESS,
      REFRESH,
      TENANT,
      SCOPES,
      'sentinel.scope',
      EXPIRES,
      'Buffer',
      ...XERO_ENV.map(envValue),
    ]
    for (const secret of [ACCESS, REFRESH, TENANT]) {
      const blob = enc(secret)
      forbidden.push(blob.toString('base64'), blob.toString('hex'))
      forbidden.push(Buffer.from(secret).toString('base64'))
    }

    for (const res of [await getTotals(), await getStatus()]) {
      expect(res.status).toBe(200)
      // The figures are really there, so an empty body cannot pass.
      expect(walkKeys(res.body).length).toBeGreaterThan(10)
      for (const text of forbidden) expect(res.text).not.toContain(text)
      expect(walkKeys(res.body).filter((key) => FORBIDDEN_KEY.test(key))).toEqual([])
    }
  })
})

describe('from xero_connection only status is ever selected (Ruling 2)', () => {
  it.each([
    ['totals', getTotals],
    ['status', getStatus],
  ] as const)('%s', async (_name, get) => {
    await seedConnection('connected')
    await invoice()
    const sql: string[] = []
    const listener = (query: { sql: string }) => sql.push(query.sql)
    connection.on('query', listener)
    try {
      const res = await get()
      expect(res.status).toBe(200)
    } finally {
      connection.off('query', listener)
    }

    // Every statement naming the table, and nothing but `status` in it.
    expect(sql.filter((text) => text.includes('xero_connection'))).toStrictEqual([
      'select `status` from `xero_connection` where `id` = ? limit ?',
    ])
  })
})

// ---- read only ------------------------------------------------------------

describe('only GET exists', () => {
  async function counts() {
    const out: Record<string, unknown> = {}
    for (const table of [
      'xero_connection',
      'xero_invoices',
      'xero_bills',
      'xero_pay_runs',
      'xero_profit_loss',
    ]) {
      out[table] = (await connection(table).count({ n: '*' }))[0].n
    }
    return out
  }

  it.each([
    ['post', '/api/v1/xero/totals'],
    ['put', '/api/v1/xero/totals'],
    ['patch', '/api/v1/xero/totals'],
    ['delete', '/api/v1/xero/totals'],
    ['post', '/api/v1/xero/status'],
    ['put', '/api/v1/xero/status'],
    ['patch', '/api/v1/xero/status'],
    ['delete', '/api/v1/xero/status'],
    ['get', '/api/v1/xero/nope'],
    ['get', '/api/v1/xero'],
  ] as const)('%s %s is a JSON 404 and changes nothing', async (method, path) => {
    await seedConnection('connected')
    await invoice()
    await bill()
    await payRun()
    await pl()
    const before = await counts()

    const res = await api[method](path).send({})

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
    expect(await counts()).toStrictEqual(before)
    expect(before).toStrictEqual({
      xero_connection: 1,
      xero_invoices: 1,
      xero_bills: 1,
      xero_pay_runs: 1,
      xero_profit_loss: 1,
    })
  })
})

// ---- failure --------------------------------------------------------------

describe('an unreadable table', () => {
  it.each([
    ['totals', getTotals, 'Could not read Xero totals'],
    ['status', getStatus, 'Could not read Xero status'],
  ] as const)(
    '%s answers a fixed 500, logging the error class only',
    async (what, get, message) => {
      await seedConnection('connected')
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await connection.schema.renameTable('xero_invoices', 'xero_invoices_away')
      try {
        const res = await get()

        expect(res.status).toBe(500)
        expect(res.body).toStrictEqual({ error: message })
        expect(res.text).not.toContain('xero_invoices')
        expect(error.mock.calls).toStrictEqual([
          [`xero ${what}: could not read the xero tables`, 'Error'],
        ])
      } finally {
        await connection.schema.renameTable('xero_invoices_away', 'xero_invoices')
        error.mockRestore()
      }
    },
  )
})

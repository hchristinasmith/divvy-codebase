import express from 'express'

import connection from '../../db/connection.ts'
import type {
  XeroAmountDue,
  XeroConnectionState,
  XeroOutstanding,
  XeroPayableBill,
  XeroPayables,
  XeroPayRun,
  XeroProfitSummary,
  XeroPulledThisWeek,
  XeroStatusResponse,
  XeroTotalsResponse,
} from '../../../models/xero.ts'

// /api/v1/xero (issue #67): what the app shows of Strawb's books, read from
// the `xero_*` tables the sync (#66) fills. Read only: both routes are GET,
// and any other verb falls through to `server.ts`'s JSON 404. Nothing here
// calls Xero.
//
// GET /totals: receivables, payables (with the bills), the latest profit
// figure and the pay runs. Outstanding amounts sum `amount_due_cents`, what
// is still owed, never `total_cents` (prd-05 Done-when 1). Only NZD is summed;
// every other currency is kept apart and never converted (Ruling 7). There is
// no cash or bank balance figure, and nothing that could be added to liquid
// (Ruling 4, Done-when 3).
//
// GET /status: the connection state, when a Xero row was last stored, and
// what this week's syncs stored. `stale` is decided here and only here
// (`readConnection`): connected, but no stored row is newer than two sync
// intervals (Done-when 8).
//
// From `xero_connection` only `status` is ever selected. The token
// ciphertext columns, the tenant, `scopes` and `expires_at` are never read,
// so no response can carry them (Ruling 2).
//
// Not connected is not zero: when there is no connection, or nothing has
// ever been stored, every total is `null`, so an unconnected install never
// reads as "$0 owed". A connection that is stale or needs reconnecting keeps
// its last-known figures beside the flag.

// The Xero sync (#66) owns the real timer; keep this in step with it.
const XERO_SYNC_INTERVAL_MS = 15 * 60_000
// prd-05 Done-when 8: stale once the newest row is older than two intervals.
const STALE_AFTER_MS = 2 * XERO_SYNC_INTERVAL_MS
const PULLED_WINDOW_MS = 7 * 24 * 60 * 60_000
const BASE_CURRENCY = 'NZD'

// Table names come from these literals, never from a request.
type DocumentTable = 'xero_invoices' | 'xero_bills'

interface ConnectionRead {
  state: XeroConnectionState
  lastSyncedAt: string | null
}

type Row = Record<string, unknown>

/** A count or a cents figure from SQLite; anything but a safe integer is a fault. */
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('xero read: expected an integer')
  }
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('xero read: expected text')
  return value
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value)
}

/**
 * The newest instant any Xero row was stored. Every instant is
 * `Date#toISOString()` text (the tables' CHECKs pin the format), so the
 * largest string is the latest time.
 */
async function readLastSyncedAt(): Promise<string | null> {
  const rows: Array<Row | undefined> = await Promise.all([
    connection('xero_invoices').max({ at: 'synced_at' }).first(),
    connection('xero_bills').max({ at: 'synced_at' }).first(),
    connection('xero_pay_runs').max({ at: 'synced_at' }).first(),
    connection('xero_profit_loss').max({ at: 'fetched_at' }).first(),
  ])
  let latest: string | null = null
  for (const row of rows) {
    const at = textOrNull(row?.at)
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest
}

/** The connection state. The only place `stale` is decided. */
async function readConnection(now: number): Promise<ConnectionRead> {
  const row: Row | undefined = await connection('xero_connection')
    .where({ id: 1 })
    .first('status')
  if (row === undefined) return { state: 'not_connected', lastSyncedAt: null }
  const status = text(row.status)
  switch (status) {
    case 'disconnected':
      return { state: 'not_connected', lastSyncedAt: null }
    case 'needs_reconnect':
      return { state: 'needs_reconnect', lastSyncedAt: await readLastSyncedAt() }
    case 'connected': {
      const lastSyncedAt = await readLastSyncedAt()
      // Connected with nothing ever stored has shown no sign of health.
      const stale =
        lastSyncedAt === null ||
        now - Date.parse(lastSyncedAt) > STALE_AFTER_MS
      return { state: stale ? 'stale' : 'connected', lastSyncedAt }
    }
    default:
      throw new Error('xero read: unknown connection status')
  }
}

/**
 * Outstanding amounts by currency: NZD alone, every other currency apart
 * (Ruling 7). With `since`, only rows stored at or after it.
 */
async function readOutstanding(
  table: DocumentTable,
  since: string | null,
): Promise<XeroOutstanding> {
  const query = connection(table)
    .select('currency')
    .sum({ amountDueCents: 'amount_due_cents' })
    .count({ count: '*' })
    .groupBy('currency')
    .orderBy('currency')
  if (since !== null) query.where('synced_at', '>=', since)
  const rows: Row[] = await query

  let nzd: XeroAmountDue = { amountDueCents: 0, count: 0 }
  const otherCurrencies: XeroOutstanding['otherCurrencies'] = []
  for (const row of rows) {
    const currency = text(row.currency)
    const due = {
      amountDueCents: integer(row.amountDueCents),
      count: integer(row.count),
    }
    if (currency === BASE_CURRENCY) nzd = due
    else otherCurrencies.push({ currency, ...due })
  }
  return { nzd, otherCurrencies }
}

/** Every outstanding bill, any currency: due date ascending, undated last. */
async function readBills(): Promise<XeroPayableBill[]> {
  const rows: Row[] = await connection('xero_bills')
    .select(
      'invoice_id',
      'invoice_number',
      'contact_name',
      'due_date',
      'amount_due_cents',
      'currency',
    )
    // A constant string, the only raw SQL here: SQLite sorts NULL first.
    .orderByRaw('due_date IS NULL, due_date ASC, invoice_id ASC')
  return rows.map((row) => ({
    invoiceId: text(row.invoice_id),
    invoiceNumber: textOrNull(row.invoice_number),
    contactName: text(row.contact_name),
    dueDate: textOrNull(row.due_date),
    amountDueCents: integer(row.amount_due_cents),
    currency: text(row.currency),
  }))
}

async function readPayables(): Promise<XeroPayables> {
  const [outstanding, bills] = await Promise.all([
    readOutstanding('xero_bills', null),
    readBills(),
  ])
  return { ...outstanding, bills }
}

/** The most recently fetched profit row; with `since`, fetched at or after it. */
async function readLatestProfit(
  since: string | null,
): Promise<XeroProfitSummary | null> {
  const query = connection('xero_profit_loss')
    .orderBy([
      { column: 'fetched_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .first('net_profit_cents', 'period_from', 'period_to', 'fetched_at')
  if (since !== null) query.where('fetched_at', '>=', since)
  const row: Row | undefined = await query
  if (row === undefined) return null
  return {
    netProfitCents: integer(row.net_profit_cents),
    periodFrom: text(row.period_from),
    periodTo: text(row.period_to),
    fetchedAt: text(row.fetched_at),
  }
}

/** Every stored pay run, payment date descending. */
async function readPayRuns(): Promise<XeroPayRun[]> {
  const rows: Row[] = await connection('xero_pay_runs')
    .select(
      'pay_run_id',
      'period_start',
      'period_end',
      'payment_date',
      'status',
      'total_cost_cents',
      'total_pay_cents',
    )
    .orderBy([
      { column: 'payment_date', order: 'desc' },
      { column: 'pay_run_id', order: 'desc' },
    ])
  return rows.map((row) => ({
    payRunId: text(row.pay_run_id),
    periodStart: text(row.period_start),
    periodEnd: text(row.period_end),
    paymentDate: text(row.payment_date),
    status: text(row.status),
    totalCostCents: integer(row.total_cost_cents),
    totalPayCents: integer(row.total_pay_cents),
  }))
}

// What this week's syncs stored. A sync re-stamps `synced_at` on every row it
// sees, so "this week" means "present in this week's syncs", not "new this
// week"; and a sync deletes documents that were paid, so "paid this week"
// never appears. Both are limits of the stored data, not of this query.
async function readPulledThisWeek(now: number): Promise<XeroPulledThisWeek> {
  const since = new Date(now - PULLED_WINDOW_MS).toISOString()
  const [receivables, payables, payRuns, profitCount, latestProfit] =
    await Promise.all([
      readOutstanding('xero_invoices', since),
      readOutstanding('xero_bills', since),
      connection('xero_pay_runs')
        .where('synced_at', '>=', since)
        .count({ count: '*' })
        .sum({ totalCostCents: 'total_cost_cents' })
        .sum({ totalPayCents: 'total_pay_cents' })
        .first() as Promise<Row | undefined>,
      connection('xero_profit_loss')
        .where('fetched_at', '>=', since)
        .count({ count: '*' })
        .first() as Promise<Row | undefined>,
      readLatestProfit(since),
    ])
  return {
    since,
    receivables,
    payables,
    payRuns: {
      count: integer(payRuns?.count ?? 0),
      // SUM over no rows is NULL.
      totalCostCents: integer(payRuns?.totalCostCents ?? 0),
      totalPayCents: integer(payRuns?.totalPayCents ?? 0),
    },
    profit: {
      count: integer(profitCount?.count ?? 0),
      netProfitCents: latestProfit?.netProfitCents ?? null,
    },
  }
}

function logFailure(what: string, err: unknown): void {
  // The class only: a driver error's message can quote SQL or values.
  // eslint-disable-next-line no-console
  console.error(
    `xero ${what}: could not read the xero tables`,
    err instanceof Error ? err.constructor.name : typeof err,
  )
}

const router = express.Router()

// GET /api/v1/xero/totals
router.get('/totals', async (req, res) => {
  try {
    const now = Date.now()
    const { state, lastSyncedAt } = await readConnection(now)
    if (state === 'not_connected' || lastSyncedAt === null) {
      const body: XeroTotalsResponse = {
        connection: state,
        lastSyncedAt,
        receivables: null,
        payables: null,
        profit: null,
        payRuns: null,
      }
      res.json(body)
      return
    }
    const [receivables, payables, profit, payRuns] = await Promise.all([
      readOutstanding('xero_invoices', null),
      readPayables(),
      readLatestProfit(null),
      readPayRuns(),
    ])
    const body: XeroTotalsResponse = {
      connection: state,
      lastSyncedAt,
      receivables,
      payables,
      profit,
      payRuns,
    }
    res.json(body)
  } catch (err) {
    logFailure('totals', err)
    res.status(500).json({ error: 'Could not read Xero totals' })
  }
})

// GET /api/v1/xero/status
router.get('/status', async (req, res) => {
  try {
    const now = Date.now()
    const { state, lastSyncedAt } = await readConnection(now)
    const body: XeroStatusResponse = {
      state,
      lastSyncedAt,
      lastRun: null,
      pulledThisWeek:
        state === 'not_connected' ? null : await readPulledThisWeek(now),
    }
    res.json(body)
  } catch (err) {
    logFailure('status', err)
    res.status(500).json({ error: 'Could not read Xero status' })
  }
})

export default router

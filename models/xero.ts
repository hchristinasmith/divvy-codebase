// What Divvy's read-only Xero client returns (prd-05, issue #34).
//
// These are the shapes the sync (`server/xero/sync/**`) stores and the read
// routes serve, so both import them from here rather than inventing two.
//
// Every amount is integer cents (prd-05 Ruling 6; prd-01 Ruling 3: converted
// once, at the boundary, inside `server/xero/client/`). Every date is a plain
// `YYYY-MM-DD` string in the organisation's calendar, as Xero states it; no
// time zone is attached and none is implied.
//
// Receivables are shown, never counted toward safe-to-spend (prd-05 Ruling 4).
// Nothing here carries a Xero cash or bank balance, by design.

/** An outstanding sales invoice: owed to the organisation. */
export interface XeroInvoice {
  invoiceId: string
  /** Xero allows an invoice without a number. */
  invoiceNumber: string | null
  contactName: string
  type: 'ACCREC'
  status: 'AUTHORISED'
  date: string
  dueDate: string | null
  /** ISO 4217 code of the invoice; amounts are in this currency. */
  currency: string
  totalCents: number
  /** What is still owed. Outstanding totals sum this, never `totalCents`. */
  amountDueCents: number
  amountPaidCents: number
}

/**
 * An outstanding purchase bill: owed by the organisation. An undated bill is
 * kept with `dueDate: null` rather than dropped (conductor ruling on #34).
 */
export interface XeroBill {
  invoiceId: string
  /** On a bill this is the supplier's reference, which may be absent. */
  invoiceNumber: string | null
  contactName: string
  type: 'ACCPAY'
  status: 'AUTHORISED'
  date: string
  dueDate: string | null
  currency: string
  totalCents: number
  amountDueCents: number
  amountPaidCents: number
}

/** A pay run from Xero Payroll (NZ). Stored only; matching is a later PRD. */
export interface XeroPayRun {
  payRunId: string
  periodStart: string
  periodEnd: string
  paymentDate: string
  /** Xero's own status word, passed through unchanged. */
  status: string
  totalCostCents: number
  totalPayCents: number
}

/** The Net Profit line of an accrual-basis profit-and-loss report. */
export interface XeroProfitLoss {
  from: string
  to: string
  basis: 'accrual'
  netProfitCents: number
}

// Response shapes of /api/v1/xero (issue #67). No cash or bank balance field
// exists here, by design (prd-05 Ruling 4, Done-when 3). Instants are
// `Date#toISOString()` text.

/**
 * `stale` is `connected` with no stored Xero row newer than two sync
 * intervals (prd-05 Done-when 8); the server decides it, never the client.
 */
export type XeroConnectionState =
  | 'not_connected'
  | 'connected'
  | 'stale'
  | 'needs_reconnect'

/** Integer cents still owed, and how many documents make it up. */
export interface XeroAmountDue {
  amountDueCents: number
  count: number
}

/** One non-NZD currency's documents, kept apart and never converted. */
export interface XeroCurrencyAmountDue extends XeroAmountDue {
  /** ISO 4217 code; never `NZD`, which is always `XeroOutstanding.nzd`. */
  currency: string
}

/**
 * prd-05 Ruling 7: NZD is summed alone; every other currency is kept apart,
 * never converted, sorted by code.
 */
export interface XeroOutstanding {
  nzd: XeroAmountDue
  otherCurrencies: XeroCurrencyAmountDue[]
}

/** An outstanding bill as the totals list it, in its own currency. */
export interface XeroPayableBill {
  invoiceId: string
  invoiceNumber: string | null
  contactName: string
  dueDate: string | null
  amountDueCents: number
  currency: string
}

/** Payables, plus every outstanding bill in any currency: due date ascending, undated last. */
export interface XeroPayables extends XeroOutstanding {
  bills: XeroPayableBill[]
}

/** The most recently fetched profit-and-loss row. */
export interface XeroProfitSummary {
  netProfitCents: number
  periodFrom: string
  periodTo: string
  fetchedAt: string
}

/**
 * GET /api/v1/xero/totals. Every figure is `null`, never zero, when Xero is
 * not connected or nothing has ever been stored: an unconnected install must
 * not read as "$0 owed". `stale` and `needs_reconnect` keep the last-known
 * figures beside the flag.
 */
export interface XeroTotalsResponse {
  connection: XeroConnectionState
  lastSyncedAt: string | null
  receivables: XeroOutstanding | null
  payables: XeroPayables | null
  profit: XeroProfitSummary | null
  /** Payment date descending. */
  payRuns: XeroPayRun[] | null
}

/**
 * Rows stored by syncs in the last seven days. A sync re-stamps every row it
 * sees, so this is "present in this week's syncs", not "new this week".
 */
export interface XeroPulledThisWeek {
  /** The window's inclusive lower bound. */
  since: string
  receivables: XeroOutstanding
  payables: XeroOutstanding
  payRuns: { count: number; totalCostCents: number; totalPayCents: number }
  /** `netProfitCents` is the latest row fetched in the window, or null. */
  profit: { count: number; netProfitCents: number | null }
}

/** GET /api/v1/xero/status. */
export interface XeroStatusResponse {
  state: XeroConnectionState
  lastSyncedAt: string | null
  /** No Xero run record exists yet (#66); typed null so the field is reserved. */
  lastRun: null
  pulledThisWeek: XeroPulledThisWeek | null
}

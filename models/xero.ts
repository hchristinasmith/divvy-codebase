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

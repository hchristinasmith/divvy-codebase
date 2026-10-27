// Divvy's read-only Xero client (prd-05, issue #34).
//
// `createXeroClient` takes a `getAccessToken()` function and a tenant id and
// knows nothing of where either comes from: the vault (`server/xero/vault/`)
// owns tokens and refresh, the sync (`server/xero/sync/`) owns storage. This
// module reads no environment variables and logs nothing.
//
// Every request is a GET (prd-05 done-when 5); see http.ts for how that is
// enforced. Every amount comes back as integer cents. No failure resolves as
// an empty list. Every failure Xero reports (a status or a body) rejects with
// `XeroClientError`. A `getAccessToken` rejection propagates unchanged; a
// `fetch` rejection (a network error or a refused redirect) becomes a
// `request_failed` `XeroClientError` with fixed text.
//
// Plain `fetch`, not the `xero-node` SDK: the SDK deserialises amounts into
// JavaScript numbers before Divvy can see them, which is the float path
// prd-05 Ruling 6 rules out, and it is a large dependency for a handful of
// GETs.
//
// Read-only scopes each function needs (prd-05 Ruling 1). UNVERIFIED against
// a live app: Xero apps created on or after 2 March 2026 get only granular
// scopes, so a new Divvy app requests the granular names; the broad names in
// brackets exist only on older apps (until September 2027). Whichever apply,
// only `.read` scopes are requested, and a missing one surfaces as
// `forbidden`, never as no data.
//
//   getReceivableInvoices, getPayableBills   accounting.invoices.read
//                                            (accounting.transactions.read)
//   getProfitLoss                            accounting.reports.profitandloss.read
//                                            (accounting.reports.read)
//   getPayRuns                               payroll.payruns.read
//
// The sign-in consent also needs `offline_access` (for a refresh token);
// that belongs to the OAuth lane, not to this client.

import type {
  XeroBill,
  XeroInvoice,
  XeroPayRun,
  XeroProfitLoss,
} from '../../../models/xero.ts'
import type { XeroContext, XeroFetch } from './http.ts'
import { getPayableBills, getReceivableInvoices } from './invoices.ts'
import { getPayRuns } from './payRuns.ts'
import { getProfitLoss } from './profitLoss.ts'
import type { ProfitLossRange } from './profitLoss.ts'

export { XeroClientError } from './errors.ts'
export type { XeroErrorCode } from './errors.ts'
export { sumAmountDueCents } from './invoices.ts'
export type { XeroFetch } from './http.ts'
export type { ProfitLossRange } from './profitLoss.ts'

export interface XeroClientOptions {
  /** Called before every request; the client never caches its result. */
  getAccessToken: () => Promise<string>
  /** The connected organisation, sent as `Xero-tenant-id` on every request. */
  tenantId: string
  /** Defaults to `globalThis.fetch`. Tests inject a recording fake. */
  fetch?: XeroFetch
}

export interface XeroClient {
  /** Outstanding ACCREC invoices: AUTHORISED, amount due above zero. */
  getReceivableInvoices(): Promise<XeroInvoice[]>
  /** Outstanding ACCPAY bills: AUTHORISED, amount due above zero. */
  getPayableBills(): Promise<XeroBill[]>
  /** Every pay run Xero Payroll NZ returns, all pages. */
  getPayRuns(): Promise<XeroPayRun[]>
  /** Accrual-basis Net Profit for `from`..`to` inclusive. */
  getProfitLoss(range: ProfitLossRange): Promise<XeroProfitLoss>
}

export function createXeroClient(options: XeroClientOptions): XeroClient {
  const ctx: XeroContext = {
    getAccessToken: options.getAccessToken,
    tenantId: options.tenantId,
    fetch: options.fetch,
  }
  return {
    getReceivableInvoices: () => getReceivableInvoices(ctx),
    getPayableBills: () => getPayableBills(ctx),
    getPayRuns: () => getPayRuns(ctx),
    getProfitLoss: (range) => getProfitLoss(ctx, range),
  }
}

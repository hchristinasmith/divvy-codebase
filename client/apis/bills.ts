import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateOverview, queryKeys } from './queryKeys.ts'
import { grabSettingsAccounts } from './settings.ts'
import { call, request } from './http.ts'
import type {
  BillResponse,
  BillsResponse,
  CreateBillRequest,
  MarkBillPaidResponse,
  Scope,
  UpdateBillRequest,
} from '../../shared/contracts.ts'

// The Bills screen's requests (prd-02, issue 54; the route is issue 49's
// server/routes/bills.ts): the list for a scope, create, edit, delete and
// "Mark paid". A refused request rejects with an Error whose message is the
// server's own `{ error }` text, so the screen can show it as it is.
//
// Every write can move what the Overview counts as unpaid bills, so the
// screen refetches the bills and the overview after each one
// (`invalidateBills`; prd-02 Done-when 3).

function send<T>(method: 'POST' | 'PATCH', path: string, body: object): Promise<T> {
  return call(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function billPath(id: string): string {
  return `/bills/${encodeURIComponent(id)}`
}

export function grabBills(scope: Scope): Promise<BillsResponse> {
  return call(`/bills?scope=${encodeURIComponent(scope)}`)
}

// Keyed `['bills', scope]` from ./queryKeys.ts, so invalidating
// `queryKeys.bills.all` reaches every scope. No `retry` here: a per-query
// value would override the client's default.
export function billsQuery(scope: Scope) {
  return queryOptions({
    queryKey: queryKeys.bills.scoped(scope),
    queryFn: () => grabBills(scope),
  })
}

/** Refetches the bills in every scope and the overview in every scope. */
export async function invalidateBills(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.bills.all }),
    invalidateOverview(client),
  ])
}

// The accounts a bill can be paid from, for the form's picker. The key is
// the one client/screens/Settings/AccountRoles.tsx keeps privately, so both
// share one cache entry and a Settings change refetches the picker. The
// function is looked up when the query runs, not when this module loads, so
// a test that mocks ./settings.ts without it can still import the screen.
export const billAccountsQuery = queryOptions({
  queryKey: [...queryKeys.settings.all, 'accounts'] as const,
  queryFn: () => grabSettingsAccounts(),
})

/** POST: answers 201 and the bill as listed. */
export function createBill(body: CreateBillRequest): Promise<BillResponse> {
  return send('POST', '/bills', body)
}

/** PATCH: any subset of the create fields; answers the bill afterwards. */
export function updateBill(
  id: string,
  patch: UpdateBillRequest,
): Promise<BillResponse> {
  return send('PATCH', billPath(id), patch)
}

/** DELETE: answers 204 with no body; refused once the bill has payments. */
export async function removeBill(id: string): Promise<void> {
  await request(billPath(id), { method: 'DELETE' })
}

/**
 * POST: "Mark paid" records a payment for the occurrence that is due. No
 * body: the route refuses any field, and the server records the time.
 */
export function markBillPaid(id: string): Promise<MarkBillPaidResponse> {
  return call(`${billPath(id)}/payments`, { method: 'POST' })
}

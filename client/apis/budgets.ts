import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateOverview, queryKeys } from './queryKeys.ts'
import type {
  BudgetResponse,
  BudgetsResponse,
  CreateBudgetRequest,
  Scope,
  UpdateBudgetRequest,
} from '../../shared/contracts.ts'

// The Budgets screen's requests (prd-02, issue 53; the route is issue 48's
// server/routes/budgets.ts): the list for a scope, create, adjust the limit
// and delete. A refused request rejects with an Error whose message is the
// server's own `{ error }` text, so the screen can show it as it is.
//
// Every write moves the remaining budget the Overview subtracts from
// safe-to-spend, so the screen refetches the budgets and the overview after
// each one (`invalidateBudgets`; prd-02 Done-when 3).

const rootURL = new URL('/api/v1', document.baseURI)

// A copy of `request` and `call` in ./bills.ts (themselves the messages of
// `call` in ./overview.ts and `send` in ./settings.ts). DELETE answers 204
// with no body, so `removeBudget` needs the checked response without
// `.json()`.
async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${rootURL}${path}`, init)
  } catch {
    throw new Error('The server could not be reached')
  }
  if (!response.ok) {
    let message: unknown
    try {
      message = ((await response.json()) as { error?: unknown }).error
    } catch {
      message = undefined
    }
    if (typeof message === 'string') throw new Error(message)
    throw new Error(`Server error (${response.status})`)
  }
  return response
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init)
  return (await response.json()) as T
}

function send<T>(method: 'POST' | 'PATCH', path: string, body: object): Promise<T> {
  return call(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function budgetPath(id: string): string {
  return `/budgets/${encodeURIComponent(id)}`
}

export function grabBudgets(scope: Scope): Promise<BudgetsResponse> {
  return call(`/budgets?scope=${encodeURIComponent(scope)}`)
}

// Keyed `['budgets', scope]` from ./queryKeys.ts, so invalidating
// `queryKeys.budgets.all` reaches every scope. No `retry` here: a per-query
// value would override the client's default.
export function budgetsQuery(scope: Scope) {
  return queryOptions({
    queryKey: queryKeys.budgets.scoped(scope),
    queryFn: () => grabBudgets(scope),
  })
}

/** Refetches the budgets in every scope and the overview in every scope. */
export async function invalidateBudgets(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.budgets.all }),
    invalidateOverview(client),
  ])
}

/** POST: answers 201 and the budget's line; 409 when the category already has one in that scope. */
export function createBudget(body: CreateBudgetRequest): Promise<BudgetResponse> {
  return send('POST', '/budgets', body)
}

/** PATCH: the new absolute limit and/or note; answers the budget's line afterwards. */
export function updateBudget(
  id: string,
  patch: UpdateBudgetRequest,
): Promise<BudgetResponse> {
  return send('PATCH', budgetPath(id), patch)
}

/** DELETE: answers 204 with no body. */
export async function removeBudget(id: string): Promise<void> {
  await request(budgetPath(id), { method: 'DELETE' })
}

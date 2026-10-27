import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateOverview, queryKeys } from './queryKeys.ts'
import type {
  ApplyCategoryResponse,
  CategoriseGroupsResponse,
  Scope,
} from '../../shared/contracts.ts'

// The Sort screen's requests (prd-02 Ruling 17, issue 259): the merchant
// groups for a scope, and applying one category to a whole group. A refused
// request rejects with an Error whose message is the server's own
// `{ error }` text, so the screen can show it as it is. Every figure is the
// server's; nothing here does money arithmetic.

const rootURL = new URL('/api/v1', document.baseURI)

// A copy of `call` in ./goals.ts, ./overview.ts and ./subscriptions.ts
// (itself the same messages as `send` in ./settings.ts); ./sync.ts has one
// more that also refuses a 200 that is not JSON. Change all together (#249
// tracks lifting it): the server's text when it sent one, its status when
// it did not, or that it could not be reached.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
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
  return (await response.json()) as T
}

/**
 * POST /api/v1/categorise/groups/apply's body, in its wire names. The
 * server's own type is in server/db/categorise.ts, which the client does not
 * import.
 */
export interface ApplyGroupBody {
  scope: Scope
  merchant_key: string
  category: string
}

export function grabGroups(scope: Scope): Promise<CategoriseGroupsResponse> {
  return call(`/categorise/groups?scope=${encodeURIComponent(scope)}`)
}

// The query key lives here rather than in ./queryKeys.ts because that file
// is not this issue's to edit. The shape is that file's: `[domain, scope]`,
// so invalidating the prefix reaches every scope. No `retry` here: a
// per-query value would override the client's default.
export const CATEGORISE_KEY = ['categorise'] as const

export function groupsQuery(scope: Scope) {
  return queryOptions({
    queryKey: [...CATEGORISE_KEY, scope] as const,
    queryFn: () => grabGroups(scope),
  })
}

/** POST: categorises every row of one merchant's group as it is now. */
export function applyGroup(body: ApplyGroupBody): Promise<ApplyCategoryResponse> {
  return call('/categorise/groups/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Everything a category change can move: the Overview (budgets spent and
 * activity read the effective category), the budgets list, both transaction
 * lists (`['transactions']` in client/components/Dashboard, `['txns']` in
 * client/components/Transactions), and the groups in every scope.
 */
export async function invalidateAfterApply(client: QueryClient): Promise<void> {
  await Promise.all([
    invalidateOverview(client),
    client.invalidateQueries({ queryKey: queryKeys.budgets.all }),
    client.invalidateQueries({ queryKey: ['transactions'] }),
    client.invalidateQueries({ queryKey: ['txns'] }),
    client.invalidateQueries({ queryKey: CATEGORISE_KEY }),
  ])
}

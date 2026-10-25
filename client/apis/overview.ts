import { queryOptions } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.ts'
import type {
  DismissAlertResponse,
  OverviewResponse,
  Scope,
} from '../../shared/contracts.ts'
import type {
  CategoriesResponse,
  CategoryGroup,
} from '../../models/categories.ts'
import type {
  UpdateTransactionCategory,
  UpdateTransactionCategoryResponse,
} from '../../models/transactions.ts'

// The Overview screen's requests (prd-02, issue 45): the overview read, an
// alert dismissal, the category list and the inline category edit. A
// refused request rejects with an Error whose message is the server's own
// `{ error }` text, so the screen can show it as it is.
//
// Built on `fetch` rather than superagent: every test that renders the
// shell already stubs `fetch` for the sync pill, and the sidebar badge now
// fires the overview read too, so those tests need nothing new.

const rootURL = new URL('/api/v1', document.baseURI)

// The same messages as `send` in ./settings.ts: the server's text when
// it sent one, its status when it did not, or that it could not be reached.
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

export function grabOverview(scope: Scope): Promise<OverviewResponse> {
  return call(`/overview?scope=${encodeURIComponent(scope)}`)
}

// The one definition of the overview query. The screen and the nav badge
// (`useAlertCount`) both spread it, so they share one cache entry, and
// `invalidateOverview` in ./queryKeys.ts reaches both. No `retry` here: a
// per-query value would override the client's default.
export function overviewQuery(scope: Scope) {
  return queryOptions({
    queryKey: queryKeys.overview.scoped(scope),
    queryFn: () => grabOverview(scope),
  })
}

/**
 * POST: dismisses a derived alert. Served under the overview mount, not at
 * the /api/v1/alerts path the contract's comment names (see
 * server/routes/overview.ts). The id holds colons, so it is encoded.
 */
export function dismissOverviewAlert(id: string): Promise<DismissAlertResponse> {
  return call(`/overview/alerts/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
  })
}

export async function grabCategoryGroups(): Promise<CategoryGroup[]> {
  const body = await call<CategoriesResponse>('/categories')
  return body.items
}

// The category list is a fixed file on the server (data/cats.js), so it is
// read once per session. Its key lives here rather than in ./queryKeys.ts
// because that file is not this issue's to edit; move it there when a
// second screen reads categories.
export const categoriesQuery = queryOptions({
  queryKey: ['categories'] as const,
  queryFn: grabCategoryGroups,
  staleTime: Infinity,
})

/** PATCH: sets the user's category (M1 #9). A pending row is refused. */
export function setTransactionCategory(
  id: string,
  category: string,
): Promise<UpdateTransactionCategoryResponse> {
  const body: UpdateTransactionCategory = { category }
  return call(`/transactions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

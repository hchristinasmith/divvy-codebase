import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Insight } from '../../../models/insights.ts'
import type { Scope } from '../../../shared/contracts.ts'

// The insights inbox as the Habits screen's Patterns card reads it (prd-04
// Ruling 2, Ruling 3; #63): the insights not yet dismissed, and the dismiss
// route from #51. Dismissing only sets `dismissed_at`.
//
// Fetch lives in this file rather than client/apis/, which is not this
// issue's to edit. `call` copies the one in ./useProposals.ts: a refused
// request rejects with the server's own `{ error }` text, its status when it
// sent none, or that it could not be reached.
//
// The key lives here for the same reason, keyed by scope so a switch never
// shows another scope's insights; move it to client/apis/queryKeys.ts when a
// second screen reads insights.
const INSIGHTS_KEY = ['insights'] as const
const insightsKey = (scope: Scope) => [...INSIGHTS_KEY, scope] as const

const rootURL = new URL('/api/v1', document.baseURI)

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

/** GET /api/v1/agents/insights, which never includes a dismissed insight. */
interface ListInsightsResponse {
  items: Insight[]
}

/** The scope's insights not yet dismissed. */
export function useInsights(scope: Scope) {
  return useQuery({
    queryKey: insightsKey(scope),
    queryFn: async () =>
      (await call<ListInsightsResponse>(
        `/agents/insights?scope=${encodeURIComponent(scope)}`,
      )).items,
  })
}

/**
 * Dismisses one insight. On success it leaves every cached scope's list, as
 * the same insight is also in `all`'s; a failure leaves the lists as they
 * were.
 */
export function useDismissInsight() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      call<unknown>(`/agents/insights/${id}/dismiss`, { method: 'POST' }),
    onSuccess: (_body, id) => {
      client.setQueriesData<Insight[]>({ queryKey: INSIGHTS_KEY }, (items) =>
        items?.filter((i) => i.id !== id),
      )
    },
  })
}

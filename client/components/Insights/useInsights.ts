import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Insight } from '../../../models/insights.ts'
import type { Scope } from '../../../shared/contracts.ts'
import { call } from '../../apis/http.ts'

// The insights inbox as the Habits screen's Patterns card reads it (prd-04
// Ruling 2, Ruling 3; #63): the insights not yet dismissed, and the dismiss
// route from #51. Dismissing only sets `dismissed_at`.
//
// Requests go through client/apis/http.ts. The key lives here, not in
// client/apis/queryKeys.ts, which is not this issue's to edit; it is keyed
// by scope so a switch never shows another scope's insights. Move it there
// when a second screen reads insights.
const INSIGHTS_KEY = ['insights'] as const
const insightsKey = (scope: Scope) => [...INSIGHTS_KEY, scope] as const

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

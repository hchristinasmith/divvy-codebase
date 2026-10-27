import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.ts'
import { call } from './http.ts'
import type {
  HabitsResponse,
  Scope,
  SetVerdictRequest,
  Verdict,
  VerdictRow,
} from '../../shared/contracts.ts'

// The Habits screen's requests (prd-02, issue 57; the route is issue 52's
// server/routes/habits.ts): runway, the computable streaks and the spending
// listed for a verdict, for one scope; and Hannah's verdict on one spend. A
// refused request rejects with an Error whose message is the server's own
// `{ error }` text, so the screen can show it as it is.
//
// A verdict is a tag, not money: it never moves safe-to-spend, so nothing in
// this module touches the Overview's query.

export function grabHabits(scope: Scope): Promise<HabitsResponse> {
  return call(`/habits?scope=${encodeURIComponent(scope)}`)
}

// Keyed `['habits', scope]`: the domain from ./queryKeys.ts with the scope
// second, as its shape rule says, so invalidating `queryKeys.habits.all`
// reaches every scope. No `retry` here: a per-query value would override
// the client's default.
export function habitsQuery(scope: Scope) {
  return queryOptions({
    queryKey: [...queryKeys.habits.all, scope] as const,
    queryFn: () => grabHabits(scope),
  })
}

/**
 * Refetches the habits in every scope, and nothing else: a verdict tagged
 * under Personal is listed under All too. Never the Overview: a verdict
 * cannot move safe-to-spend.
 */
export function invalidateHabits(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.habits.all })
}

/**
 * PUT: stores Hannah's verdict on one spend and answers its row; null
 * clears it.
 */
export function setVerdict(
  transactionId: string,
  verdict: Verdict | null,
): Promise<VerdictRow> {
  const body: SetVerdictRequest = { verdict }
  return call(`/habits/verdicts/${encodeURIComponent(transactionId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.ts'
import type {
  AddGoalContributionRequest,
  AddGoalContributionResponse,
  CreateGoalRequest,
  GoalResponse,
  GoalsResponse,
} from '../../shared/contracts.ts'

// The Goals screen's requests (prd-02, issue 56): the list, creating a goal
// and recording a contribution. A refused request rejects with an Error
// whose message is the server's own `{ error }` text, so the screen can show
// it as it is.
//
// A contribution is a record of a transfer Hannah makes herself, not a
// transfer (prd-02 Ruling 5): it never changes safe-to-spend, so nothing in
// this module touches the Overview's query. Editing and deleting a goal are
// routes the screen does not offer yet, so they are not here.

const rootURL = new URL('/api/v1', document.baseURI)

// A copy of `call` in ./subscriptions.ts (itself a copy of `call` in
// ./overview.ts, the same messages as `send` in ./settings.ts): the server's
// text when it sent one, its status when it did not, or that it could not be
// reached.
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

// A copy of `send` in ./subscriptions.ts, POST only.
function send<T>(path: string, body: object): Promise<T> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function grabGoals(): Promise<GoalsResponse> {
  return call('/goals')
}

// Goals have no scope, so the key is the domain alone. No `retry` here: a
// per-query value would override the client's default.
export function goalsQuery() {
  return queryOptions({
    queryKey: queryKeys.goals.all,
    queryFn: grabGoals,
  })
}

/**
 * Refetches the goals list, and nothing else. Never the Overview: a goal
 * write cannot move safe-to-spend (prd-02 Ruling 5).
 */
export function invalidateGoals(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.goals.all })
}

/** POST: creates a goal with nothing saved. Answers the goal (201). */
export function createGoal(body: CreateGoalRequest): Promise<GoalResponse> {
  return send('/goals', body)
}

/**
 * POST: records a contribution of `amountCents` and answers the goal
 * afterwards. A record only: no money moves (prd-02 Ruling 5).
 */
export function addContribution(
  id: string,
  amountCents: number,
): Promise<AddGoalContributionResponse> {
  const body: AddGoalContributionRequest = { amountCents }
  return send(`/goals/${encodeURIComponent(id)}/contributions`, body)
}

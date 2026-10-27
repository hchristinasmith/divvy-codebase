import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import type {
  CancelSubscriptionRequest,
  MarkSubscriptionRequest,
  RowScope,
  Scope,
  SubscriptionAnswer,
  SubscriptionMarkResponse,
  SubscriptionsResponse,
  UncancelSubscriptionRequest,
} from '../../shared/contracts.ts'
import { call } from './http.ts'

// The Subscriptions screen's requests (prd-02 Ruling 14, issue 230): the
// read for a scope, Hannah's answer about a merchant, and the cancel and
// uncancel marks. A refused request rejects with an Error whose message is
// the server's own `{ error }` text, so the screen can show it as it is.
//
// A write names one merchant in one row scope, never `all`; `Target` makes
// that a compile error. The cancel request sends no `on` date; the server
// records today in NZ.

function send<T>(method: 'PUT' | 'POST', path: string, body: object): Promise<T> {
  return call(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The merchant a write names: one row scope, never `all`. */
export interface SubscriptionTarget {
  scope: RowScope
  merchantKey: string
}

export function grabSubscriptions(scope: Scope): Promise<SubscriptionsResponse> {
  return call(`/subscriptions?scope=${encodeURIComponent(scope)}`)
}

// The query keys live here rather than in ./queryKeys.ts because that file
// is not this issue's to edit; move them there when a second screen reads
// subscriptions. The shape is that file's: `[domain, scope]`, so
// invalidating the prefix reaches every scope. No `retry` here: a per-query
// value would override the client's default.
export const SUBSCRIPTIONS_KEY = ['subscriptions'] as const

export function subscriptionsQuery(scope: Scope) {
  return queryOptions({
    queryKey: ['subscriptions', scope] as const,
    queryFn: () => grabSubscriptions(scope),
  })
}

/** Refetches the subscriptions read in every scope. */
export function invalidateSubscriptions(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY })
}

/** PUT: stores her answer. Null clears it; the key is always sent. */
export function markSubscription(
  target: SubscriptionTarget,
  answer: SubscriptionAnswer | null,
): Promise<SubscriptionMarkResponse> {
  const body: MarkSubscriptionRequest = {
    scope: target.scope,
    merchantKey: target.merchantKey,
    answer,
  }
  return send('PUT', '/subscriptions/mark', body)
}

/** POST: records that she cancelled it, today in NZ. Nothing is sent to the merchant. */
export function cancelSubscription(
  target: SubscriptionTarget,
): Promise<SubscriptionMarkResponse> {
  const body: CancelSubscriptionRequest = {
    scope: target.scope,
    merchantKey: target.merchantKey,
  }
  return send('POST', '/subscriptions/cancel', body)
}

/** POST: clears the cancel date. */
export function uncancelSubscription(
  target: SubscriptionTarget,
): Promise<SubscriptionMarkResponse> {
  const body: UncancelSubscriptionRequest = {
    scope: target.scope,
    merchantKey: target.merchantKey,
  }
  return send('POST', '/subscriptions/uncancel', body)
}

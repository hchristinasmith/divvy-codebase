import { vi } from 'vitest'
import { pendingFetch } from '../../Shell/__tests__/renderWithProviders.tsx'
import type {
  SubscriptionMerchant,
  SubscriptionRow,
  SubscriptionsResponse,
} from '../../../../shared/contracts.ts'

// Subscriptions fixtures and a routing fetch stub for the screen tests. Not
// a test file: vitest collects only `*.test.ts(x)`. Every name, key and
// amount is invented, in integer cents.

export function merchant(
  fields: Partial<SubscriptionMerchant> = {},
): SubscriptionMerchant {
  return {
    merchantKey: 'm:merchant_invented_cloud',
    scope: 'personal',
    name: 'Sample Cloud',
    chargeCount: 2,
    lastChargedOn: '2026-10-03',
    amountCents: 499,
    ...fields,
  }
}

export function row(fields: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    merchantKey: 'm:merchant_invented_stream',
    scope: 'personal',
    name: 'Example Stream',
    chargeCount: 3,
    lastChargedOn: '2026-10-01',
    amountCents: 1599,
    cadence: 'monthly',
    detected: true,
    marked: false,
    status: 'active',
    cancelledOn: null,
    chargedAgainOn: null,
    perMonthCents: 1599,
    perYearCents: 19188,
    ...fields,
  }
}

export function response(
  fields: Partial<SubscriptionsResponse> = {},
): SubscriptionsResponse {
  return {
    subscriptions: [row()],
    questions: [],
    notSubscriptions: [],
    totals: {
      perMonthCents: 1599,
      perYearCents: 19188,
      countedCount: 1,
      uncountedCount: 0,
    },
    ...fields,
  }
}

export interface FetchCall {
  method: string
  url: URL
  body: string | undefined
}

/** What a handler answers: a JSON body and a status (200 by default). */
export interface Reply {
  status?: number
  body: unknown
}

/** A handler answers, or returns undefined to leave the request pending. */
export type Handler = (call: FetchCall) => Reply | undefined

export interface Handlers {
  list?: Handler
  mark?: Handler
  cancel?: Handler
  uncancel?: Handler
}

/** The stored answer the three writes reply with; the screen ignores it. */
export const STORED: Reply = {
  body: {
    scope: 'personal',
    merchantKey: 'm:merchant_invented_stream',
    answer: null,
    cancelledOn: null,
  },
}

/**
 * A copy in shape of `installFetch` in
 * client/screens/Overview/__tests__/fixtures.ts, which is another screen's
 * file. Stubs global `fetch`, routing by method and path. Handlers can be
 * swapped mid-test through the returned object. Anything without a handler,
 * including the sync pill's `/sync/status`, never settles. Every call is
 * recorded.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { ...initial }
  const calls: FetchCall[] = []

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (call.method === 'GET' && path === '/api/v1/subscriptions') {
      return handlers.list
    }
    if (call.method === 'PUT' && path === '/api/v1/subscriptions/mark') {
      return handlers.mark
    }
    if (call.method === 'POST' && path === '/api/v1/subscriptions/cancel') {
      return handlers.cancel
    }
    if (call.method === 'POST' && path === '/api/v1/subscriptions/uncancel') {
      return handlers.uncancel
    }
    return undefined
  }

  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const reply = route(call)?.(call)
    if (reply === undefined) return pendingFetch()
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchStub)

  return {
    handlers,
    calls,
    /** The recorded calls for one method and path. */
    callsTo(method: string, path: string): FetchCall[] {
      return calls.filter((c) => c.method === method && c.url.pathname === path)
    },
    /** The parsed bodies sent to one method and path. */
    bodiesTo(method: string, path: string): Record<string, unknown>[] {
      return calls
        .filter((c) => c.method === method && c.url.pathname === path)
        .map((c) => JSON.parse(c.body ?? 'null') as Record<string, unknown>)
    },
  }
}

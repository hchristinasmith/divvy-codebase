import { vi } from 'vitest'
import { pendingFetch } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  BudgetResponse,
  BudgetsResponse,
} from '../../../../shared/contracts.ts'
import type { CategoryGroup } from '../../../../models/categories.ts'

// Budgets fixtures and a routing fetch stub for the screen tests. Not a test
// file: vitest collects only `*.test.ts(x)`. Every amount is invented, in
// integer cents. Spent, remaining and over are set by hand, never derived,
// so a screen that recomputes them from spent and limit cannot pass.

export function budget(fields: Partial<BudgetResponse> = {}): BudgetResponse {
  return {
    id: '7',
    scope: 'personal',
    category: 'Supermarkets and grocery stores',
    limitCents: 15000,
    spentCents: 4520,
    remainingCents: 10480,
    overCents: 0,
    note: 'Invented: the weekly shop',
    ...fields,
  }
}

export function response(fields: Partial<BudgetsResponse> = {}): BudgetsResponse {
  return {
    items: [budget()],
    periodStart: '2026-10-27',
    periodEnd: '2026-11-03',
    ...fields,
  }
}

// Drawings is in Divvy's own group, as the server lists it; the form must
// leave it out.
export const GROUPS: CategoryGroup[] = [
  {
    name: 'Food',
    categories: ['Bakeries', 'Supermarkets and grocery stores'],
  },
  { name: 'Lifestyle', categories: ['Cafes and restaurants'] },
  { name: 'Divvy', categories: ['Drawings'] },
]

export interface FetchCall {
  method: string
  url: URL
  body: string | undefined
}

/** What a handler answers: a body and a status (200 by default). No body is a bodiless reply, as a 204. */
export interface Reply {
  status?: number
  body?: unknown
}

/** A handler answers, or returns undefined to leave the request pending. */
export type Handler = (call: FetchCall) => Reply | undefined

export interface Handlers {
  list?: Handler
  create?: Handler
  update?: Handler
  remove?: Handler
  overview?: Handler
  categories?: Handler
}

const BUDGET_PATH = /^\/api\/v1\/budgets\/([^/]+)$/

/**
 * A copy in shape of `installFetch` in ../../Bills/__tests__/fixtures.ts,
 * routed to the budgets paths, the overview and the category list. Stubs
 * global `fetch`, routing by method and path; it can answer with no body,
 * as DELETE's 204 does. Handlers can be swapped mid-test through the
 * returned object. Anything without a handler, including the sync pill's
 * `/sync/status`, never settles. Every call is recorded.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { ...initial }
  const calls: FetchCall[] = []

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (path === '/api/v1/budgets') {
      if (call.method === 'GET') return handlers.list
      if (call.method === 'POST') return handlers.create
    }
    if (BUDGET_PATH.test(path)) {
      if (call.method === 'PATCH') return handlers.update
      if (call.method === 'DELETE') return handlers.remove
    }
    if (call.method === 'GET' && path === '/api/v1/overview') {
      return handlers.overview
    }
    if (call.method === 'GET' && path === '/api/v1/categories') {
      return handlers.categories
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
    const status = reply.status ?? 200
    // A Response with a 204 status refuses any body, even an empty string.
    if (reply.body === undefined) {
      return Promise.resolve(new Response(null, { status }))
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status,
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

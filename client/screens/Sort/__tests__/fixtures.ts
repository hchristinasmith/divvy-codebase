import { vi } from 'vitest'
import { pendingFetch } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  CategoriseGroupResponse,
  CategoriseGroupsResponse,
} from '../../../../shared/contracts.ts'
import type { CategoriesResponse } from '../../../../models/categories.ts'

// Sort fixtures and a routing fetch stub for the screen tests. Not a test
// file: vitest collects only `*.test.ts(x)`. Every name, key and amount is
// invented, in integer cents.

export function group(
  fields: Partial<CategoriseGroupResponse> = {},
): CategoriseGroupResponse {
  return {
    merchantKey: 'm:merchant_invented_cafe',
    name: 'EXAMPLE CAFE',
    count: 5,
    totalCents: 2450,
    receivedCents: 0,
    latestDate: '2026-10-05',
    latestAmountCents: -390,
    ...fields,
  }
}

export const CAFE = group()
export const BAKERY = group({
  merchantKey: 'd:example bakery',
  name: 'EXAMPLE BAKERY',
  count: 2,
  totalCents: 1200,
  receivedCents: 300,
  latestDate: '2025-12-24',
  latestAmountCents: 300,
})
export const FUEL = group({
  merchantKey: 'm:merchant_invented_fuel',
  name: 'EXAMPLE FUEL',
  count: 1,
  totalCents: 800,
  latestDate: null,
  latestAmountCents: -800,
})

export function groupsResponse(
  groups: CategoriseGroupResponse[] = [CAFE, BAKERY, FUEL],
): CategoriseGroupsResponse {
  return { groups }
}

/** A slice of data/cats.js, plus Divvy's own group, as GET /categories answers. */
export const CATEGORIES: CategoriesResponse = {
  items: [
    {
      name: 'Food',
      categories: ['Bakeries', 'Supermarkets and grocery stores'],
    },
    {
      name: 'Lifestyle',
      categories: [
        'Cafes and restaurants',
        'Fast food stores',
        'Media and entertainment streaming services',
      ],
    },
    {
      name: 'Transport',
      categories: ['Fuel stations', 'Parking services'],
    },
    {
      name: 'Professional Services',
      categories: ['Business software and cloud services'],
    },
    { name: 'Divvy', categories: ['Drawings'] },
  ],
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
  groups?: Handler
  apply?: Handler
  categories?: Handler
}

export const GROUPS = '/api/v1/categorise/groups'
export const APPLY = '/api/v1/categorise/groups/apply'
export const CATEGORIES_PATH = '/api/v1/categories'

/**
 * A copy in shape of `installFetch` in
 * client/components/Subscriptions/__tests__/fixtures.ts and
 * client/screens/Overview/__tests__/fixtures.ts, which are other screens'
 * files. Stubs global `fetch`, routing by method and path. Handlers can be
 * swapped mid-test through the returned object. Anything without a handler,
 * including the sync pill's `/sync/status`, never settles. Every call is
 * recorded.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { ...initial }
  const calls: FetchCall[] = []

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (call.method === 'GET' && path === GROUPS) return handlers.groups
    if (call.method === 'POST' && path === APPLY) return handlers.apply
    if (call.method === 'GET' && path === CATEGORIES_PATH) {
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

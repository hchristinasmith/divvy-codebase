import { vi } from 'vitest'
import { pendingFetch } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  BillResponse,
  BillsResponse,
  SettingsAccountsResponse,
} from '../../../../shared/contracts.ts'

// Bills fixtures and a routing fetch stub for the screen tests. Not a test
// file: vitest collects only `*.test.ts(x)`. Every name, id and amount is
// invented, in integer cents.

export function bill(fields: Partial<BillResponse> = {}): BillResponse {
  return {
    id: '12',
    scope: 'personal',
    name: 'Invented Power Co',
    amountCents: 120000,
    dueDate: '2026-11-01',
    repeat: 'monthly',
    firstDueDate: '2026-10-01',
    paid: false,
    paidAt: null,
    accountName: 'Test Everyday',
    ...fields,
  }
}

export function response(fields: Partial<BillsResponse> = {}): BillsResponse {
  const items = fields.items ?? [bill()]
  return {
    items,
    // Deliberately unequal to any sum of the rows' amounts, so a tile that
    // adds the rows up cannot pass.
    dueBeforePaydayCents: 98765,
    nextBill: items.find((b) => !b.paid) ?? null,
    paidThisMonthCents: 4321,
    ...fields,
  }
}

export const ACCOUNTS: SettingsAccountsResponse = {
  items: [
    { id: '1', name: 'Test Everyday', scope: 'personal', role: 'current' },
    { id: '2', name: 'Test Savings', scope: 'personal', role: 'savings' },
    { id: '3', name: 'Test Trading', scope: 'strawb', role: 'current' },
  ],
}

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
  pay?: Handler
  overview?: Handler
}

const BILL_PATH = /^\/api\/v1\/bills\/([^/]+)$/
const PAY_PATH = /^\/api\/v1\/bills\/([^/]+)\/payments$/

/**
 * A copy in shape of `installFetch` in
 * client/screens/Overview/__tests__/fixtures.ts and
 * client/components/Subscriptions/__tests__/fixtures.ts, which are outside
 * this issue's fence. Stubs global `fetch`, routing by method and path; this copy
 * can also answer with no body, as DELETE's 204 does. Handlers can be
 * swapped mid-test through the returned object. Anything without a handler,
 * including the sync pill's `/sync/status`, never settles. Every call is
 * recorded.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { ...initial }
  const calls: FetchCall[] = []

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (path === '/api/v1/bills') {
      if (call.method === 'GET') return handlers.list
      if (call.method === 'POST') return handlers.create
    }
    if (BILL_PATH.test(path)) {
      if (call.method === 'PATCH') return handlers.update
      if (call.method === 'DELETE') return handlers.remove
    }
    if (call.method === 'POST' && PAY_PATH.test(path)) return handlers.pay
    if (call.method === 'GET' && path === '/api/v1/overview') {
      return handlers.overview
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

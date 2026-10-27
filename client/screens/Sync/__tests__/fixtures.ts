import { vi } from 'vitest'
import { pendingFetch } from '../../../components/Shell/__tests__/renderWithProviders.tsx'

// Sync screen fixtures and a routing fetch stub. Not a test file: vitest
// collects only `*.test.ts(x)`. Every name is invented. Fields the screen
// must never show (ids, account numbers, balances, logos, the run's error
// code) carry SENTINEL, so a test can look for it in the rendered text.

export const SENTINEL = 'SENTINEL'

/**
 * An account item in `GET /api/v1/accounts`'s envelope, Akahu-shaped. A
 * `connectionName` of undefined leaves `connection` out, as the route does
 * when every connection column is NULL; null sends a connection whose name
 * is null.
 */
export function accountItem(
  name: string,
  connectionName: string | null | undefined,
  n = 1,
): Record<string, unknown> {
  return {
    _id: `acc_SENTINEL_${n}`,
    name,
    attributes: ['TRANSACTIONS'],
    formatted_account: `00-SENTINEL-${n}`,
    type: 'CHECKING',
    status: 'ACTIVE',
    _authorisation: `auth_SENTINEL_${n}`,
    ...(connectionName === undefined
      ? {}
      : {
          connection: {
            _id: `conn_SENTINEL_${n}`,
            name: connectionName,
            logo: `https://logo.invalid/SENTINEL-${n}.png`,
          },
        }),
    balance: { currency: 'NZD', current: 98765.43, available: 87654.32 },
    refreshed: { balance: '2026-10-20T00:00:00.000Z' },
  }
}

export const ACCOUNTS_BODY = {
  success: true,
  items: [
    accountItem('Sample Everyday', 'Test Bank', 1),
    accountItem('Sample Business', 'Other Test Bank', 2),
    accountItem('Sample Savings', 'Test Bank', 3),
  ],
}

export const minutesBefore = (now: number, n: number) =>
  new Date(now - n * 60_000).toISOString()

/** A `GET /sync/status` body. Defaults: idle, never run. */
export function statusBody(
  overrides: Partial<{
    running: boolean
    lastRun: Record<string, unknown> | null
    lastSuccessAt: string | null
    nextRunAt: string | null
  }> = {},
) {
  return {
    running: false,
    lastRun: null,
    lastSuccessAt: null,
    nextRunAt: null,
    ...overrides,
  }
}

/** A `lastRun` object, with the machine error code the screen must drop. */
export function run(
  outcome: 'running' | 'success' | 'failed',
  startedAt: string,
  finishedAt: string | null,
) {
  return {
    id: 7,
    startedAt,
    finishedAt,
    outcome,
    counts: { inserted: 0, updated: 0, pendingMirrored: 0 },
    error: outcome === 'failed' ? 'akahu_unauthorized SENTINEL' : null,
  }
}

/** What a handler answers: a body (JSON unless a string) and a status. */
export interface Reply {
  status?: number
  body: unknown
}

/**
 * A handler answers, returns 'pending' to leave the request unsettled, or
 * 'reject' to fail it as an unreachable server does. A promise of either
 * answer settles the request when the test resolves it.
 */
type Answer = Reply | 'reject'
export type Handler = () => Answer | 'pending' | Promise<Answer>

export interface Handlers {
  status?: Handler
  accounts?: Handler
  run?: Handler
}

export interface FetchCall {
  method: string
  url: URL
  body: unknown
}

/**
 * Stubs global `fetch`, routing by method and path. Both the screen's and
 * the header pill's status reads reach `status`. Anything without a
 * handler never settles. Handlers can be swapped mid-test through the
 * returned object; every call is recorded.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { ...initial }
  const calls: FetchCall[] = []

  function respond(answer: Answer): Promise<Response> {
    if (answer === 'reject') return Promise.reject(new TypeError('offline'))
    const text =
      typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return Promise.resolve(
      new Response(text, {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (call.method === 'GET' && path === '/api/v1/sync/status') {
      return handlers.status
    }
    if (call.method === 'GET' && path === '/api/v1/accounts') {
      return handlers.accounts
    }
    if (call.method === 'POST' && path === '/api/v1/sync/run') {
      return handlers.run
    }
    return undefined
  }

  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      body: init?.body,
    }
    calls.push(call)
    const reply = route(call)?.() ?? 'pending'
    if (reply === 'pending') return pendingFetch()
    return Promise.resolve(reply).then(respond)
  })
  vi.stubGlobal('fetch', fetchStub)

  return {
    handlers,
    calls,
    /** The recorded calls for one method and path. */
    callsTo(method: string, path: string): FetchCall[] {
      return calls.filter(
        (c) => c.method === method && c.url.pathname === path,
      )
    },
  }
}

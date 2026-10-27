import { vi } from 'vitest'
import { pendingFetch } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  HabitStreak,
  HabitsResponse,
  VerdictRow,
} from '../../../../shared/contracts.ts'

// Habits fixtures and a routing fetch stub for the screen tests. Not a test
// file: vitest collects only `*.test.ts(x)`. Every name and amount is
// invented, in integer cents.

export function streak(fields: Partial<HabitStreak> = {}): HabitStreak {
  return { key: 'no_overdraft', label: 'No overdraft', days: 58, ...fields }
}

export function verdictRow(fields: Partial<VerdictRow> = {}): VerdictRow {
  return {
    transactionId: '101',
    date: '2026-10-20',
    merchant: 'Example Grocer',
    category: 'Groceries',
    amountCents: -128000,
    verdict: null,
    ...fields,
  }
}

export function habitsResponse(fields: Partial<HabitsResponse> = {}): HabitsResponse {
  return {
    runwayTenths: 78,
    streaks: [streak()],
    verdicts: [verdictRow()],
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
  verdict?: Handler
  overview?: Handler
}

/**
 * A copy in shape of `installFetch` in ../../Goals/__tests__/fixtures.ts,
 * which is another screen's file. Stubs global `fetch`, routing by method
 * and path. Handlers can be swapped mid-test through the returned object.
 * Anything without a handler, including the sync pill's `/sync/status`,
 * never settles; so does a handler that answers undefined. A fetch that
 * throws is a handler that throws. Every call is recorded.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { ...initial }
  const calls: FetchCall[] = []

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (call.method === 'GET' && path === '/api/v1/habits') return handlers.list
    if (call.method === 'PUT' && /^\/api\/v1\/habits\/verdicts\/[^/]+$/.test(path)) {
      return handlers.verdict
    }
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
    let reply: Reply | undefined
    try {
      reply = route(call)?.(call)
    } catch (err) {
      return Promise.reject(err)
    }
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

/**
 * A stand-in server for the verdict round trip: the list answers the rows
 * as they are now, and a PUT stores the verdict it was sent on the row it
 * names and answers that row, as server/routes/habits.ts does. The rows
 * outlive a render, so a second render is a reload.
 */
export function verdictServer(body: HabitsResponse) {
  const rows = body.verdicts.map((r) => ({ ...r }))
  const list: Handler = () => ({ body: { ...body, verdicts: rows.map((r) => ({ ...r })) } })
  const verdict: Handler = (call) => {
    const id = call.url.pathname.split('/').pop()
    const row = rows.find((r) => r.transactionId === id)
    if (row === undefined) return { status: 404, body: { error: 'Transaction not found' } }
    const sent = JSON.parse(call.body ?? 'null') as { verdict: VerdictRow['verdict'] }
    row.verdict = sent.verdict
    return { body: { ...row } }
  }
  return { rows, list, verdict }
}

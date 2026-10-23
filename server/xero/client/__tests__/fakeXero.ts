// Test helpers for the Xero client: fixture text and a recording fetch.
//
// Fixtures are read as raw text and served as a Response body, exactly as
// Xero's bytes would arrive. They are never imported as JSON modules, which
// would turn every amount into a float before the client could see it.

import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createXeroClient } from '../index.ts'
import type { XeroClient } from '../index.ts'
import type { XeroGetInit } from '../http.ts'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))
export const fixturesDir = Path.join(__dirname, '../__fixtures__')

export function fixture(name: string): string {
  return readFileSync(Path.join(fixturesDir, name), 'utf8')
}

/** Values no log line, error message or serialised error may contain. */
export const SENTINEL_TOKEN = 'sentinel-access-token-5b7e1c'
export const SENTINEL_TENANT = 'sentinel-tenant-id-93d04a'

export type Reply =
  | string
  | { status: number; body?: string; headers?: Record<string, string> }

export interface RecordedCall {
  url: URL
  init: XeroGetInit
}

/**
 * A fetch that answers with `replies` in order and records every call. When
 * the replies run out it answers with `onExhausted` if given, else it throws,
 * so an unexpected extra request fails the test that made it.
 */
export function recordingFetch(replies: Reply[], onExhausted?: () => Reply) {
  const calls: RecordedCall[] = []
  const queue = [...replies]
  const fetch = async (url: URL, init: XeroGetInit): Promise<Response> => {
    calls.push({ url, init })
    const next = queue.shift() ?? onExhausted?.()
    if (next === undefined) {
      throw new Error(`unexpected request ${calls.length}: ${url.pathname}`)
    }
    const reply = typeof next === 'string' ? { status: 200, body: next } : next
    return new Response(reply.body ?? '', {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    })
  }
  return { fetch, calls }
}

/** A client wired to a recording fetch, with sentinel credentials. */
export function clientWith(replies: Reply[], onExhausted?: () => Reply) {
  const recorder = recordingFetch(replies, onExhausted)
  const client: XeroClient = createXeroClient({
    getAccessToken: async () => SENTINEL_TOKEN,
    tenantId: SENTINEL_TENANT,
    fetch: recorder.fetch,
  })
  return { client, calls: recorder.calls }
}

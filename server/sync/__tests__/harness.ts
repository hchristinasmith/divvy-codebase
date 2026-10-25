// Test helper, not a test: what the sync-run tests (#21) share.
//
// - `fakeAkahu()` is the real Akahu client over a fake fetch that serves the
//   recorded fixtures as raw text by pathname (docs/testing.md, Fixtures),
//   so every test runs the client's own parsing and cents conversion. A
//   route can be replaced per test; nothing reaches the network.
// - `freshDb()` empties and re-migrates the in-memory test database.
// - `snapshot()` reads every table sync could touch, in a stable order, with
//   pending rows compared without their ephemeral `id`.
//
// The database is the app's own connection, which under vitest is the
// `:memory:` `test` config. The in-memory guard is a copy of
// `assertInMemory` in `server/test-utils/app.ts`: that module imports the
// Express app, whose `dotenv/config` import would read `.env`.
import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Knex } from 'knex'

import connection from '../../db/connection.ts'
import { createAkahuClient } from '../akahu-client.ts'
import type { AkahuClient, AkahuFetch, AkahuGetInit } from '../akahu-client.ts'

export const db: Knex = connection

const fixturesDir = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
)

/** A recorded Akahu response, as text. */
export function fixture(name: string): string {
  return readFileSync(Path.join(fixturesDir, name), 'utf8')
}

/** Values no error message or log line may contain. */
export const SENTINEL_TOKEN = 'sentinel-akahu-user-token-9d41e7'
export const SENTINEL_APP_ID = 'sentinel-akahu-app-id-c2f80b'

/** The fixed clock the tests run at, and a few instants around it. */
export const NOW = new Date('2026-10-25T00:00:00.000Z')
export const MINUTE_MS = 60 * 1000
export const DAY_MS = 24 * 60 * MINUTE_MS

export function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs)
}

/** `text` with `from` replaced by `to`; throws unless `from` occurs once. */
export function replaceOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from)
  if (first === -1 || text.indexOf(from, first + 1) !== -1) {
    throw new Error(`expected exactly one ${JSON.stringify(from)} in fixture`)
  }
  return text.slice(0, first) + to + text.slice(first + from.length)
}

/** Akahu's envelope around raw item text, as the last page. */
export function page(items: string[]): string {
  return `{"success":true,"items":[${items.join(',')}],"cursor":{"next":null}}`
}

/** The transactions fixture with `item` (raw JSON text) added first. */
export function withSettledItem(text: string, item: string): string {
  return replaceOnce(text, '"items": [', `"items": [${item},`)
}

/** A response, a network failure, or a value computed per request. */
export type Reply = string | { status: number; body?: string; headers?: Record<string, string> } | Error
export type Route = Reply | ((url: URL, init: AkahuGetInit) => Reply | Promise<Reply>)

export interface Routes {
  accounts?: Route
  transactions?: Route
  pending?: Route
}

const PATHS = {
  '/v1/accounts': 'accounts',
  '/v1/transactions': 'transactions',
  '/v1/transactions/pending': 'pending',
} as const

/**
 * The default routes: the fixtures. The transactions fixture names a
 * second page; that page is served as an empty last page.
 */
function defaultRoute(name: keyof Routes): Route {
  if (name === 'accounts') return fixture('akahu-accounts.json')
  if (name === 'pending') return fixture('akahu-pending.json')
  return (url) =>
    url.searchParams.has('cursor')
      ? page([])
      : fixture('akahu-transactions.json')
}

export interface FakeAkahu {
  client: AkahuClient
  /** Every request URL, in order. */
  calls: URL[]
}

/** The real client, answering from `routes` (fixtures by default). */
export function fakeAkahu(
  routes: Routes = {},
  credentials = { token: SENTINEL_TOKEN, appId: SENTINEL_APP_ID },
): FakeAkahu {
  const calls: URL[] = []
  const fetch: AkahuFetch = async (url, init) => {
    calls.push(url)
    const name: keyof Routes | undefined =
      PATHS[url.pathname as keyof typeof PATHS]
    if (name === undefined) throw new Error(`unexpected path ${url.pathname}`)
    const route = routes[name] ?? defaultRoute(name)
    const reply = typeof route === 'function' ? await route(url, init) : route
    if (reply instanceof Error) throw reply
    const { status, body, headers } =
      typeof reply === 'string' ? { status: 200, body: reply, headers: {} } : reply
    return new Response(body ?? '', {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  }
  return {
    client: createAkahuClient({ ...credentials, fetch }),
    calls,
  }
}

/** The `start`/`end` of every settled listing request, as ISO text. */
export function settledWindows(calls: URL[]): { start: string | null; end: string | null }[] {
  return calls
    .filter((url) => url.pathname === '/v1/transactions')
    .map((url) => ({
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
    }))
}

function assertInMemory(target: Knex): void {
  const config = target.client.config as Knex.Config
  const conn = config.connection
  const filename =
    conn && typeof conn === 'object' && 'filename' in conn
      ? conn.filename
      : undefined
  if (filename !== ':memory:') {
    throw new Error('Refusing to run sync tests against a database on disk')
  }
}

/**
 * An empty, fully migrated in-memory database. Triggers a test created are
 * dropped first: no migration owns them, so a rollback would not, and one
 * naming a column a migration drops makes that rollback fail.
 */
export async function freshDb(): Promise<Knex> {
  assertInMemory(db)
  const triggers: { name: string }[] = await db('sqlite_master')
    .where({ type: 'trigger' })
    .select('name')
  for (const { name } of triggers) {
    await db.raw('DROP TRIGGER ??', [name])
  }
  await db.migrate.rollback(undefined, true)
  await db.migrate.latest()
  return db
}

export async function closeDb(): Promise<void> {
  await db.destroy()
}

export type Row = Record<string, unknown>

export interface Snapshot {
  accounts: Row[]
  settled: Row[]
  /** Pending rows without `id`, sorted by content. */
  pending: Row[]
  corrections: Row[]
}

function withoutId(row: Row): Row {
  const rest = { ...row }
  delete rest.id
  return rest
}

/** Every row sync may touch, `sync_runs` aside. */
export async function snapshot(): Promise<Snapshot> {
  const pending: Row[] = await db('transactions')
    .where({ status: 'pending' })
    .select()
  return {
    accounts: await db('accounts').orderBy('id').select(),
    settled: await db('transactions')
      .whereNot({ status: 'pending' })
      .orderBy('id')
      .select(),
    pending: pending
      .map(withoutId)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    corrections: await db('category_corrections').orderBy('id').select(),
  }
}

export function syncRuns(): Promise<Row[]> {
  return db('sync_runs').orderBy('id').select()
}

/** A promise with its resolve exposed. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve
  })
  return { promise, resolve }
}

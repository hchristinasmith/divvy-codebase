// Test helpers for the Xero token vault (prd-05 #28).
//
// No key, token or tenant here is real or fixed: every key is 32 random bytes
// drawn per test, and every token and tenant is a labelled random string, so
// nothing a test writes could authenticate anywhere and no committed file
// holds a value that looks like one. Nothing here calls Xero or the network.

import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import knex, { Knex } from 'knex'
import { vi } from 'vitest'

import config from '../../../db/knexfile.js'
import type { XeroConnectionInput, XeroTokenGrant } from '../types.ts'

/** Sets XERO_TOKEN_KEY to a fresh random key and returns it. */
export function stubKey(): string {
  const key = randomBytes(32).toString('base64')
  vi.stubEnv('XERO_TOKEN_KEY', key)
  return key
}

/**
 * A random stand-in for a token or tenant id, labelled for readable failures.
 * Long enough that `Buffer.from(value)` passes the `_enc` length CHECK, so a
 * plaintext written by mistake is stored and caught, not refused.
 */
export function sentinel(label: string): string {
  return `${label}-${randomBytes(16).toString('hex')}`
}

/** A fresh in-memory database with every migration applied. */
export async function openDb(): Promise<Knex> {
  const db = knex(config.test)
  await db.migrate.latest()
  return db
}

export type Row = Record<string, unknown>

/** The connection row exactly as SQLite holds it, or undefined. */
export async function rawRow(db: Knex): Promise<Row | undefined> {
  return db('xero_connection').where({ id: 1 }).first()
}

export async function mustRawRow(db: Knex): Promise<Row> {
  const row = await rawRow(db)
  if (row === undefined) throw new Error('no xero_connection row')
  return row
}

/** Counts every INSERT, UPDATE and DELETE the database runs from now on. */
export function countWrites(db: Knex): { readonly count: number } {
  const counter = { count: 0 }
  db.on('query', (query: { sql: string }) => {
    if (/^\s*(insert|update|delete)\b/i.test(query.sql)) counter.count += 1
  })
  return counter
}

/**
 * Every cell of every table in the database, each rendered every way a
 * reader might look at it: text as itself, a blob as UTF-8, Latin-1, hex
 * and base64.
 */
export async function dumpAllTables(db: Knex): Promise<string[]> {
  const tables: { name: string }[] = await db('sqlite_master')
    .where({ type: 'table' })
    .select('name')
  const cells: string[] = []
  for (const { name } of tables) {
    const rows: Row[] = await db(name).select()
    for (const row of rows) {
      for (const value of Object.values(row)) cells.push(...renderings(value))
    }
  }
  return cells
}

function renderings(value: unknown): string[] {
  if (Buffer.isBuffer(value)) {
    return [
      value.toString('utf8'),
      value.toString('latin1'),
      value.toString('hex'),
      value.toString('base64'),
    ]
  }
  return [String(value)]
}

/**
 * The secrets found in any of `haystacks`, each looked for as itself and as
 * its own hex and base64, so a value stored encoded but unencrypted is
 * caught too.
 */
export function leaked(haystacks: string[], secrets: string[]): string[] {
  return secrets.filter((secret) => {
    const bytes = Buffer.from(secret, 'utf8')
    const needles = [secret, bytes.toString('hex'), bytes.toString('base64')]
    return haystacks.some((text) => needles.some((needle) => text.includes(needle)))
  })
}

/** Every text an error exposes: message, stack, own properties, inspection. */
export function errorTexts(err: unknown): string[] {
  const texts = [inspect(err, { depth: 5 })]
  if (err instanceof Error) {
    texts.push(err.message, err.stack ?? '')
    for (const key of Object.getOwnPropertyNames(err)) {
      texts.push(inspect((err as unknown as Record<string, unknown>)[key], { depth: 5 }))
    }
  } else {
    texts.push(String(err))
  }
  return texts
}

/** The settled rejection of `promise`; fails the test if it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection, but the promise resolved')
}

/** A consent with random tokens and tenant. */
export function connectionInput(
  overrides: Partial<XeroConnectionInput> = {},
): XeroConnectionInput {
  return {
    accessToken: sentinel('access'),
    refreshToken: sentinel('refresh'),
    tenantId: sentinel('tenant'),
    expiresInSeconds: 1800,
    scopes: ['offline_access', 'accounting.invoices.read'],
    ...overrides,
  }
}

/**
 * A stand-in for Xero's token endpoint and API. It knows which access tokens
 * and refresh tokens are live. A refresh issues a new random pair and, when
 * `grace` is off, retires the refresh token it was given, so replaying an old
 * one fails as Xero's rotation would. Whether Xero honours a replay, and for
 * how long, is unmeasured (spike #40); tests run both ways.
 */
export class FakeXero {
  readonly exchangeCalls: string[] = []
  private readonly liveAccess = new Set<string>()
  private readonly liveRefresh = new Set<string>()

  constructor(
    private readonly options: { grace: boolean; expiresInSeconds?: number } = {
      grace: false,
    },
  ) {}

  /** Records a consent's pair as live, as Xero would after sign-in. */
  consent(input: XeroConnectionInput): XeroConnectionInput {
    this.liveAccess.add(input.accessToken)
    this.liveRefresh.add(input.refreshToken)
    return input
  }

  readonly exchange = async (refreshToken: string): Promise<XeroTokenGrant> => {
    this.exchangeCalls.push(refreshToken)
    if (!this.liveRefresh.has(refreshToken)) throw new Error('invalid_grant')
    if (!this.options.grace) this.liveRefresh.delete(refreshToken)
    const grant = {
      accessToken: sentinel('access'),
      refreshToken: sentinel('refresh'),
      expiresInSeconds: this.options.expiresInSeconds ?? 1800,
    }
    this.liveAccess.add(grant.accessToken)
    this.liveRefresh.add(grant.refreshToken)
    return grant
  }

  /** One API call: authenticates or throws, as Xero's 401 would. */
  apiCall(accessToken: string): 'ok' {
    if (!this.liveAccess.has(accessToken)) throw new Error('401 from the fake')
    return 'ok'
  }
}

/** A promise and the functions that settle it, for gating an exchange. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

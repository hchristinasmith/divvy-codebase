// Reads and writes of `xero_connection` for the Xero token vault (prd-05
// Rulings 2 and 3). This is the only file in the vault that runs SQL.
//
// The table is one row (`id = 1`). Following the #25 schema: every `_enc`
// column is written as a raw Buffer from crypto.ts, never text; every instant
// is `Date#toISOString()` text; and every write here moves `version` on by
// one, so a refresher that read the row earlier can tell it changed:
// - `storeConnection` (a new consent) rewrites every column in one
//   transaction: an UPDATE of the existing row, or an INSERT when there is
//   none (version starts at 0).
// - `commitRefresh` writes the new access and refresh tokens and their
//   expiry in one UPDATE guarded by `WHERE version = ?`. One statement is one
//   transaction in SQLite: both tokens move or neither does (Ruling 3), and
//   the old refresh token stays stored until the new one is.
// - `markNeedsReconnect` flips a connected row at the version the failed
//   refresher read, and nothing else: the old ciphertext stays.
// - `disconnect` nulls the tokens, the tenant, the expiry and the scopes in
//   one UPDATE, whatever the version.
//
// Every call goes through `guardDb`: a database failure (a CHECK, a trigger,
// a locked or missing table) surfaces as `storage_failed` with a fixed
// message. Knex's own message holds the SQL with its bound values, which here
// are the ciphertext, so it is dropped, never wrapped or attached as a cause.

import type { Knex } from 'knex'

import { XeroVaultError } from './errors.ts'
import { encryptField } from './crypto.ts'
import type { XeroConnectionInput } from './types.ts'

const TABLE = 'xero_connection'
const ROW_ID = 1

export type ConnectionStatus = 'connected' | 'needs_reconnect' | 'disconnected'

/** `xero_connection` as SQLite returns it. */
export interface ConnectionRow {
  id: number
  access_token_enc: Buffer | null
  refresh_token_enc: Buffer | null
  tenant_id_enc: Buffer | null
  expires_at: string | null
  version: number
  status: ConnectionStatus
  scopes: string | null
  connected_at: string | null
  last_refresh_at: string | null
}

const COLUMNS: (keyof ConnectionRow)[] = [
  'id',
  'access_token_enc',
  'refresh_token_enc',
  'tenant_id_enc',
  'expires_at',
  'version',
  'status',
  'scopes',
  'connected_at',
  'last_refresh_at',
]

/** The ciphertext of a refreshed pair, ready to commit. */
export interface EncryptedPair {
  accessTokenEnc: Buffer
  refreshTokenEnc: Buffer
}

async function guardDb<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof XeroVaultError) throw err
    throw new XeroVaultError(
      'storage_failed',
      'the Xero connection could not be read or written',
    )
  }
}

function bumpVersion(db: Knex): Knex.Raw {
  return db.raw('?? + 1', ['version'])
}

/** True for a string with at least one character. */
export function isToken(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * `toISOString()` text with a four-digit year. Past the year 9999 it writes
 * an extended year (`+010000-…`), which the `expires_at` CHECK refuses.
 */
const PLAIN_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * The instant `expiresInSeconds` after `fromMs`, as `toISOString()` text, or
 * null when `expiresInSeconds` is not a positive whole number of seconds or
 * the instant is not one `expires_at` can hold (no date at all, or a year
 * past 9999). A null here is refused before anything is written, so an
 * absurd expiry is a bad grant or bad input, never a failed write.
 */
export function expiryAfter(fromMs: number, expiresInSeconds: unknown): string | null {
  if (
    typeof expiresInSeconds !== 'number' ||
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    return null
  }
  const expiry = new Date(fromMs + expiresInSeconds * 1000)
  if (Number.isNaN(expiry.getTime())) return null
  const text = expiry.toISOString()
  return PLAIN_INSTANT.test(text) ? text : null
}

function invalid(message: string): XeroVaultError {
  return new XeroVaultError('invalid_input', message)
}

/** The scopes as one space-separated string, or an error naming the rule. */
function scopeText(scopes: unknown): string {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw invalid('the scopes to store must be a non-empty list')
  }
  for (const scope of scopes) {
    if (!isToken(scope) || /\s/.test(scope)) {
      throw invalid('each scope to store must be one word with no whitespace')
    }
  }
  return scopes.join(' ')
}

/** The stored connection, or null when there has never been one. */
export async function readConnection(db: Knex): Promise<ConnectionRow | null> {
  return guardDb(async () => {
    const row: ConnectionRow | undefined = await db<ConnectionRow>(TABLE)
      .where({ id: ROW_ID })
      .first(COLUMNS)
    return row ?? null
  })
}

/**
 * Stores a new consent as the one connection, `connected`, replacing
 * whatever was there. Validates everything before encrypting, and encrypts
 * everything before writing, so a refusal writes nothing.
 */
export async function storeConnection(
  db: Knex,
  input: XeroConnectionInput,
  nowMs: number,
): Promise<void> {
  if (!isToken(input.accessToken)) {
    throw invalid('the access token to store must be a non-empty string')
  }
  if (!isToken(input.refreshToken)) {
    throw invalid('the refresh token to store must be a non-empty string')
  }
  if (!isToken(input.tenantId)) {
    throw invalid('the tenant id to store must be a non-empty string')
  }
  const expiresAt = expiryAfter(nowMs, input.expiresInSeconds)
  if (expiresAt === null) {
    throw invalid(
      'the expiry to store must be a positive whole number of seconds ending before the year 10000',
    )
  }
  const scopes = scopeText(input.scopes)
  const connectedAt = new Date(nowMs).toISOString()

  const columns = {
    access_token_enc: encryptField(input.accessToken, 'access_token'),
    refresh_token_enc: encryptField(input.refreshToken, 'refresh_token'),
    tenant_id_enc: encryptField(input.tenantId, 'tenant_id'),
    expires_at: expiresAt,
    scopes,
    status: 'connected' as const,
    connected_at: connectedAt,
    last_refresh_at: null,
  }

  await guardDb(() =>
    db.transaction(async (trx) => {
      const changed = await trx(TABLE)
        .where({ id: ROW_ID })
        .update({ ...columns, version: bumpVersion(trx) })
      if (changed === 0) await trx(TABLE).insert({ id: ROW_ID, ...columns })
    }),
  )
}

/**
 * Writes a refreshed pair if, and only if, the row is still at `readVersion`.
 * True when it was written; false when another write got there first.
 */
export async function commitRefresh(
  db: Knex,
  readVersion: number,
  pair: EncryptedPair,
  expiresAtIso: string,
  refreshedAtIso: string,
): Promise<boolean> {
  return guardDb(async () => {
    const changed = await db(TABLE)
      .where({ id: ROW_ID, version: readVersion })
      .update({
        access_token_enc: pair.accessTokenEnc,
        refresh_token_enc: pair.refreshTokenEnc,
        expires_at: expiresAtIso,
        last_refresh_at: refreshedAtIso,
        version: bumpVersion(db),
      })
    return changed === 1
  })
}

/**
 * Marks a failed refresh (Ruling 3) if the row is still connected at
 * `readVersion`, leaving the stored tokens as they were. True when it was
 * marked; false when another write changed the row first.
 */
export async function markNeedsReconnect(db: Knex, readVersion: number): Promise<boolean> {
  return guardDb(async () => {
    const changed = await db(TABLE)
      .where({ id: ROW_ID, version: readVersion, status: 'connected' })
      .update({ status: 'needs_reconnect', version: bumpVersion(db) })
    return changed === 1
  })
}

/** Forgets the tokens, the tenant, the expiry and the scopes. */
export async function disconnect(db: Knex): Promise<void> {
  await guardDb(() =>
    db(TABLE)
      .where({ id: ROW_ID })
      .update({
        access_token_enc: null,
        refresh_token_enc: null,
        tenant_id_enc: null,
        expires_at: null,
        scopes: null,
        status: 'disconnected',
        version: bumpVersion(db),
      }),
  )
}

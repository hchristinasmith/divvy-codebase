// prd-05 Rulings 2 and 3 (#28 Done-when 3): what the vault writes to
// `xero_connection`, and that no table in the database holds a token or the
// tenant in the clear afterwards. The #25 handoff is binding here: `_enc`
// columns take a raw Buffer, instants are `Date#toISOString()` text, the row
// is `id = 1`, and every write moves `version`. Every key, token and tenant
// is random per test; nothing calls Xero.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Knex } from 'knex'

import { decryptField, encryptField } from '../crypto.ts'
import { XeroVaultError } from '../errors.ts'
import {
  commitRefresh,
  disconnect,
  markNeedsReconnect,
  readConnection,
  storeConnection,
} from '../store.ts'
import type { XeroConnectionInput } from '../types.ts'
import {
  connectionInput,
  dumpAllTables,
  errorTexts,
  leaked,
  mustRawRow,
  openDb,
  rawRow,
  rejectionOf,
  sentinel,
  stubKey,
} from './helpers.ts'

const NOW = Date.parse('2026-10-26T01:02:03.456Z')

const ROW_KEYS = [
  'access_token_enc',
  'connected_at',
  'expires_at',
  'id',
  'last_refresh_at',
  'refresh_token_enc',
  'scopes',
  'status',
  'tenant_id_enc',
  'version',
]

let db: Knex
beforeEach(async () => {
  stubKey()
  db = await openDb()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await db.destroy()
})

function expectVaultError(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(XeroVaultError)
  expect((err as XeroVaultError).code).toBe(code)
}

describe('storeConnection', () => {
  it('writes one connected row of ciphertext, version 0, ISO instants', async () => {
    const input = connectionInput()
    await storeConnection(db, input, NOW)

    const row = await mustRawRow(db)
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS)
    expect(row).toMatchObject({
      id: 1,
      status: 'connected',
      version: 0,
      scopes: 'offline_access accounting.invoices.read',
      expires_at: new Date(NOW + 1800 * 1000).toISOString(),
      connected_at: new Date(NOW).toISOString(),
      last_refresh_at: null,
    })
    for (const column of ['access_token_enc', 'refresh_token_enc', 'tenant_id_enc']) {
      expect(Buffer.isBuffer(row[column]), column).toBe(true)
      expect((row[column] as Buffer).length, column).toBeGreaterThanOrEqual(29)
    }
    expect(decryptField(row.access_token_enc, 'access_token')).toBe(input.accessToken)
    expect(decryptField(row.refresh_token_enc, 'refresh_token')).toBe(input.refreshToken)
    expect(decryptField(row.tenant_id_enc, 'tenant_id')).toBe(input.tenantId)
  })

  it('replaces an existing connection, bumping the version and clearing last_refresh_at', async () => {
    await storeConnection(db, connectionInput(), NOW)
    await commitRefresh(
      db,
      0,
      {
        accessTokenEnc: encryptField(sentinel('access'), 'access_token'),
        refreshTokenEnc: encryptField(sentinel('refresh'), 'refresh_token'),
      },
      new Date(NOW + 5000).toISOString(),
      new Date(NOW + 1000).toISOString(),
    )
    expect((await mustRawRow(db)).last_refresh_at).not.toBeNull()

    const second = connectionInput({ scopes: ['offline_access'] })
    await storeConnection(db, second, NOW + 60_000)

    const rows = await db('xero_connection').select()
    expect(rows).toHaveLength(1)
    const row = rows[0] as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS)
    expect(row).toMatchObject({
      version: 2,
      status: 'connected',
      scopes: 'offline_access',
      connected_at: new Date(NOW + 60_000).toISOString(),
      last_refresh_at: null,
    })
    expect(decryptField(row.access_token_enc, 'access_token')).toBe(second.accessToken)
    expect(decryptField(row.refresh_token_enc, 'refresh_token')).toBe(second.refreshToken)
    expect(decryptField(row.tenant_id_enc, 'tenant_id')).toBe(second.tenantId)
  })

  it('reconnects a disconnected or needs_reconnect row', async () => {
    await storeConnection(db, connectionInput(), NOW)
    await disconnect(db)
    await storeConnection(db, connectionInput(), NOW)
    expect(await mustRawRow(db)).toMatchObject({ status: 'connected', version: 2 })

    expect(await markNeedsReconnect(db, 2)).toBe(true)
    await storeConnection(db, connectionInput(), NOW)
    expect(await mustRawRow(db)).toMatchObject({ status: 'connected', version: 4 })
  })

  const invalid: [string, Partial<XeroConnectionInput> | Record<string, unknown>][] = [
    ['an empty access token', { accessToken: '' }],
    ['an empty refresh token', { refreshToken: '' }],
    ['an empty tenant', { tenantId: '' }],
    ['a refresh token that is not a string', { refreshToken: 12345 }],
    ['a zero expiry', { expiresInSeconds: 0 }],
    ['a negative expiry', { expiresInSeconds: -1 }],
    ['a fractional expiry', { expiresInSeconds: 1.5 }],
    ['a NaN expiry', { expiresInSeconds: Number.NaN }],
    ['an infinite expiry', { expiresInSeconds: Number.POSITIVE_INFINITY }],
    ['an expiry given as text', { expiresInSeconds: '1800' }],
    ['an expiry past the last representable date', { expiresInSeconds: 2 ** 52 }],
    // A date, but past the year 9999: `toISOString()` writes it with an
    // extended year (`+033715-…`), which the `expires_at` CHECK refuses.
    ['an expiry past the year 9999', { expiresInSeconds: 1e12 }],
    ['no scopes', { scopes: [] }],
    ['scopes that are not a list', { scopes: 'offline_access' }],
    ['an empty scope', { scopes: ['offline_access', ''] }],
    ['a scope with a space', { scopes: ['offline_access accounting.invoices.read'] }],
    ['a scope with a tab', { scopes: ['offline_access\taccounting'] }],
    ['a scope with a no-break space', { scopes: ['offline_access\u00A0accounting'] }],
    ['a scope that is not a string', { scopes: [7] }],
  ]

  for (const [label, overrides] of invalid) {
    it(`refuses ${label} as invalid_input and writes nothing`, async () => {
      const input = { ...connectionInput(), ...overrides } as XeroConnectionInput
      expectVaultError(await rejectionOf(storeConnection(db, input, NOW)), 'invalid_input')
      expect(await rawRow(db)).toBeUndefined()

      const kept = connectionInput()
      await storeConnection(db, kept, NOW)
      const before = await mustRawRow(db)
      expectVaultError(await rejectionOf(storeConnection(db, input, NOW)), 'invalid_input')
      expect(await mustRawRow(db)).toEqual(before)
    })
  }

  it('stores an expiry in the last second of the year 9999 and refuses one a second later', async () => {
    const lastSeconds = Math.floor((Date.parse('9999-12-31T23:59:59.999Z') - NOW) / 1000)
    await storeConnection(db, connectionInput({ expiresInSeconds: lastSeconds }), NOW)
    const row = await mustRawRow(db)
    expect(row.expires_at).toBe(new Date(NOW + lastSeconds * 1000).toISOString())
    expect(row.expires_at).toMatch(/^9999-12-31T23:59:59\.\d{3}Z$/)

    const later = connectionInput({ expiresInSeconds: lastSeconds + 1 })
    expectVaultError(await rejectionOf(storeConnection(db, later, NOW)), 'invalid_input')
    expect(await mustRawRow(db)).toEqual(row)
  })

  it('refuses to store without a key, writing nothing', async () => {
    vi.stubEnv('XERO_TOKEN_KEY', '')
    expectVaultError(
      await rejectionOf(storeConnection(db, connectionInput(), NOW)),
      'key_missing',
    )
    expect(await rawRow(db)).toBeUndefined()
  })
})

describe('no plaintext in the database (Done-when 3)', () => {
  it('leaves no token or tenant in any cell of any table after a store', async () => {
    const input = connectionInput()
    await storeConnection(db, input, NOW)
    const secrets = [input.accessToken, input.refreshToken, input.tenantId]

    expect(leaked(await dumpAllTables(db), secrets)).toEqual([])
  })

  it('leaves no token in any table after a refresh commit or a disconnect', async () => {
    await storeConnection(db, connectionInput(), NOW)
    const access = sentinel('access')
    const refresh = sentinel('refresh')
    await commitRefresh(
      db,
      0,
      {
        accessTokenEnc: encryptField(access, 'access_token'),
        refreshTokenEnc: encryptField(refresh, 'refresh_token'),
      },
      new Date(NOW + 5000).toISOString(),
      new Date(NOW).toISOString(),
    )
    expect(leaked(await dumpAllTables(db), [access, refresh])).toEqual([])
    await disconnect(db)
    expect(leaked(await dumpAllTables(db), [access, refresh])).toEqual([])
  })

  it('positive control: the same dump finds a token stored as plain bytes or text', async () => {
    const input = connectionInput()
    await storeConnection(db, input, NOW)
    // A plaintext Buffer passes the `_enc` CHECK, which is why this test
    // exists (#25 security note W1).
    await db('xero_connection')
      .where({ id: 1 })
      .update({ access_token_enc: Buffer.from(input.accessToken, 'utf8') })
    await db('xero_connection')
      .where({ id: 1 })
      .update({ scopes: Buffer.from(input.tenantId).toString('base64') })

    expect(leaked(await dumpAllTables(db), [input.accessToken, input.tenantId])).toEqual([
      input.accessToken,
      input.tenantId,
    ])
  })
})

describe('commitRefresh and markNeedsReconnect', () => {
  function newPair() {
    return {
      accessTokenEnc: encryptField(sentinel('access'), 'access_token'),
      refreshTokenEnc: encryptField(sentinel('refresh'), 'refresh_token'),
    }
  }

  it('commits only when the version still matches, and bumps it', async () => {
    await storeConnection(db, connectionInput(), NOW)
    const before = await mustRawRow(db)
    const pair = newPair()
    const expiresAt = new Date(NOW + 1800 * 1000).toISOString()
    const refreshedAt = new Date(NOW + 1).toISOString()

    expect(await commitRefresh(db, 1, pair, expiresAt, refreshedAt)).toBe(false)
    expect(await mustRawRow(db)).toEqual(before)

    expect(await commitRefresh(db, 0, pair, expiresAt, refreshedAt)).toBe(true)
    const after = await mustRawRow(db)
    expect(Object.keys(after).sort()).toEqual(ROW_KEYS)
    expect(after).toMatchObject({
      version: 1,
      status: 'connected',
      expires_at: expiresAt,
      last_refresh_at: refreshedAt,
      connected_at: before.connected_at,
      scopes: before.scopes,
    })
    expect((after.access_token_enc as Buffer).equals(pair.accessTokenEnc)).toBe(true)
    expect((after.refresh_token_enc as Buffer).equals(pair.refreshTokenEnc)).toBe(true)
    expect((after.tenant_id_enc as Buffer).equals(before.tenant_id_enc as Buffer)).toBe(true)

    expect(await commitRefresh(db, 0, newPair(), expiresAt, refreshedAt)).toBe(false)
    expect(await mustRawRow(db)).toEqual(after)
  })

  it('flags needs_reconnect only on a matching connected row, keeping the ciphertext', async () => {
    await storeConnection(db, connectionInput(), NOW)
    const before = await mustRawRow(db)

    expect(await markNeedsReconnect(db, 1)).toBe(false)
    expect(await mustRawRow(db)).toEqual(before)

    expect(await markNeedsReconnect(db, 0)).toBe(true)
    expect(await mustRawRow(db)).toEqual({ ...before, status: 'needs_reconnect', version: 1 })

    // Not connected any more: a second flag at the new version changes nothing.
    expect(await markNeedsReconnect(db, 1)).toBe(false)
    expect(await mustRawRow(db)).toMatchObject({ status: 'needs_reconnect', version: 1 })
  })

  it('does not flag a disconnected row, even at its own version', async () => {
    await storeConnection(db, connectionInput(), NOW)
    await disconnect(db)
    expect(await markNeedsReconnect(db, 1)).toBe(false)
    expect(await mustRawRow(db)).toMatchObject({ status: 'disconnected', version: 1 })
  })
})

describe('disconnect', () => {
  it('nulls every token, the tenant, expiry and scopes, and bumps the version', async () => {
    await storeConnection(db, connectionInput(), NOW)
    const before = await mustRawRow(db)
    await disconnect(db)

    const row = await mustRawRow(db)
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS)
    expect(row).toEqual({
      ...before,
      access_token_enc: null,
      refresh_token_enc: null,
      tenant_id_enc: null,
      expires_at: null,
      scopes: null,
      status: 'disconnected',
      version: 1,
    })
  })

  it('is a no-op when nothing is stored', async () => {
    await disconnect(db)
    expect(await rawRow(db)).toBeUndefined()
  })
})

describe('readConnection', () => {
  it('returns null when no row exists', async () => {
    expect(await readConnection(db)).toBeNull()
  })

  it('returns the stored row', async () => {
    await storeConnection(db, connectionInput(), NOW)
    const row = await readConnection(db)
    expect(row).not.toBeNull()
    expect(Object.keys(row ?? {}).sort()).toEqual(ROW_KEYS)
    expect(row).toEqual(await mustRawRow(db))
  })
})

describe('storage failures', () => {
  function expectScrubbed(err: unknown, secrets: string[]): void {
    expectVaultError(err, 'storage_failed')
    const error = err as Error
    expect('cause' in error).toBe(false)
    for (const text of [error.message, error.stack ?? '']) {
      expect(text).not.toMatch(/X'|xero_connection|insert|update|select|SQLITE/i)
    }
    expect(leaked(errorTexts(err), secrets)).toEqual([])
  }

  it('positive control: the raw Knex error carries the SQL and the bound blob', async () => {
    await db.raw(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON xero_connection BEGIN SELECT RAISE(ABORT, 'refused'); END",
    )
    const err = await rejectionOf(
      db('xero_connection').insert({ id: 1, status: 'needs_reconnect', access_token_enc: Buffer.alloc(40, 7) }),
    )
    expect((err as Error).message).toMatch(/insert into/)
    expect((err as Error).message).toContain("X'0707")
  })

  it('turns a refused insert into storage_failed with nothing of the SQL', async () => {
    await db.raw(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON xero_connection BEGIN SELECT RAISE(ABORT, 'refused'); END",
    )
    const input = connectionInput()
    const err = await rejectionOf(storeConnection(db, input, NOW))
    expectScrubbed(err, [input.accessToken, input.refreshToken, input.tenantId])
    expect(await rawRow(db)).toBeUndefined()
  })

  it('turns a refused update into storage_failed and leaves the row as it was', async () => {
    await storeConnection(db, connectionInput(), NOW)
    const before = await mustRawRow(db)
    await db.raw(
      "CREATE TRIGGER refuse_update BEFORE UPDATE ON xero_connection BEGIN SELECT RAISE(ABORT, 'refused'); END",
    )
    const input = connectionInput()
    expectScrubbed(await rejectionOf(storeConnection(db, input, NOW)), [
      input.accessToken,
      input.refreshToken,
      input.tenantId,
    ])
    const pair = {
      accessTokenEnc: encryptField(input.accessToken, 'access_token'),
      refreshTokenEnc: encryptField(input.refreshToken, 'refresh_token'),
    }
    const iso = new Date(NOW).toISOString()
    expectScrubbed(await rejectionOf(commitRefresh(db, 0, pair, iso, iso)), [input.accessToken])
    expectScrubbed(await rejectionOf(markNeedsReconnect(db, 0)), [])
    expectScrubbed(await rejectionOf(disconnect(db)), [])
    expect(await mustRawRow(db)).toEqual(before)
  })

  it('turns a missing table into storage_failed on every read and write', async () => {
    await db.schema.dropTable('xero_connection')
    const iso = new Date(NOW).toISOString()
    const pair = {
      accessTokenEnc: encryptField(sentinel('access'), 'access_token'),
      refreshTokenEnc: encryptField(sentinel('refresh'), 'refresh_token'),
    }
    for (const attempt of [
      () => readConnection(db),
      () => storeConnection(db, connectionInput(), NOW),
      () => commitRefresh(db, 0, pair, iso, iso),
      () => markNeedsReconnect(db, 0),
      () => disconnect(db),
    ]) {
      expectScrubbed(await rejectionOf(attempt()), [])
    }
  })
})

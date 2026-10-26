// prd-05 Ruling 3 (#28 Done-when 4 to 7): the refresh, through the vault's
// public surface. The new pair is stored before it is used, in one statement
// guarded by `version`; one refresher runs at a time; a failed exchange marks
// `needs_reconnect` and later calls fail fast without retrying.
//
// The crash tests simulate a crash at each step of a refresh by throwing
// there, then model the restart with a fresh `createXeroVault` on the same
// database: its single-flight state is closure state, so a new instance is a
// new process. An instance that crashed is never used again.
//
// `FakeXero` stands in for the token endpoint and the API. Whether Xero
// honours a refresh token it has already rotated, and for how long, is not
// yet measured (spike #40), so the crash-before-commit test runs both ways.
// Every key, token and tenant is random per test; nothing calls Xero.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Knex } from 'knex'

import { createXeroClient } from '../../client/index.ts'
import type { XeroGetInit } from '../../client/http.ts'
import { decryptField } from '../crypto.ts'
import { XeroVaultError, createXeroVault } from '../index.ts'
import type { XeroTokenExchange, XeroTokenGrant, XeroVault } from '../index.ts'
import {
  FakeXero,
  connectionInput,
  countWrites,
  deferred,
  dumpAllTables,
  errorTexts,
  leaked,
  mustRawRow,
  openDb,
  rejectionOf,
  sentinel,
  stubKey,
} from './helpers.ts'

const T0 = Date.parse('2026-10-26T00:00:00.000Z')
const LIFETIME_SECONDS = 1800

let db: Knex
let clock: number
const now = () => clock

beforeEach(async () => {
  stubKey()
  db = await openDb()
  clock = T0
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await db.destroy()
})

function vaultWith(exchange: XeroTokenExchange): XeroVault {
  return createXeroVault({ db, exchange, now })
}

/** Stores a consent Xero knows about, at the current clock. */
async function connect(xero: FakeXero, expiresInSeconds = LIFETIME_SECONDS) {
  const input = xero.consent(connectionInput({ expiresInSeconds }))
  await vaultWith(xero.exchange).storeConnection(input)
  return input
}

/** Moves the clock to the moment the stored access token expires. */
function expire(seconds = LIFETIME_SECONDS): void {
  clock += seconds * 1000
}

function expectVaultError(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(XeroVaultError)
  expect((err as XeroVaultError).code).toBe(code)
}

const ABORT_VERSION_BUMP =
  'CREATE TRIGGER crash_before_commit BEFORE UPDATE ON xero_connection ' +
  "WHEN new.version <> old.version BEGIN SELECT RAISE(ABORT, 'simulated crash'); END"

describe('a fresh token', () => {
  it('is returned without an exchange or a write while more than the skew remains', async () => {
    const xero = new FakeXero()
    const input = await connect(xero)
    const writes = countWrites(db)
    clock += (LIFETIME_SECONDS - 300) * 1000

    expect(await vaultWith(xero.exchange).getAccessToken()).toBe(input.accessToken)
    expect(xero.exchangeCalls).toEqual([])
    expect(writes.count).toBe(0)
  })

  it('is refreshed when it expires within the skew, not only once expired', async () => {
    const xero = new FakeXero()
    const input = await connect(xero)
    clock += (LIFETIME_SECONDS - 30) * 1000

    const token = await vaultWith(xero.exchange).getAccessToken()
    expect(xero.exchangeCalls).toEqual([input.refreshToken])
    expect(token).not.toBe(input.accessToken)
  })
})

describe('a refresh', () => {
  it('exchanges the stored refresh token once and commits the new pair before returning it', async () => {
    const xero = new FakeXero()
    const input = await connect(xero)
    const before = await mustRawRow(db)
    expire()
    const requestedAt = clock

    let grant: XeroTokenGrant | undefined
    let rowDuringExchange: Record<string, unknown> | undefined
    const exchange: XeroTokenExchange = async (refreshToken) => {
      rowDuringExchange = await mustRawRow(db)
      clock += 5000 // Xero takes five seconds to answer
      grant = await xero.exchange(refreshToken)
      return grant
    }

    const token = await vaultWith(exchange).getAccessToken()
    if (grant === undefined) throw new Error('the exchange was never called')
    expect(xero.exchangeCalls).toEqual([input.refreshToken])
    expect(token).toBe(grant.accessToken)

    // Nothing was written before the exchange returned.
    expect(rowDuringExchange).toEqual(before)

    const after = await mustRawRow(db)
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expect(after).toMatchObject({
      status: 'connected',
      version: (before.version as number) + 1,
      expires_at: new Date(requestedAt + grant.expiresInSeconds * 1000).toISOString(),
      last_refresh_at: new Date(requestedAt + 5000).toISOString(),
      connected_at: before.connected_at,
      scopes: before.scopes,
    })
    expect(decryptField(after.access_token_enc, 'access_token')).toBe(grant.accessToken)
    expect(decryptField(after.refresh_token_enc, 'refresh_token')).toBe(grant.refreshToken)
    expect((after.tenant_id_enc as Buffer).equals(before.tenant_id_enc as Buffer)).toBe(true)

    expect(
      leaked(await dumpAllTables(db), [
        input.accessToken,
        input.refreshToken,
        input.tenantId,
        grant.accessToken,
        grant.refreshToken,
      ]),
    ).toEqual([])
  })

  it('uses the committed pair afterwards, and the next refresh sends the new refresh token', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const vault = vaultWith(xero.exchange)
    expire()
    const first = await vault.getAccessToken()
    expect(await vault.getAccessToken()).toBe(first)
    expect(xero.exchangeCalls).toHaveLength(1)

    expire()
    const second = await vault.getAccessToken()
    expect(xero.exchangeCalls).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(xero.apiCall(second)).toBe('ok')
  })

  it('leaves the tenant as stored', async () => {
    const xero = new FakeXero()
    const input = await connect(xero)
    const vault = vaultWith(xero.exchange)
    expect(await vault.getTenantId()).toBe(input.tenantId)
    expire()
    await vault.getAccessToken()
    expect(await vault.getTenantId()).toBe(input.tenantId)
  })
})

describe('crash tests (Done-when 4)', () => {
  it('(a) before the exchange: nothing is written and the restart authenticates', async () => {
    const xero = new FakeXero()
    const input = await connect(xero)
    const before = await mustRawRow(db)
    const key = process.env.XERO_TOKEN_KEY ?? ''
    expire()

    // The key is unreadable, so the refresh token cannot be decrypted.
    vi.stubEnv('XERO_TOKEN_KEY', '')
    const crashed = vaultWith(xero.exchange)
    expectVaultError(await rejectionOf(crashed.getAccessToken()), 'key_missing')
    expect(xero.exchangeCalls).toEqual([])
    expect(await mustRawRow(db)).toEqual(before)

    vi.stubEnv('XERO_TOKEN_KEY', key)
    const restarted = vaultWith(xero.exchange)
    const token = await restarted.getAccessToken()
    expect(xero.exchangeCalls).toEqual([input.refreshToken])
    expect(xero.apiCall(token)).toBe('ok')
  })

  it('(b) after the exchange, before the commit: the old pair stays and a restart replays it', async () => {
    const xero = new FakeXero({ grace: true })
    const input = await connect(xero)
    const before = await mustRawRow(db)
    expire()

    await db.raw(ABORT_VERSION_BUMP)
    const crashed = vaultWith(xero.exchange)
    expectVaultError(await rejectionOf(crashed.getAccessToken()), 'storage_failed')
    expect(xero.exchangeCalls).toEqual([input.refreshToken])
    expect(await mustRawRow(db)).toEqual(before)

    await db.raw('DROP TRIGGER crash_before_commit')
    const restarted = vaultWith(xero.exchange)
    const token = await restarted.getAccessToken()
    // The restart sends the same, old refresh token: the new pair from the
    // crashed refresh was never stored.
    expect(xero.exchangeCalls).toEqual([input.refreshToken, input.refreshToken])
    expect(xero.apiCall(token)).toBe('ok')
    expect(await mustRawRow(db)).toMatchObject({
      status: 'connected',
      version: (before.version as number) + 1,
    })
  })

  it('(b) without a grace period: the replay is refused loudly and the old ciphertext stays', async () => {
    const xero = new FakeXero({ grace: false })
    await connect(xero)
    const before = await mustRawRow(db)
    expire()

    await db.raw(ABORT_VERSION_BUMP)
    expectVaultError(
      await rejectionOf(vaultWith(xero.exchange).getAccessToken()),
      'storage_failed',
    )
    await db.raw('DROP TRIGGER crash_before_commit')

    const restarted = vaultWith(xero.exchange)
    expectVaultError(await rejectionOf(restarted.getAccessToken()), 'needs_reconnect')
    expect(await mustRawRow(db)).toEqual({
      ...before,
      status: 'needs_reconnect',
      version: (before.version as number) + 1,
    })
  })

  it('(c) after the commit, before the first API call: the restart has the new token', async () => {
    const xero = new FakeXero()
    await connect(xero)
    expire()

    const crashed = vaultWith(xero.exchange)
    const committed = await crashed.getAccessToken()
    // Crash here: the token is never used.

    const restarted = vaultWith(xero.exchange)
    const token = await restarted.getAccessToken()
    expect(token).toBe(committed)
    expect(xero.exchangeCalls).toHaveLength(1)
    expect(xero.apiCall(token)).toBe('ok')

    // The stored refresh token is the live one Xero issued.
    expire()
    expect(xero.apiCall(await restarted.getAccessToken())).toBe('ok')
    expect(xero.exchangeCalls).toHaveLength(2)
  })

  it('(d) between two API calls: the restart authenticates the second call', async () => {
    const xero = new FakeXero()
    await connect(xero)
    expire()

    const crashed = vaultWith(xero.exchange)
    expect(xero.apiCall(await crashed.getAccessToken())).toBe('ok')
    // Crash here, between the calls.

    const restarted = vaultWith(xero.exchange)
    expect(xero.apiCall(await restarted.getAccessToken())).toBe('ok')
    expect(xero.exchangeCalls).toHaveLength(1)

    expire()
    expect(xero.apiCall(await restarted.getAccessToken())).toBe('ok')
    expect(xero.exchangeCalls).toHaveLength(2)
  })
})

describe('one refresher (Done-when 5)', () => {
  function gatedExchange(inner: XeroTokenExchange) {
    const gate = deferred<void>()
    const calls: string[] = []
    const exchange: XeroTokenExchange = async (refreshToken) => {
      calls.push(refreshToken)
      await gate.promise
      return inner(refreshToken)
    }
    return { exchange, calls, release: () => gate.resolve() }
  }

  it('runs one exchange for concurrent callers and gives them all the same token', async () => {
    const xero = new FakeXero()
    await connect(xero)
    expire()
    const gated = gatedExchange(xero.exchange)
    const vault = vaultWith(gated.exchange)

    const pending = Array.from({ length: 5 }, () => vault.getAccessToken())
    await vi.waitFor(() => expect(gated.calls).toHaveLength(1))
    gated.release()
    const tokens = await Promise.all(pending)

    expect(gated.calls).toHaveLength(1)
    expect(new Set(tokens).size).toBe(1)
    expect(xero.apiCall(tokens[0])).toBe('ok')

    const writes = countWrites(db)
    expect(await vault.getAccessToken()).toBe(tokens[0])
    expect(gated.calls).toHaveLength(1)
    expect(writes.count).toBe(0)
  })

  it('starts a new refresh once the last one has finished', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const vault = vaultWith(xero.exchange)
    expire()
    await Promise.all([vault.getAccessToken(), vault.getAccessToken()])
    expire()
    await vault.getAccessToken()
    expect(xero.exchangeCalls).toHaveLength(2)
  })

  it('fails every concurrent caller on one rejected exchange, flags once, and recovers on reconnect', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const before = await mustRawRow(db)
    expire()
    const gated = gatedExchange(async () => {
      throw new Error('invalid_grant')
    })
    const vault = vaultWith(gated.exchange)

    const pending = Array.from({ length: 5 }, () => rejectionOf(vault.getAccessToken()))
    await vi.waitFor(() => expect(gated.calls).toHaveLength(1))
    gated.release()
    for (const err of await Promise.all(pending)) expectVaultError(err, 'needs_reconnect')
    expect(gated.calls).toHaveLength(1)
    expect(await mustRawRow(db)).toMatchObject({
      status: 'needs_reconnect',
      version: (before.version as number) + 1,
    })

    const fresh = xero.consent(connectionInput())
    await vault.storeConnection(fresh)
    expect(await vault.getAccessToken()).toBe(fresh.accessToken)
  })
})

describe('the version guard (Done-when 6)', () => {
  it('does not let a refresh holding an older version overwrite a newer write', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const before = await mustRawRow(db)
    expire()
    const winner = xero.consent(connectionInput())
    let loserGrant: XeroTokenGrant | undefined
    const exchange: XeroTokenExchange = async (refreshToken) => {
      await vaultWith(xero.exchange).storeConnection(winner)
      loserGrant = await xero.exchange(refreshToken)
      return loserGrant
    }

    const token = await vaultWith(exchange).getAccessToken()
    if (loserGrant === undefined) throw new Error('the exchange was never called')
    expect(token).toBe(winner.accessToken)

    const row = await mustRawRow(db)
    expect(row.version).toBe((before.version as number) + 1)
    expect(decryptField(row.access_token_enc, 'access_token')).toBe(winner.accessToken)
    expect(decryptField(row.refresh_token_enc, 'refresh_token')).toBe(winner.refreshToken)
    expect(
      leaked(await dumpAllTables(db), [loserGrant.accessToken, loserGrant.refreshToken]),
    ).toEqual([])
  })

  it('refuses with refresh_conflict, writing nothing, when the winner left a stale token', async () => {
    const xero = new FakeXero()
    await connect(xero)
    expire()
    const winner = xero.consent(connectionInput({ expiresInSeconds: 30 }))
    let afterWinner: Record<string, unknown> | undefined
    const exchange: XeroTokenExchange = async (refreshToken) => {
      await vaultWith(xero.exchange).storeConnection(winner)
      afterWinner = await mustRawRow(db)
      return xero.exchange(refreshToken)
    }

    expectVaultError(
      await rejectionOf(vaultWith(exchange).getAccessToken()),
      'refresh_conflict',
    )
    expect(await mustRawRow(db)).toEqual(afterWinner)
  })

  it('does not flag needs_reconnect over a newer write when its own exchange fails', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const before = await mustRawRow(db)
    expire()
    const winner = xero.consent(connectionInput())
    const exchange: XeroTokenExchange = async () => {
      await vaultWith(xero.exchange).storeConnection(winner)
      throw new Error('invalid_grant')
    }

    expect(await vaultWith(exchange).getAccessToken()).toBe(winner.accessToken)
    expect(await mustRawRow(db)).toMatchObject({
      status: 'connected',
      version: (before.version as number) + 1,
    })
  })

  it('answers not_connected, storing nothing, when a disconnect lands mid-refresh', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const before = await mustRawRow(db)
    expire()
    let grant: XeroTokenGrant | undefined
    const exchange: XeroTokenExchange = async (refreshToken) => {
      await vaultWith(xero.exchange).disconnect()
      grant = await xero.exchange(refreshToken)
      return grant
    }

    expectVaultError(await rejectionOf(vaultWith(exchange).getAccessToken()), 'not_connected')
    if (grant === undefined) throw new Error('the exchange was never called')
    expect(await mustRawRow(db)).toMatchObject({
      status: 'disconnected',
      version: (before.version as number) + 1,
      access_token_enc: null,
      refresh_token_enc: null,
      tenant_id_enc: null,
    })
    expect(leaked(await dumpAllTables(db), [grant.accessToken, grant.refreshToken])).toEqual(
      [],
    )
  })
})

describe('a failed exchange (Done-when 7)', () => {
  type Failure = [string, (refreshToken: string) => XeroTokenExchange]
  const validGrant = (): XeroTokenGrant => ({
    accessToken: sentinel('access'),
    refreshToken: sentinel('refresh'),
    expiresInSeconds: LIFETIME_SECONDS,
  })
  const malformed = (grant: Record<string, unknown> | undefined): XeroTokenExchange =>
    async () => grant as unknown as XeroTokenGrant

  const failures: Failure[] = [
    [
      'rejects with an Error that quotes the refresh token',
      () => async (refreshToken) => {
        throw new Error(`invalid_grant for ${refreshToken}`)
      },
    ],
    [
      'rejects with a TypeError, as fetch does on a network failure',
      () => async () => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      'rejects with something that is not an Error',
      () => (refreshToken) => Promise.reject(`refused ${refreshToken}`),
    ],
    [
      'throws before returning a promise',
      () =>
        ((refreshToken: string) => {
          throw new Error(refreshToken)
        }) as XeroTokenExchange,
    ],
    ['resolves with nothing', () => malformed(undefined)],
    ['resolves with an empty access token', () => malformed({ ...validGrant(), accessToken: '' })],
    [
      'resolves without a refresh token',
      () => malformed({ accessToken: sentinel('access'), expiresInSeconds: 1800 }),
    ],
    [
      'resolves with a refresh token that is not a string',
      () => malformed({ ...validGrant(), refreshToken: 123456 }),
    ],
    ['resolves with a zero expiry', () => malformed({ ...validGrant(), expiresInSeconds: 0 })],
    [
      'resolves with a fractional expiry',
      () => malformed({ ...validGrant(), expiresInSeconds: 1.5 }),
    ],
    [
      'resolves with an expiry given as text',
      () => malformed({ ...validGrant(), expiresInSeconds: '1800' }),
    ],
    [
      'resolves with an expiry past the last representable date',
      () => malformed({ ...validGrant(), expiresInSeconds: 2 ** 52 }),
    ],
  ]

  for (const [label, makeExchange] of failures) {
    it(`flags needs_reconnect, keeps the tokens, and then fails fast when the exchange ${label}`, async () => {
      const xero = new FakeXero()
      const input = await connect(xero)
      const before = await mustRawRow(db)
      expire()
      const calls: string[] = []
      const failing = makeExchange(input.refreshToken)
      const exchange: XeroTokenExchange = (refreshToken) => {
        calls.push(refreshToken)
        return failing(refreshToken)
      }
      const vault = vaultWith(exchange)

      const err = await rejectionOf(vault.getAccessToken())
      expectVaultError(err, 'needs_reconnect')
      expect('cause' in (err as object)).toBe(false)
      expect(
        leaked(errorTexts(err), [input.accessToken, input.refreshToken, input.tenantId]),
      ).toEqual([])
      expect(calls).toEqual([input.refreshToken])
      expect(await mustRawRow(db)).toEqual({
        ...before,
        status: 'needs_reconnect',
        version: (before.version as number) + 1,
      })

      const writes = countWrites(db)
      expectVaultError(await rejectionOf(vault.getAccessToken()), 'needs_reconnect')
      expectVaultError(await rejectionOf(vault.getTenantId()), 'needs_reconnect')
      expectVaultError(
        await rejectionOf(vaultWith(exchange).getAccessToken()),
        'needs_reconnect',
      )
      expect(calls).toHaveLength(1)
      expect(writes.count).toBe(0)
    })
  }
})

describe('status and key gates', () => {
  it('answers not_connected with no row, and with a disconnected row', async () => {
    const xero = new FakeXero()
    const vault = vaultWith(xero.exchange)
    expectVaultError(await rejectionOf(vault.getAccessToken()), 'not_connected')
    expectVaultError(await rejectionOf(vault.getTenantId()), 'not_connected')

    await connect(xero)
    await vault.disconnect()
    expectVaultError(await rejectionOf(vault.getAccessToken()), 'not_connected')
    expectVaultError(await rejectionOf(vault.getTenantId()), 'not_connected')
    expect(xero.exchangeCalls).toEqual([])
  })

  it('answers decrypt_failed under a different key, without an exchange or a status change', async () => {
    const xero = new FakeXero()
    await connect(xero)
    const before = await mustRawRow(db)
    stubKey()
    const vault = vaultWith(xero.exchange)

    expectVaultError(await rejectionOf(vault.getAccessToken()), 'decrypt_failed')
    expectVaultError(await rejectionOf(vault.getTenantId()), 'decrypt_failed')
    expire()
    expectVaultError(await rejectionOf(vault.getAccessToken()), 'decrypt_failed')
    expect(xero.exchangeCalls).toEqual([])
    expect(await mustRawRow(db)).toEqual(before)
  })

  it('answers decrypt_failed when the access and refresh blobs are swapped', async () => {
    const xero = new FakeXero()
    await connect(xero)
    await db.raw(
      'UPDATE xero_connection SET access_token_enc = refresh_token_enc, refresh_token_enc = access_token_enc',
    )
    const vault = vaultWith(xero.exchange)
    expectVaultError(await rejectionOf(vault.getAccessToken()), 'decrypt_failed')
    expire()
    expectVaultError(await rejectionOf(vault.getAccessToken()), 'decrypt_failed')
    expect(xero.exchangeCalls).toEqual([])
  })
})

describe('the vault object', () => {
  it('has exactly the four functions', () => {
    const vault = vaultWith(new FakeXero().exchange)
    expect(Object.keys(vault).sort()).toEqual(
      ['disconnect', 'getAccessToken', 'getTenantId', 'storeConnection'].sort(),
    )
  })

  it('works with getAccessToken detached, as the Xero client takes it', async () => {
    const xero = new FakeXero()
    await connect(xero)
    expire()
    const vault = vaultWith(xero.exchange)
    const { getAccessToken } = vault

    const seen: string[] = []
    const fetch = async (_url: URL, init: XeroGetInit): Promise<Response> => {
      seen.push(init.headers.Authorization)
      const body = readFileSync(
        new URL('../../client/__fixtures__/invoices-empty.json', import.meta.url),
        'utf8',
      )
      return new Response(body, { status: 200 })
    }
    const client = createXeroClient({
      getAccessToken,
      tenantId: await vault.getTenantId(),
      fetch,
    })

    expect(await client.getReceivableInvoices()).toEqual([])
    const token = await getAccessToken()
    expect(seen).toEqual([`Bearer ${token}`])
    expect(xero.apiCall(token)).toBe('ok')
    expect(xero.exchangeCalls).toHaveLength(1)
  })

  it('throws errors with no HTTP status for the server to answer with', async () => {
    const err = await rejectionOf(vaultWith(new FakeXero().exchange).getAccessToken())
    expectVaultError(err, 'not_connected')
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('XeroVaultError')
    for (const field of ['status', 'statusCode', 'cause']) {
      expect(field in (err as object), field).toBe(false)
    }
  })
})

// prd-05 Ruling 2 (#28 Done-when 8): no token, tenant or key in any log line
// or error. Every path through the vault, succeeding and failing, runs with
// every `console` method spied; every error it throws is read every way a
// caller could read it (message, stack, own properties, `util.inspect`).
// The vault logs nothing at all, so any console call is a failure. Every key,
// token and tenant is random per test; nothing calls Xero.
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Knex } from 'knex'

import { createXeroVault } from '../index.ts'
import type { XeroConnectionInput, XeroTokenExchange, XeroTokenGrant } from '../index.ts'
import {
  connectionInput,
  errorTexts,
  leaked,
  openDb,
  rejectionOf,
  sentinel,
  stubKey,
} from './helpers.ts'

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
const T0 = Date.parse('2026-10-26T00:00:00.000Z')

let db: Knex
let clock: number
let key: string
let consoleCalls: unknown[][]

beforeEach(async () => {
  key = stubKey()
  db = await openDb()
  clock = T0
  consoleCalls = []
  for (const method of METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args)
    })
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await db.destroy()
})

interface Outcome {
  errors: unknown[]
  /** Values that must appear nowhere, beyond the stored consent and the key. */
  extraSecrets: string[]
}

/** Every secret a scenario could leak: the consent, and the key as base64 and as hex. */
function secretsFor(input: XeroConnectionInput, extra: string[]): string[] {
  return [
    input.accessToken,
    input.refreshToken,
    input.tenantId,
    key,
    Buffer.from(key, 'base64').toString('hex'),
    ...extra,
  ]
}

function vault(exchange: XeroTokenExchange) {
  return createXeroVault({ db, exchange, now: () => clock })
}

function grant(): XeroTokenGrant {
  return {
    accessToken: sentinel('access'),
    refreshToken: sentinel('refresh'),
    expiresInSeconds: 1800,
  }
}

const scenarios: [string, (input: XeroConnectionInput) => Promise<Outcome>][] = [
  [
    'a store',
    async (input) => {
      await vault(async () => grant()).storeConnection(input)
      return { errors: [], extraSecrets: [] }
    },
  ],
  [
    'a successful refresh',
    async (input) => {
      const issued = grant()
      const v = vault(async () => issued)
      await v.storeConnection(input)
      clock += 1800 * 1000
      await v.getAccessToken()
      await v.getTenantId()
      return { errors: [], extraSecrets: [issued.accessToken, issued.refreshToken] }
    },
  ],
  [
    'an exchange failure whose error quotes the refresh token',
    async (input) => {
      const v = vault(async (refreshToken) => {
        throw new Error(`invalid_grant: ${refreshToken} was refused`)
      })
      await v.storeConnection(input)
      clock += 1800 * 1000
      return {
        errors: [
          await rejectionOf(v.getAccessToken()),
          await rejectionOf(v.getAccessToken()),
          await rejectionOf(v.getTenantId()),
        ],
        extraSecrets: [],
      }
    },
  ],
  [
    'a missing key',
    async (input) => {
      const v = vault(async () => grant())
      await v.storeConnection(input)
      vi.stubEnv('XERO_TOKEN_KEY', '')
      return {
        errors: [
          await rejectionOf(v.getAccessToken()),
          await rejectionOf(v.storeConnection(connectionInput())),
        ],
        extraSecrets: [],
      }
    },
  ],
  [
    'an invalid key with a distinctive value',
    async (input) => {
      const v = vault(async () => grant())
      await v.storeConnection(input)
      const bad = `${randomBytes(31).toString('base64')}`
      vi.stubEnv('XERO_TOKEN_KEY', bad)
      return {
        errors: [await rejectionOf(v.getAccessToken()), await rejectionOf(v.getTenantId())],
        extraSecrets: [bad],
      }
    },
  ],
  [
    'a stored blob that does not decrypt',
    async (input) => {
      const v = vault(async () => grant())
      await v.storeConnection(input)
      const other = stubKey()
      return {
        errors: [await rejectionOf(v.getAccessToken()), await rejectionOf(v.getTenantId())],
        extraSecrets: [other, Buffer.from(other, 'base64').toString('hex')],
      }
    },
  ],
  [
    'a storage failure on a refresh commit and on a store',
    async (input) => {
      const issued = grant()
      const v = vault(async () => issued)
      await v.storeConnection(input)
      await db.raw(
        "CREATE TRIGGER refuse BEFORE UPDATE ON xero_connection BEGIN SELECT RAISE(ABORT, 'refused'); END",
      )
      clock += 1800 * 1000
      const next = connectionInput()
      return {
        errors: [
          await rejectionOf(v.getAccessToken()),
          await rejectionOf(v.storeConnection(next)),
        ],
        extraSecrets: [
          issued.accessToken,
          issued.refreshToken,
          next.accessToken,
          next.refreshToken,
          next.tenantId,
        ],
      }
    },
  ],
  [
    'a disconnect',
    async (input) => {
      const v = vault(async () => grant())
      await v.storeConnection(input)
      await v.disconnect()
      return {
        errors: [await rejectionOf(v.getAccessToken()), await rejectionOf(v.getTenantId())],
        extraSecrets: [],
      }
    },
  ],
]

describe('nothing secret reaches a log or an error (Done-when 8)', () => {
  for (const [label, run] of scenarios) {
    it(`after ${label}`, async () => {
      const input = connectionInput()
      const { errors, extraSecrets } = await run(input)

      expect(consoleCalls).toEqual([])
      const texts = errors.flatMap(errorTexts)
      expect(leaked(texts, secretsFor(input, extraSecrets))).toEqual([])
      for (const err of errors) expect('cause' in (err as object)).toBe(false)
    })
  }

  it('positive control: the same detector flags a raw Knex error binding a token', async () => {
    const token = sentinel('access')
    const err = await rejectionOf(db.raw('SELECT ? AS leaked FROM no_such_table', [token]))
    expect(leaked(errorTexts(err), [token])).toEqual([token])
  })

  it('positive control: the same detector flags a console call carrying a token', () => {
    const token = sentinel('refresh')
    console.warn('refreshing with', token)
    const texts = consoleCalls.flat().map((arg) => inspect(arg))
    expect(leaked(texts, [token])).toEqual([token])
  })
})

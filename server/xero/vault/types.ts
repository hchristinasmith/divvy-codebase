// The shapes the Xero token vault takes and returns (prd-05 Rulings 2 and 3).
// Types only; the behaviour is in vault.ts, refresh.ts, store.ts and
// crypto.ts.

import type { Knex } from 'knex'

/** What Xero's token endpoint answers to a refresh, as the exchange reads it. */
export interface XeroTokenGrant {
  accessToken: string
  refreshToken: string
  /**
   * Xero's `expires_in`: the access token's lifetime in whole seconds. The
   * vault counts it from when it sent the refresh, which is no later than
   * when Xero answered.
   */
  expiresInSeconds: number
}

/**
 * Trades a refresh token for a new pair. The vault calls it at most once per
 * refresh and never retries it. The real one (the HTTP call to Xero's token
 * endpoint) belongs to the connect-routes lane; tests inject a fake. A
 * rejection, of any kind, means the refresh failed (Ruling 3). It must
 * settle, so the real one needs a timeout: while it is pending, every
 * `getAccessToken` caller waits on it, including callers after a new consent
 * has been stored.
 */
export type XeroTokenExchange = (refreshToken: string) => Promise<XeroTokenGrant>

/** What a completed consent hands the vault to store. */
export interface XeroConnectionInput {
  accessToken: string
  refreshToken: string
  tenantId: string
  /** Whole seconds from now until the access token expires. */
  expiresInSeconds: number
  /** The granted scopes, each one word; stored space-separated. */
  scopes: string[]
}

export interface XeroVaultOptions {
  /** The database holding `xero_connection`. The vault never opens its own. */
  db: Knex
  exchange: XeroTokenExchange
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Vaults built on the same `Knex` object share one refresh at a time
 * (vault.ts); a vault on a second `Knex` object over the same database is a
 * second refresher, which refresh.ts describes. Every member is a plain
 * function that needs no `this`, so `getAccessToken` can be handed on
 * detached (as the Xero client's `getAccessToken` option).
 */
export interface XeroVault {
  /** A usable access token, refreshing and storing a new pair first if needed. */
  getAccessToken: () => Promise<string>
  /** The connected organisation's tenant id. */
  getTenantId: () => Promise<string>
  /** Stores a new consent, replacing any previous connection. */
  storeConnection: (input: XeroConnectionInput) => Promise<void>
  /** Forgets the tokens and the tenant; a no-op when nothing is stored. */
  disconnect: () => Promise<void>
}

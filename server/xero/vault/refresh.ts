// The refresh (prd-05 Ruling 3): how the vault hands out an access token, and
// what a crash at each step of a refresh can and cannot cost.
//
// One pass, `accessTokenOnce`, reads the row and either returns the stored
// access token (connected, with more than `REFRESH_SKEW_MS` left) or
// refreshes: decrypt the stored refresh token, call the injected exchange
// once, encrypt the new pair, and commit it in one UPDATE guarded by the
// version the pass read (store.ts `commitRefresh`). A pass returns a
// refreshed token only after its commit has landed. vault.ts runs at most one
// pass at a time per process, so concurrent callers share one exchange.
//
// THE CRASH WINDOW. Xero issues a new refresh token on every exchange. Once
// Xero has answered, the token the vault sent may already be spent, and the
// new pair exists only in this process's memory until the commit lands. A
// crash after Xero answers and before the commit (the process killed, the
// machine stopping, the database refusing the write) is the only point at
// which a refresh can lose a token. No ordering of "ask Xero" and "store the
// answer" closes it, and this module does not claim to. What it guarantees
// is narrower:
// - The stored pair is never overwritten or deleted before the new pair is
//   committed. After such a crash the row still holds the old refresh token,
//   unchanged, with status `connected`.
// - The next call therefore replays the old refresh token. That works only
//   if Xero still honours a refresh token it has already rotated. Whether
//   Xero allows that for Divvy's app, and for how long, is not recorded: the
//   spike that measures it (#40) is open, so this module claims no grace
//   period and no figure for one. If Xero refuses the replay, the exchange
//   rejects, the row is marked `needs_reconnect`, and every later call fails
//   fast with that code until Hannah reconnects. The loss is loud, never
//   silent.
//
// The other crash points cost nothing:
// - Before the exchange (the key unreadable, the row unreadable, the
//   process stopped): nothing has been sent and nothing written; the next
//   call starts over with the stored pair.
// - After the commit and before the token is used, or between two API calls:
//   the commit precedes every return of a refreshed token, so whatever token
//   a caller held is already stored. The next process reads it, or refreshes
//   it with the stored refresh token, which is the live one.
//
// A failed exchange of any kind (Xero's `invalid_grant`, a network error, an
// answer that is not a usable pair) marks the row `needs_reconnect`, keeps
// the stored ciphertext, and throws `needs_reconnect` without the exchange's
// own error, which may quote the token. The vault never retries an exchange:
// after a network error it cannot tell whether Xero received the refresh
// token and rotated it.
//
// A losing pass. Every vault write bumps `version`, so a pass whose commit or
// `needs_reconnect` mark matches no row knows another write landed after it
// read (a new consent, a disconnect, or a refresh by another process). It
// discards its own result, reads the row once more and answers from that:
// the newer token if it is fresh, `not_connected` or `needs_reconnect` if
// that is what the row now says, and `refresh_conflict` if the newer token is
// itself stale. It never exchanges a second time.
//
// Concurrent processes are not excluded, only never allowed to overwrite a
// newer write. Two processes refreshing at once would each send the same
// refresh token to Xero. Divvy runs as one process on one machine with one
// volume (docs/decisions.md D1), so the in-process single-flight in vault.ts
// is the guard that matters; the version check is what keeps a second
// process from overwriting, not from spending a refresh token.

import type { Knex } from 'knex'

import { decryptField, encryptField } from './crypto.ts'
import { XeroVaultError } from './errors.ts'
import { commitRefresh, expiryAfter, isToken, markNeedsReconnect, readConnection } from './store.ts'
import type { ConnectionRow } from './store.ts'
import type { XeroTokenExchange } from './types.ts'

/** A token with this little left, or less, is refreshed before it is handed out. */
const REFRESH_SKEW_MS = 60_000

export interface RefreshDeps {
  db: Knex
  exchange: XeroTokenExchange
  now: () => number
}

interface UsableGrant {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

function needsReconnect(): XeroVaultError {
  return new XeroVaultError(
    'needs_reconnect',
    'Xero needs reconnecting: refreshing the stored token failed',
  )
}

/** The row when it is connected; otherwise the error every caller gets. */
export function usableConnection(row: ConnectionRow | null): ConnectionRow {
  if (row === null || row.status === 'disconnected') {
    throw new XeroVaultError('not_connected', 'Xero is not connected')
  }
  if (row.status === 'needs_reconnect') throw needsReconnect()
  return row
}

/** More than the skew left before expiry. An unreadable expiry is stale. */
function isFresh(row: ConnectionRow, nowMs: number): boolean {
  const expiresMs = row.expires_at === null ? Number.NaN : Date.parse(row.expires_at)
  return expiresMs - nowMs > REFRESH_SKEW_MS
}

/** The grant as a pair worth storing, or null when it is not one. */
function usableGrant(grant: unknown, requestedAtMs: number): UsableGrant | null {
  if (typeof grant !== 'object' || grant === null) return null
  const { accessToken, refreshToken, expiresInSeconds } = grant as Record<string, unknown>
  if (!isToken(accessToken) || !isToken(refreshToken)) return null
  // Xero counts `expires_in` from when it answered; counting from before the
  // request can only make the stored expiry earlier, never later.
  const expiresAt = expiryAfter(requestedAtMs, expiresInSeconds)
  return expiresAt === null ? null : { accessToken, refreshToken, expiresAt }
}

/** Answers from the row as it is now, after this pass's own write lost. */
async function answerFromNewerWrite(deps: RefreshDeps): Promise<string> {
  const row = usableConnection(await readConnection(deps.db))
  if (isFresh(row, deps.now())) return decryptField(row.access_token_enc, 'access_token')
  throw new XeroVaultError(
    'refresh_conflict',
    'another write changed the Xero connection during a refresh and left no usable token',
  )
}

/** One read, evaluate and (when needed) refresh. See the header. */
export async function accessTokenOnce(deps: RefreshDeps): Promise<string> {
  const row = usableConnection(await readConnection(deps.db))
  if (isFresh(row, deps.now())) return decryptField(row.access_token_enc, 'access_token')

  // A key or ciphertext failure stops here, before anything is sent.
  const refreshToken = decryptField(row.refresh_token_enc, 'refresh_token')
  const readVersion = row.version
  const requestedAt = deps.now()

  let grant: unknown = null
  try {
    // Through a promise, so an exchange that throws before returning one is
    // a failed exchange too.
    grant = await Promise.resolve().then(() => deps.exchange(refreshToken))
  } catch {
    // The exchange's error is dropped: it may quote the token.
    grant = null
  }

  const usable = usableGrant(grant, requestedAt)
  if (usable === null) {
    if (await markNeedsReconnect(deps.db, readVersion)) throw needsReconnect()
    return answerFromNewerWrite(deps)
  }

  const pair = {
    accessTokenEnc: encryptField(usable.accessToken, 'access_token'),
    refreshTokenEnc: encryptField(usable.refreshToken, 'refresh_token'),
  }
  const refreshedAt = new Date(deps.now()).toISOString()
  if (await commitRefresh(deps.db, readVersion, pair, usable.expiresAt, refreshedAt)) {
    return usable.accessToken
  }
  return answerFromNewerWrite(deps)
}

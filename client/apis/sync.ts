import { queryOptions } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.ts'
import { parseSyncStatus } from '../hooks/useSyncPill.ts'
// Type only: erased from the client bundle.
import type { SyncRunStatus, SyncStatus } from '../../server/routes/sync.ts'

// The Sync screen's requests (prd-02 issue 59; handoff Screen 7): prd-01's
// sync status (`GET /api/v1/sync/status`), the bank accounts sync stored
// (`GET /api/v1/accounts`), and "Sync now" (`POST /api/v1/sync/run`).
//
// What the screen keeps is narrowed here, at the edge. From the status: the
// running flag, the last run's times and outcome, and the last success. The
// run's `error` is a machine code ("akahu_unauthorized (HTTP 401)") and is
// dropped, so the screen cannot show it. From each account: its name and its
// connection's name. Ids, account numbers, balances and logos are dropped
// for the same reason.

const rootURL = new URL('/api/v1', document.baseURI)

const UNREADABLE = 'The server sent a reply Divvy could not read'

// A copy of `call` in ./overview.ts and ./subscriptions.ts (the same
// messages as `send` in ./settings.ts): the server's text when it sent one,
// its status when it did not, or that it could not be reached. Unlike those
// copies, a 200 that is not JSON (a proxy's HTML page) rejects with a fixed
// message, so the parser's SyntaxError, which quotes the body, never
// reaches the screen.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${rootURL}${path}`, init)
  } catch {
    throw new Error('The server could not be reached')
  }
  if (!response.ok) {
    let message: unknown
    try {
      message = ((await response.json()) as { error?: unknown }).error
    } catch {
      message = undefined
    }
    if (typeof message === 'string') throw new Error(message)
    throw new Error(`Server error (${response.status})`)
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new Error(UNREADABLE)
  }
}

// ---------------------------------------------------------------- status

/** The part of a run the screen reads. No `error`: see the header. */
export type SyncScreenRun = Pick<
  SyncRunStatus,
  'startedAt' | 'finishedAt' | 'outcome'
>

/** The part of `SyncStatus` the screen reads. */
export interface SyncScreenStatus {
  running: SyncStatus['running']
  lastRun: SyncScreenRun | null
  lastSuccessAt: SyncStatus['lastSuccessAt']
}

const UNEXPECTED_STATUS = 'Unexpected sync status'

const OUTCOMES: readonly SyncRunStatus['outcome'][] = [
  'running',
  'success',
  'failed',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isTimestampOrNull(value: unknown): value is string | null {
  return value === null || isTimestamp(value)
}

function parseRun(value: unknown): SyncScreenRun | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error(UNEXPECTED_STATUS)
  const { startedAt, finishedAt, outcome } = value
  const known = OUTCOMES.find((o) => o === outcome)
  if (!isTimestamp(startedAt) || !isTimestampOrNull(finishedAt) || !known) {
    throw new Error(UNEXPECTED_STATUS)
  }
  return { startedAt, finishedAt, outcome: known }
}

// A 200 that is not the status body (an HTML page, `{}`) throws, so the
// screen shows its error state and never a guessed "Not synced yet".
function parseStatusBody(body: unknown): SyncScreenStatus {
  if (!isRecord(body)) throw new Error(UNEXPECTED_STATUS)
  const { running, lastRun, lastSuccessAt } = body
  if (typeof running !== 'boolean' || !isTimestampOrNull(lastSuccessAt)) {
    throw new Error(UNEXPECTED_STATUS)
  }
  return { running, lastRun: parseRun(lastRun), lastSuccessAt }
}

// The screen's own entry, under the sync-status prefix. The header's pill
// caches a parsed epoch number at the bare `queryKeys.syncStatus.all`
// (client/hooks/useSyncPill.ts), so the two cannot share one entry; the
// queryKeys test pins `syncStatus` to `{ all }`, so the key is built here.
const SYNC_SCREEN_KEY = [...queryKeys.syncStatus.all, 'screen'] as const

// While a sync runs the screen asks every 2 s, so the spinner stops soon
// after the run does; otherwise once a minute, as the pill does. Keyed on
// the server's `running` flag only: a `running` outcome with `running`
// false is a row left by a process that died, not a sync in progress.
const RUNNING_POLL_MS = 2000
const IDLE_POLL_MS = 60_000

/**
 * The Sync screen's status read. Each reply is also written into the pill's
 * entry, parsed the pill's way, so the header never shows an older sync
 * than the rows below it (issue 59 Done-when 4). No `retry` here: a
 * per-query value would override the client's default.
 */
export function syncStatusQuery() {
  return queryOptions({
    queryKey: SYNC_SCREEN_KEY,
    queryFn: async ({ client }) => {
      const status = parseStatusBody(await call<unknown>('/sync/status'))
      client.setQueryData(
        queryKeys.syncStatus.all,
        parseSyncStatus(status, Date.now()),
      )
      return status
    },
    refetchInterval: (query) =>
      query.state.data?.running === true ? RUNNING_POLL_MS : IDLE_POLL_MS,
  })
}

// -------------------------------------------------------------- accounts

/** One bank account as the screen keeps it. */
export interface SyncAccount {
  name: string
  // Akahu's connection (the bank) name, or null when the account has none.
  connectionName: string | null
}

const UNEXPECTED_ACCOUNTS = 'Unexpected accounts list'

function parseAccount(item: unknown): SyncAccount {
  if (!isRecord(item) || typeof item.name !== 'string') {
    throw new Error(UNEXPECTED_ACCOUNTS)
  }
  const { connection } = item
  const connectionName =
    isRecord(connection) && typeof connection.name === 'string'
      ? connection.name
      : null
  return { name: item.name, connectionName }
}

function parseAccounts(body: unknown): SyncAccount[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error(UNEXPECTED_ACCOUNTS)
  }
  return body.items.map(parseAccount)
}

// Its own key, not the legacy Dashboard's `['accounts']`, which caches the
// whole envelope. Under the sync-status prefix, so the invalidation after
// "Sync now" re-reads the accounts too.
export const syncAccountsQuery = queryOptions({
  queryKey: [...queryKeys.syncStatus.all, 'accounts'] as const,
  queryFn: async () => parseAccounts(await call<unknown>('/accounts')),
})

// -------------------------------------------------------------- sync now

/** What "Sync now" got: a run started, or one was already in flight. */
export type SyncStart = 'started' | 'already running'

/** The one message a refused or failed "Sync now" shows. */
export const SYNC_NOW_ERROR = "Couldn't start a sync. Try again."

/**
 * POST /sync/run. 202 started a run and 409 means one is already running:
 * both mean a sync is in progress, so neither is an error. Anything else,
 * including a 200 the route never sends, a 403 and an unreachable server,
 * rejects with `SYNC_NOW_ERROR`. The response body is never read: the
 * status code is the whole answer, and the rows come from the status read.
 */
export async function startSync(): Promise<SyncStart> {
  let response: Response
  try {
    response = await fetch(`${rootURL}/sync/run`, { method: 'POST' })
  } catch {
    throw new Error(SYNC_NOW_ERROR)
  }
  if (response.status === 202) return 'started'
  if (response.status === 409) return 'already running'
  throw new Error(SYNC_NOW_ERROR)
}

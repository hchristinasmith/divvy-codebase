import { parseDollars } from '../../shared/money.ts'
import type {
  AkahuAccount,
  PendingTransaction,
  SettledTransaction,
  TransactionAkahuCategory,
  TransactionMerchant,
  TransactionMeta,
} from './types.ts'

// The Akahu client sync reads the bank through (prd-01, issue #20).
//
// This is the only code that talks to Akahu for sync and the only place an
// Akahu dollar amount becomes integer cents (prd-01 Ruling 3). It returns
// typed accounts, settled transactions and pending transactions, with cursor
// pagination followed to the end, so the caller never sees a float, a raw
// envelope or a credential.
//
// Credentials are parameters (prd-01 Ruling 5 keeps them in Fly secrets; the
// caller reads them). This module reads no environment variable and logs
// nothing.
//
// Requests: GET only, to a fixed origin and one of the known paths, with
// redirects refused and a timeout. A caller chooses only the date window
// (prd-01 Ruling 2); pagination only ever adds `cursor`.
//
// Amounts: `JSON.parse` would turn `19.99` into a binary double before any
// code saw it, so `parseExactJson` quotes every number literal first and each
// amount arrives as the decimal text Akahu sent. That text must look like
// `-12.34` (at most two decimal places, no exponent) and is converted by
// `parseDollars`, which is string arithmetic. A shape not seen before is
// refused, never rounded.
//
// Failures: every one rejects with `AkahuError`, and none resolves as an
// empty or partial list, so a caller that sees zero items can trust there are
// none. Messages are fixed text plus a status, a path or a field name; they
// never carry a response body, a query string, the token or the app id, and
// a network failure is reported without its underlying error as `cause`
// (that error can echo request headers).

export type AkahuErrorCode =
  | 'missing_credentials' // the token or app id is empty
  | 'unauthorized' // 401: Akahu refused the credentials
  | 'forbidden' // 403: the app lacks access to this resource
  | 'rate_limited' // 429
  | 'server' // any 5xx
  | 'http' // any other non-2xx status
  | 'network' // no response: fetch rejected, the body broke off, or timeout
  | 'bad_response' // a 2xx body this client cannot read

export class AkahuError extends Error {
  readonly code: AkahuErrorCode
  /** The HTTP status, or null when the failure is not tied to one response. */
  readonly status: number | null

  constructor(code: AkahuErrorCode, message: string, status: number | null) {
    super(message)
    this.name = 'AkahuError'
    this.code = code
    this.status = status
  }
}

function badResponse(message: string, status: number | null = null) {
  return new AkahuError('bad_response', message, status)
}

// ---------------------------------------------------------------------------
// Reading JSON without letting an amount become a float.

// One token at a time: a whole string literal (escapes included, so `\"`
// does not end it), or a JSON number literal. A number is matched by JSON's
// own grammar, so `01` splits into `0` and `1` and the quoted result fails to
// parse, as `JSON.parse` would. A number followed by `:` is left bare, so an
// invalid numeric key stays invalid instead of becoming a quoted one.
const JSON_TOKEN =
  /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?!\s*:)/g

/** JSON.parse with every number literal kept as its source text. */
function parseExactJson(text: string): unknown {
  return JSON.parse(
    text.replace(JSON_TOKEN, (token) =>
      token.startsWith('"') ? token : `"${token}"`,
    ),
  )
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, where: string): JsonRecord {
  if (!isRecord(value)) throw badResponse(`${where} is not an object`)
  return value
}

function requiredRecord(
  record: JsonRecord,
  key: string,
  where: string,
): JsonRecord {
  return asRecord(record[key], `${where}.${key}`)
}

function optionalRecord(
  record: JsonRecord,
  key: string,
  where: string,
): JsonRecord | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  return asRecord(value, `${where}.${key}`)
}

/** Text that identifies something, so it may not be empty. */
function requiredKey(record: JsonRecord, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw badResponse(`${where}.${key} is missing or not text`)
  }
  return value
}

/** Text that must be present but may be empty, such as a description. */
function requiredText(record: JsonRecord, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw badResponse(`${where}.${key} is missing or not text`)
  }
  return value
}

/** Absent or null is null; any text is kept verbatim. */
function optionalText(
  record: JsonRecord,
  key: string,
  where: string,
): string | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw badResponse(`${where}.${key} is not text`)
  }
  return value
}

const AKAHU_AMOUNT = /^-?\d+(\.\d{1,2})?$/

/**
 * Akahu's decimal dollar text as integer cents (prd-01 Ruling 3).
 * `parseDollars` already returns 0, not -0, for a negative zero.
 */
function toCents(value: unknown, field: string): number {
  if (typeof value !== 'string' || !AKAHU_AMOUNT.test(value)) {
    throw badResponse(`${field} is missing or not an amount`)
  }
  try {
    return parseDollars(value)
  } catch {
    throw badResponse(`${field} is out of range`)
  }
}

function requiredCents(record: JsonRecord, key: string, where: string) {
  return toCents(record[key], `${where}.${key}`)
}

function optionalCents(
  record: JsonRecord,
  key: string,
  where: string,
): number | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  return toCents(value, `${where}.${key}`)
}

// ---------------------------------------------------------------------------
// Mapping Akahu's items to the shapes in types.ts.

function mapAccount(value: unknown): AkahuAccount {
  const where = 'account'
  const item = asRecord(value, where)
  const connection = requiredRecord(item, 'connection', where)
  const balance = requiredRecord(item, 'balance', where)
  const refreshed = optionalRecord(item, 'refreshed', where)
  const at = (key: string) =>
    refreshed === null
      ? null
      : optionalText(refreshed, key, `${where}.refreshed`)
  return {
    id: requiredKey(item, '_id', where),
    name: requiredText(item, 'name', where),
    type: requiredKey(item, 'type', where),
    status: requiredKey(item, 'status', where),
    connection_id: requiredKey(connection, '_id', `${where}.connection`),
    connection_name: requiredText(connection, 'name', `${where}.connection`),
    formatted_account: optionalText(item, 'formatted_account', where),
    currency: optionalText(balance, 'currency', `${where}.balance`),
    balance_current_cents: requiredCents(
      balance,
      'current',
      `${where}.balance`,
    ),
    balance_available_cents: optionalCents(
      balance,
      'available',
      `${where}.balance`,
    ),
    balance_limit_cents: optionalCents(balance, 'limit', `${where}.balance`),
    refreshed_balance: at('balance'),
    refreshed_meta: at('meta'),
    refreshed_transactions: at('transactions'),
  }
}

function mapMerchant(
  item: JsonRecord,
  where: string,
): TransactionMerchant | null {
  const merchant = optionalRecord(item, 'merchant', where)
  if (merchant === null) return null
  const inner = `${where}.merchant`
  return {
    id: optionalText(merchant, '_id', inner),
    name: optionalText(merchant, 'name', inner),
    nzbn: optionalText(merchant, 'nzbn', inner),
    website: optionalText(merchant, 'website', inner),
  }
}

function mapMeta(item: JsonRecord, where: string): TransactionMeta | null {
  const meta = optionalRecord(item, 'meta', where)
  if (meta === null) return null
  const inner = `${where}.meta`
  return {
    code: optionalText(meta, 'code', inner),
    particulars: optionalText(meta, 'particulars', inner),
    reference: optionalText(meta, 'reference', inner),
    other_account: optionalText(meta, 'other_account', inner),
    logo: optionalText(meta, 'logo', inner),
  }
}

/** Akahu's category only; the user's category is not Akahu's to send. */
function mapAkahuCategory(
  item: JsonRecord,
  where: string,
): TransactionAkahuCategory | null {
  const category = optionalRecord(item, 'category', where)
  if (category === null) return null
  const inner = `${where}.category`
  const groups = optionalRecord(category, 'groups', inner)
  const group =
    groups === null
      ? null
      : optionalRecord(groups, 'personal_finance', `${inner}.groups`)
  const groupWhere = `${inner}.groups.personal_finance`
  return {
    id: optionalText(category, '_id', inner),
    name: optionalText(category, 'name', inner),
    group_id: group === null ? null : optionalText(group, '_id', groupWhere),
    group_name: group === null ? null : optionalText(group, 'name', groupWhere),
  }
}

function mapSettled(value: unknown): SettledTransaction {
  const where = 'transaction'
  const item = asRecord(value, where)
  return {
    status: 'settled',
    id: requiredKey(item, '_id', where),
    account_id: requiredKey(item, '_account', where),
    connection_id: optionalText(item, '_connection', where),
    date: requiredKey(item, 'date', where),
    posted_date: optionalText(item, 'posted_date', where),
    created_at: optionalText(item, 'created_at', where),
    updated_at: optionalText(item, 'updated_at', where),
    hash: optionalText(item, 'hash', where),
    amount_cents: requiredCents(item, 'amount', where),
    balance_cents: optionalCents(item, 'balance', where),
    description: requiredText(item, 'description', where),
    type: requiredText(item, 'type', where),
    merchant: mapMerchant(item, where),
    meta: mapMeta(item, where),
    akahu_category: mapAkahuCategory(item, where),
  }
}

/** Any `_id` Akahu sends on a pending item is ignored (prd-01 Ruling 1). */
function mapPending(value: unknown): PendingTransaction {
  const where = 'pending transaction'
  const item = asRecord(value, where)
  return {
    status: 'pending',
    account_id: requiredKey(item, '_account', where),
    connection_id: optionalText(item, '_connection', where),
    date: requiredKey(item, 'date', where),
    updated_at: optionalText(item, 'updated_at', where),
    amount_cents: requiredCents(item, 'amount', where),
    description: optionalText(item, 'description', where) ?? '',
    type: optionalText(item, 'type', where) ?? '',
    merchant: mapMerchant(item, where),
    meta: mapMeta(item, where),
    akahu_category: mapAkahuCategory(item, where),
  }
}

// ---------------------------------------------------------------------------
// The network.

const AKAHU_ORIGIN = 'https://api.akahu.io'

/** Every path the client may request. Adding one is a reviewed change. */
type AkahuPath =
  | '/v1/accounts'
  | '/v1/transactions'
  | '/v1/transactions/pending'

/** The request options every call sends; the type admits no other method. */
export interface AkahuGetInit {
  method: 'GET'
  headers: Record<string, string>
  redirect: 'error'
  signal: AbortSignal
}

/** The fetch the client needs. `globalThis.fetch` satisfies it. */
export type AkahuFetch = (url: URL, init: AkahuGetInit) => Promise<Response>

export interface AkahuClientOptions {
  /** Akahu's user token (personal-app mode, prd-01 Ruling 5). */
  token: string
  /** Akahu's app id token, sent as `X-Akahu-Id`. */
  appId: string
  /** Defaults to `globalThis.fetch`, looked up when each request is sent. */
  fetch?: AkahuFetch
}

/** How long one request, body included, may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * The most pages one listing will follow. Reaching it means the stop rule
 * never fired, which is treated as a bad response, not as the full list.
 */
export const MAX_PAGES = 500

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function statusError(status: number, path: AkahuPath): AkahuError {
  if (status === 401) {
    return new AkahuError(
      'unauthorized',
      `Akahu refused the credentials (401) on ${path}`,
      status,
    )
  }
  if (status === 403) {
    return new AkahuError(
      'forbidden',
      `Akahu refused access (403) on ${path}`,
      status,
    )
  }
  if (status === 429) {
    return new AkahuError(
      'rate_limited',
      `Akahu rate limit reached (429) on ${path}`,
      status,
    )
  }
  if (status >= 500 && status <= 599) {
    return new AkahuError(
      'server',
      `Akahu server error (${status}) on ${path}`,
      status,
    )
  }
  return new AkahuError('http', `Akahu responded ${status} on ${path}`, status)
}

function networkError(path: AkahuPath, signal: AbortSignal): AkahuError {
  // The underlying error is dropped on purpose: it is not attached as
  // `cause`, because its message or stack can carry request details.
  const message = signal.aborted
    ? `Akahu request timed out on ${path}`
    : `Akahu request failed before a full response arrived on ${path}`
  return new AkahuError('network', message, null)
}

/** One GET; resolves to the parsed body with every number kept as text. */
async function akahuGet(
  options: AkahuClientOptions,
  path: AkahuPath,
  query: Record<string, string>,
): Promise<unknown> {
  if (!hasText(options.token) || !hasText(options.appId)) {
    throw new AkahuError(
      'missing_credentials',
      'Akahu token or app id is not set',
      null,
    )
  }
  const url = new URL(path, AKAHU_ORIGIN)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const init: AkahuGetInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'X-Akahu-Id': options.appId,
      Accept: 'application/json',
    },
    redirect: 'error',
    signal: controller.signal,
  }
  const fetch: AkahuFetch = options.fetch ?? globalThis.fetch
  let status: number
  let text: string
  try {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch {
      throw networkError(path, controller.signal)
    }
    if (!response.ok) throw statusError(response.status, path)
    status = response.status
    try {
      text = await response.text()
    } catch {
      throw networkError(path, controller.signal)
    }
  } finally {
    clearTimeout(timer)
  }
  try {
    return parseExactJson(text)
  } catch {
    throw badResponse(
      `Akahu returned a body that is not JSON on ${path}`,
      status,
    )
  }
}

/** Akahu's envelope: `{ success: true, items: [...], cursor?: { next } }`. */
function readPage(
  body: unknown,
  path: AkahuPath,
): { items: unknown[]; next: string | null } {
  const envelope = asRecord(body, `${path} response`)
  if (envelope.success !== true) {
    throw badResponse(`${path} response is not marked success`)
  }
  if (!Array.isArray(envelope.items)) {
    throw badResponse(`${path} response.items is not a list`)
  }
  return { items: envelope.items, next: readNextCursor(envelope, path) }
}

/**
 * Absent or null `cursor` or `cursor.next` is the last page. Any other value
 * that is not non-empty text is refused rather than treated as the end.
 */
function readNextCursor(envelope: JsonRecord, path: AkahuPath): string | null {
  const cursor = envelope.cursor
  if (cursor === undefined || cursor === null) return null
  const next = asRecord(cursor, `${path} response.cursor`).next
  if (next === undefined || next === null) return null
  if (typeof next !== 'string' || next === '') {
    throw badResponse(`${path} response.cursor.next is not a cursor`)
  }
  return next
}

/**
 * Follows `cursor.next` until it ends, mapping every item. A cursor seen
 * before, or more than `MAX_PAGES` pages, is a bad response: a listing that
 * cannot be read to its end is never returned in part.
 */
async function listAll<T>(
  options: AkahuClientOptions,
  path: AkahuPath,
  query: Record<string, string>,
  mapItem: (item: unknown) => T,
): Promise<T[]> {
  const all: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await akahuGet(
      options,
      path,
      cursor === null ? query : { ...query, cursor },
    )
    const { items, next } = readPage(body, path)
    for (const item of items) all.push(mapItem(item))
    if (next === null) return all
    if (seen.has(next)) throw badResponse(`${path} repeated a cursor`)
    seen.add(next)
    cursor = next
  }
  throw badResponse(`${path} did not end within ${MAX_PAGES} pages`)
}

// ---------------------------------------------------------------------------
// The client.

export interface AkahuClient {
  listAccounts(): Promise<AkahuAccount[]>
  /** Settled transactions dated within `start`..`end` (prd-01 Ruling 2). */
  listTransactions(range: {
    start: Date
    end: Date
  }): Promise<SettledTransaction[]>
  listPendingTransactions(): Promise<PendingTransaction[]>
}

/**
 * A client for one Akahu user. Empty credentials do not throw here: each
 * call rejects with `missing_credentials`, so the caller records it like any
 * other sync failure.
 */
export function createAkahuClient(options: AkahuClientOptions): AkahuClient {
  const context: AkahuClientOptions = {
    token: options.token,
    appId: options.appId,
    fetch: options.fetch,
  }
  return {
    async listAccounts() {
      return listAll(context, '/v1/accounts', {}, mapAccount)
    },
    async listTransactions({ start, end }) {
      return listAll(
        context,
        '/v1/transactions',
        { start: start.toISOString(), end: end.toISOString() },
        mapSettled,
      )
    },
    async listPendingTransactions() {
      return listAll(context, '/v1/transactions/pending', {}, mapPending)
    },
  }
}

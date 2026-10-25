import { parseExactJson } from '../../../shared/exact-json.ts'
import { XeroClientError } from './errors.ts'
import { readCount, readRecord } from './json.ts'
import type { JsonRecord } from './json.ts'

// The only place the Xero client touches the network (prd-05 done-when 5).
//
// GET-only by construction: the request options are a fixed object whose
// `method` is the literal 'GET' and which has no body; the origin is
// hard-coded; a caller chooses only one of the known paths and query values;
// pagination only ever changes `page`. Redirects are refused rather than
// followed, so a request cannot be re-sent anywhere else.
//
// The bearer token is fetched from the injected `getAccessToken` on every
// request and never cached here (the vault owns refresh, prd-05 Ruling 3).
// Nothing in this module logs.
//
// Every body is read by the shared exact-text reader (`parseExactJson`,
// shared/exact-json.ts, called from `xeroGet` below), so no amount becomes a
// binary float on the way in. The readers in json.ts take it from there.

const XERO_ORIGIN = 'https://api.xero.com'

/** Every path the client may request. Adding one is a reviewed change. */
export type XeroPath =
  | '/api.xro/2.0/Invoices'
  | '/api.xro/2.0/Reports/ProfitAndLoss'
  | '/payroll.xro/2.0/PayRuns'

/** The request options every call sends; the type admits no other method. */
export interface XeroGetInit {
  method: 'GET'
  headers: Record<string, string>
  redirect: 'error'
}

/** The fetch the client needs. `globalThis.fetch` satisfies it. */
export type XeroFetch = (url: URL, init: XeroGetInit) => Promise<Response>

export interface XeroContext {
  getAccessToken: () => Promise<string>
  tenantId: string
  /** Defaults to `globalThis.fetch`, looked up when each request is sent. */
  fetch?: XeroFetch
}

/**
 * The most pages one listing will follow. Reaching it means the stop rule
 * never fired, which is treated as a bad response, not as the full list.
 */
export const MAX_PAGES = 200

const WHOLE_SECONDS = /^\d+$/

function retryAfterSeconds(header: string | null): number | null {
  if (header === null) return null
  const trimmed = header.trim()
  if (!WHOLE_SECONDS.test(trimmed)) return null
  const seconds = parseInt(trimmed, 10)
  return Number.isSafeInteger(seconds) ? seconds : null
}

function errorFor(response: Response): XeroClientError {
  const { status } = response
  if (status === 401) {
    return new XeroClientError(
      'auth_failed',
      'Xero refused the access token (401)',
      status,
    )
  }
  if (status === 403) {
    return new XeroClientError(
      'forbidden',
      'Xero refused access to this resource (403); check the granted scopes',
      status,
    )
  }
  if (status === 429) {
    return new XeroClientError(
      'rate_limited',
      'Xero rate limit reached (429)',
      status,
      retryAfterSeconds(response.headers.get('Retry-After')),
    )
  }
  return new XeroClientError('http_error', `Xero responded ${status}`, status)
}

/** One GET; resolves to the parsed body with every number kept as text. */
export async function xeroGet(
  ctx: XeroContext,
  path: XeroPath,
  query: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path, XERO_ORIGIN)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  const token = await ctx.getAccessToken()
  const init: XeroGetInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': ctx.tenantId,
      Accept: 'application/json',
    },
    redirect: 'error',
  }
  const fetch: XeroFetch = ctx.fetch ?? globalThis.fetch
  const response = await fetch(url, init)
  if (!response.ok) throw errorFor(response)
  const text = await response.text()
  try {
    return parseExactJson(text)
  } catch {
    throw new XeroClientError(
      'bad_response',
      'Xero returned a body that is not JSON',
      response.status,
    )
  }
}

/** One page of a listing, as the caller's `readPage` sees it. */
export interface XeroPage {
  items: unknown[]
  /** From the response's `pagination.pageCount`, or null when absent. */
  pageCount: number | null
}

/**
 * Reads `pagination.pageCount` when the response carries it. Absent is null;
 * present but malformed is a bad response.
 */
export function readPageCount(body: JsonRecord): number | null {
  const pagination = body.pagination
  if (pagination === undefined || pagination === null) return null
  const record = readRecord(pagination, 'pagination')
  if (record.pageCount === undefined) return null
  return readCount(record.pageCount, 'pagination.pageCount')
}

/**
 * Follows `page=1, 2, …` to the end. Stops on an empty page, or once the page
 * just read is at or past `pageCount`. A short page is not the end: Xero's
 * page size is not something this client assumes.
 */
export async function getAllPages(
  ctx: XeroContext,
  path: XeroPath,
  query: Record<string, string>,
  readPage: (body: unknown) => XeroPage,
): Promise<unknown[]> {
  const all: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, pageCount } = readPage(
      await xeroGet(ctx, path, { ...query, page: String(page) }),
    )
    if (items.length === 0) return all
    all.push(...items)
    if (pageCount !== null && page >= pageCount) return all
  }
  throw new XeroClientError(
    'bad_response',
    `Xero listing did not end within ${MAX_PAGES} pages`,
  )
}

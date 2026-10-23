// The one error type the Xero client rejects with.
//
// A failure is never an empty list: a caller that sees zero invoices can trust
// there are none, because every way of not knowing is one of these codes.
//
// Messages are fixed text plus an HTTP status or a field name. They never
// carry the access token, the tenant id or a response body, so an error can be
// logged or stored by a caller without leaking either.

export type XeroErrorCode =
  | 'auth_failed' // 401: the access token was refused
  | 'forbidden' // 403: the token lacks a scope, or the tenant is not connected
  | 'rate_limited' // 429: see `retry_after`
  | 'http_error' // any other non-2xx status
  | 'bad_response' // a 2xx body that is not the shape this client reads

export class XeroClientError extends Error {
  readonly code: XeroErrorCode
  /** The HTTP status, or null when the failure is not tied to one response. */
  readonly status: number | null
  /** Seconds to wait, from a 429's `Retry-After`; null when absent or invalid. */
  readonly retry_after: number | null

  constructor(
    code: XeroErrorCode,
    message: string,
    status: number | null = null,
    retryAfter: number | null = null,
  ) {
    super(message)
    this.name = 'XeroClientError'
    this.code = code
    this.status = status
    this.retry_after = retryAfter
  }
}

/** Shorthand for the shape failures the mappers raise. */
export function badResponse(message: string): XeroClientError {
  return new XeroClientError('bad_response', message)
}

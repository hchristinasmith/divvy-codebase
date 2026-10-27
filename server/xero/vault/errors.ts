// The one error type the Xero token vault throws (prd-05 Rulings 2 and 3).
//
// Every failure inside the vault surfaces as a `XeroVaultError` with a code
// and a fixed message. A message never carries a token, the tenant id, the
// key, the key's value when it is wrong, a refresh exchange's own error, or a
// database error's text (a Knex error's message holds the SQL and its bound
// values, which here would be the ciphertext). Anything else that reaches the
// vault's edge is replaced, not wrapped: there is no `cause`, so nothing the
// vault caught can be reached through the error it throws.
//
// There is deliberately no `status` or `statusCode`: `server/server.ts` turns
// an error carrying a 4xx status into that status, and a vault failure is
// never the caller's fault, so it answers 500 like any other server error.
//
// This is not `server/xero/client/errors.ts`: that class carries Xero's HTTP
// status and Retry-After for one API response; this one describes the stored
// connection. They share no code and no base class.

export type XeroVaultErrorCode =
  | 'key_missing' // XERO_TOKEN_KEY is unset or empty
  | 'key_invalid' // XERO_TOKEN_KEY is not 32 bytes of standard base64
  | 'decrypt_failed' // a stored blob did not authenticate under this key and field
  | 'not_connected' // no connection row, or it was disconnected
  | 'needs_reconnect' // a refresh failed; only a new consent fixes it (Ruling 3)
  | 'refresh_conflict' // another writer won the refresh and its token is not usable
  | 'storage_failed' // the database refused or failed a read or write
  | 'invalid_input' // a value handed to the vault is not one it can store

export class XeroVaultError extends Error {
  readonly code: XeroVaultErrorCode

  constructor(code: XeroVaultErrorCode, message: string) {
    super(message)
    this.name = 'XeroVaultError'
    this.code = code
  }
}

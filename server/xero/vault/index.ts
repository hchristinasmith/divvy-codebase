// Divvy's Xero token vault (prd-05 Rulings 2 and 3, issue #28).
//
// Holds the access token, the refresh token and the tenant id as AES-256-GCM
// ciphertext in `xero_connection` under `XERO_TOKEN_KEY` (crypto.ts), and
// hands out an access token, refreshing it first when it is about to expire
// (refresh.ts, whose header describes the crash window). The HTTP call to
// Xero's token endpoint is not here: the caller injects it as `exchange`.
//
// This file is the vault's only public surface. Construct one vault per
// process with the server's database connection and the real exchange; its
// `getAccessToken` is what `createXeroClient` takes.

export { createXeroVault } from './vault.ts'
export { XeroVaultError } from './errors.ts'
export type { XeroVaultErrorCode } from './errors.ts'
export type {
  XeroConnectionInput,
  XeroTokenExchange,
  XeroTokenGrant,
  XeroVault,
  XeroVaultOptions,
} from './types.ts'

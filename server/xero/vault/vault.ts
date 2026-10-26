// `createXeroVault` (prd-05 Rulings 2 and 3): the one object the rest of the
// server uses to reach Xero's tokens.
//
// One process holds one vault. `getAccessToken` is single-flight: while a
// pass (refresh.ts `accessTokenOnce`) is running, every caller is handed that
// same pass, so concurrent callers on an expired token cause one exchange and
// all get the same token. The pass is cleared once it settles, whether it
// resolved or rejected, so the next call reads the row again. There is no
// read outside the pass: a caller never sees a row the pass has not.
//
// Every member is a closure over the options, so any of them can be passed on
// detached. The vault writes only `xero_connection`, opens no database of its
// own, makes no network call (the exchange is injected) and logs nothing.

import { decryptField } from './crypto.ts'
import { accessTokenOnce, usableConnection } from './refresh.ts'
import type { RefreshDeps } from './refresh.ts'
import { disconnect, readConnection, storeConnection } from './store.ts'
import type { XeroVault, XeroVaultOptions } from './types.ts'

export function createXeroVault(options: XeroVaultOptions): XeroVault {
  const deps: RefreshDeps = {
    db: options.db,
    exchange: options.exchange,
    now: options.now ?? Date.now,
  }
  let inflight: Promise<string> | null = null

  return {
    getAccessToken: () => {
      if (inflight === null) {
        inflight = accessTokenOnce(deps).finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    getTenantId: async () => {
      const row = usableConnection(await readConnection(deps.db))
      return decryptField(row.tenant_id_enc, 'tenant_id')
    },
    storeConnection: async (input) => storeConnection(deps.db, input, deps.now()),
    disconnect: async () => disconnect(deps.db),
  }
}

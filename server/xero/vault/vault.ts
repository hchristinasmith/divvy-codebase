// `createXeroVault` (prd-05 Rulings 2 and 3): the one object the rest of the
// server uses to reach Xero's tokens.
//
// `getAccessToken` is single-flight per database: while a pass (refresh.ts
// `accessTokenOnce`) is running on a `Knex` object, every caller of every
// vault built on that same object is handed that same pass, so concurrent
// callers on an expired token cause one exchange and all get the same token.
// The pass runs with the exchange and clock of the vault whose call started
// it. It is cleared once it settles, whether it resolved or rejected, so the
// next call reads the row again; the clear checks that the entry is still
// this pass, so it can never drop a later one. There is no read outside the
// pass: a caller never sees a row the pass has not.
//
// The key is the `Knex` object, not the file it opens: two `Knex` objects on
// one database file, or two processes, are still two refreshers, which
// refresh.ts describes. Divvy runs one process (docs/decisions.md D1, D2),
// and every vault in it should be built on the one `Knex` object from
// server/db/connection.ts.
//
// Every member is a closure over the options, so any of them can be passed on
// detached. The vault writes only `xero_connection`, opens no database of its
// own, makes no network call (the exchange is injected) and logs nothing.

import type { Knex } from 'knex'

import { decryptField } from './crypto.ts'
import { accessTokenOnce, usableConnection } from './refresh.ts'
import type { RefreshDeps } from './refresh.ts'
import { disconnect, readConnection, storeConnection } from './store.ts'
import type { XeroVault, XeroVaultOptions } from './types.ts'

/** The running pass for each database, shared by every vault built on it. */
const inflightByDb = new WeakMap<Knex, Promise<string>>()

export function createXeroVault(options: XeroVaultOptions): XeroVault {
  const deps: RefreshDeps = {
    db: options.db,
    exchange: options.exchange,
    now: options.now ?? Date.now,
  }

  return {
    getAccessToken: () => {
      const running = inflightByDb.get(deps.db)
      if (running !== undefined) return running
      const pass: Promise<string> = accessTokenOnce(deps).finally(() => {
        if (inflightByDb.get(deps.db) === pass) inflightByDb.delete(deps.db)
      })
      inflightByDb.set(deps.db, pass)
      return pass
    },
    getTenantId: async () => {
      const row = usableConnection(await readConnection(deps.db))
      return decryptField(row.tenant_id_enc, 'tenant_id')
    },
    storeConnection: async (input) => storeConnection(deps.db, input, deps.now()),
    disconnect: async () => disconnect(deps.db),
  }
}

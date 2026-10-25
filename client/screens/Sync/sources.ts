import type { SyncAccount } from '../../apis/sync.ts'

// The Sync screen's rows: one per bank connection (Akahu's `connection`),
// in the order the accounts list first names each, with that connection's
// account names under it. Two connections with the same name are one row.
// An account with no connection name is its own row, titled by its name,
// and never merges with a connection that happens to share that name.

interface SyncSource {
  name: string
  accounts: string[]
}

export function groupSources(accounts: readonly SyncAccount[]): SyncSource[] {
  const byKey = new Map<string, SyncSource>()
  accounts.forEach((account, index) => {
    const key =
      account.connectionName === null
        ? `account:${index}`
        : `connection:${account.connectionName}`
    const existing = byKey.get(key)
    if (existing) {
      existing.accounts.push(account.name)
    } else {
      byKey.set(key, {
        name: account.connectionName ?? account.name,
        accounts: [account.name],
      })
    }
  })
  return [...byKey.values()]
}

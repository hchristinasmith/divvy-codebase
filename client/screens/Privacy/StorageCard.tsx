import ClaimCard, { CLAIM } from './ClaimCard.tsx'

// Storage: where the data sits and how it is backed up. The design's
// "Encrypted at rest" and "Nightly backup" are dropped: no app code encrypts
// the database, and Litestream is continuous, not nightly (D2).
export default function StorageCard() {
  return (
    <ClaimCard heading="Storage" title="One database on the server">
      {/* Basis: D2 (SQLite stays); prd-01 Ruling 5; the sync scheduler reads
          AKAHU_USER_TOKEN from the environment (server/sync/scheduler.ts),
          never from the database. This names the Akahu token only: prd-05's
          xero_connection table is built to hold Xero tokens, encrypted, in
          this database once Xero is connected. Revisit when it is. */}
      <p className={CLAIM}>
        Divvy keeps your data in a single SQLite database on the server&apos;s
        disk. Your Akahu token is not in it; it stays in the server&apos;s
        settings.
      </p>
      {/* Basis: D2 (Litestream, continuous); litestream.yml; docs/restore.md.
          Config, not a confirmed live backup: the replica's provider is not
          decided and the restore drill has only been run locally. The app
          cannot see Litestream, so it makes no claim that a backup ran. */}
      <p className={CLAIM}>
        Litestream is set up to copy that database to separate storage
        continuously. This page does not show whether a backup has run.
      </p>
    </ClaimCard>
  )
}

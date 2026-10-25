import ClaimCard, { CLAIM } from './ClaimCard.tsx'

// Banks: what Divvy does with the bank feed. The design's "Open Banking
// tokens ... cannot move money" is a statement about the token's scopes,
// which this repository cannot check; these sentences are about Divvy's own
// code instead.
export default function BanksCard() {
  return (
    <ClaimCard heading="Banks" title="Read-only access">
      {/* Basis: server/sync/akahu-client.ts sends only GET, to /v1/accounts,
          /v1/transactions and /v1/transactions/pending; its request type
          admits no other method. A statement about Divvy's code, not about
          the token's scopes. */}
      <p className={CLAIM}>
        Divvy reads your account balances and transactions through Akahu, a
        third-party Open Banking service. It never asks your bank to move money.
      </p>
      {/* Basis: docs/design/handoff.md Screen 8 (90-day re-consent) and
          prd-01's note on Akahu re-consent. The interval is not confirmed
          anywhere in this repository, so the sentence is hedged ("can",
          "about"). */}
      <p className={CLAIM}>
        Akahu can ask you to approve the connection again, about every 90 days.
      </p>
    </ClaimCard>
  )
}

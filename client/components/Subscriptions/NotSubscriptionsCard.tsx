import type { SubscriptionMerchant } from '../../../shared/contracts.ts'
import MerchantRow from './MerchantRow.tsx'
import { CARD, CARD_TITLE, SECONDARY_BUTTON } from './styles.ts'
import type { SubscriptionActions } from './useSubscriptionActions.ts'

// Merchants Hannah said are not subscriptions, so she can take it back.
// Undo clears her answer; detection and the name hint then decide again.
// The design has no such card; this is built from its card idiom.
export default function NotSubscriptionsCard({
  merchants,
  actions,
}: {
  merchants: SubscriptionMerchant[]
  actions: SubscriptionActions
}) {
  return (
    <section
      aria-labelledby="not-subscriptions-heading"
      className={`${CARD} flex flex-col gap-3 p-6`}
    >
      <h2 id="not-subscriptions-heading" className={CARD_TITLE}>
        Not subscriptions
      </h2>
      <p className="m-0 text-body-13 text-ink-muted">
        You said these aren&apos;t subscriptions.
      </p>
      <ul className="m-0 flex list-none flex-col p-0">
        {merchants.map((merchant) => (
          <MerchantRow key={`${merchant.scope}:${merchant.merchantKey}`} merchant={merchant}>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              aria-label={`Undo: ${merchant.name} is not a subscription`}
              disabled={actions.isPending}
              onClick={() =>
                actions.mark(
                  { scope: merchant.scope, merchantKey: merchant.merchantKey },
                  null,
                )
              }
            >
              Undo
            </button>
          </MerchantRow>
        ))}
      </ul>
    </section>
  )
}

import type { SubscriptionMerchant } from '../../../shared/contracts.ts'
import MerchantRow from './MerchantRow.tsx'
import { CARD, CARD_TITLE, PRIMARY_BUTTON, SECONDARY_BUTTON } from './styles.ts'
import type { SubscriptionActions } from './useSubscriptionActions.ts'

// Merchants whose name looks like a subscription but whose charges are too
// few to be sure (prd-02 Ruling 14). Her answer moves the merchant: Yes into
// the list, No into "Not subscriptions". The design has no such card; this
// is built from its card idiom.
export default function QuestionsCard({
  questions,
  actions,
}: {
  questions: SubscriptionMerchant[]
  actions: SubscriptionActions
}) {
  return (
    <section
      aria-labelledby="questions-heading"
      className={`${CARD} flex flex-col gap-3.5 p-6`}
    >
      <h2 id="questions-heading" className={CARD_TITLE}>
        Is this a subscription?
      </h2>
      <p className="m-0 text-body-13 text-ink-muted">
        These look like one by name, but there are too few charges to be sure.
      </p>
      <ul className="m-0 flex list-none flex-col p-0">
        {questions.map((merchant) => {
          const target = { scope: merchant.scope, merchantKey: merchant.merchantKey }
          return (
            <MerchantRow key={`${merchant.scope}:${merchant.merchantKey}`} merchant={merchant}>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                aria-label={`Yes, ${merchant.name} is a subscription`}
                disabled={actions.isPending}
                onClick={() => actions.mark(target, 'subscription')}
              >
                Yes
              </button>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                aria-label={`No, ${merchant.name} is not a subscription`}
                disabled={actions.isPending}
                onClick={() => actions.mark(target, 'not_subscription')}
              >
                No
              </button>
            </MerchantRow>
          )
        })}
      </ul>
    </section>
  )
}

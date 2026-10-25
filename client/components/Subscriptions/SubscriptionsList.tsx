import type { IsoDate, SubscriptionRow } from '../../../shared/contracts.ts'
import SubscriptionItem from './SubscriptionItem.tsx'
import { CARD, MUTED } from './styles.ts'
import type { SubscriptionActions } from './useSubscriptionActions.ts'

// The subscriptions, in the order the route sent them: the client neither
// sorts nor filters. One merchant paid from both sides is two rows, so the
// key is the scope and the merchant together.
export default function SubscriptionsList({
  rows,
  actions,
  today,
}: {
  rows: SubscriptionRow[]
  actions: SubscriptionActions
  today: IsoDate
}) {
  return (
    <section aria-label="Subscriptions" className={`${CARD} px-6 py-2`}>
      {rows.length === 0 ? (
        <p className={`${MUTED} py-4`}>No regular charges found for this scope yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row) => (
            <SubscriptionItem
              key={`${row.scope}:${row.merchantKey}`}
              row={row}
              actions={actions}
              today={today}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

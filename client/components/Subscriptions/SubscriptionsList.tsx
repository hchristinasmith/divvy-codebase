import type {
  IsoDate,
  SubscriptionRow,
  SubscriptionStatus,
} from '../../../shared/contracts.ts'
import SubscriptionItem from './SubscriptionItem.tsx'
import { CARD, MUTED } from './styles.ts'
import type { SubscriptionActions } from './useSubscriptionActions.ts'

// The rows with the chosen status (the header's Active / Cancelled switch,
// issue 390), in the order the route sent them: the client filters by status
// and never sorts. One merchant paid from both sides is two rows, so the key
// is the scope and the merchant together. The totals above come from the
// route and do not follow this filter.
const EMPTY: Record<SubscriptionStatus, string> = {
  active: 'No active subscriptions for this scope yet.',
  cancelled: 'No cancelled subscriptions for this scope.',
}

export default function SubscriptionsList({
  rows,
  status,
  actions,
  today,
}: {
  rows: SubscriptionRow[]
  status: SubscriptionStatus
  actions: SubscriptionActions
  today: IsoDate
}) {
  const shown = rows.filter((row) => row.status === status)
  return (
    <section aria-label="Subscriptions" className={`${CARD} px-6 py-2`}>
      {shown.length === 0 ? (
        <p className={`${MUTED} py-4`}>{EMPTY[status]}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((row) => (
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

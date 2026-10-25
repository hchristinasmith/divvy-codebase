import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../Shell/ScreenHeader.tsx'
import { subscriptionsQuery } from '../../apis/subscriptions.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import type { SubscriptionsResponse } from '../../../shared/contracts.ts'
import AdvisorBanner from './AdvisorBanner.tsx'
import NotSubscriptionsCard from './NotSubscriptionsCard.tsx'
import QuestionsCard from './QuestionsCard.tsx'
import SubscriptionsList from './SubscriptionsList.tsx'
import SummaryTiles from './SummaryTiles.tsx'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from './styles.ts'
import { useSubscriptionActions } from './useSubscriptionActions.ts'

// The Subscriptions screen (prd-02 Ruling 14, issue 230; docs/design/
// handoff.md Screen 3): recurring charges found from settled transactions,
// the monthly and yearly totals, the merchants Divvy is unsure about, and
// the ones Hannah said are not subscriptions. Every figure comes from one
// read for the chosen scope (server/routes/subscriptions.ts); this screen
// does no arithmetic.
//
// The read is keyed by scope, so a scope switch shows the loading card until
// that scope's list arrives, never the previous scope's. A failed refetch
// keeps the last list on screen with a banner saying so. The loading, error
// and refetch-error states are the Overview's, re-implemented here.
export default function Subscriptions() {
  const { scope } = useScope()
  const subscriptions = useQuery(subscriptionsQuery(scope))

  return (
    <>
      <ScreenHeader
        title="Subscriptions"
        subtitle="Recurring charges, found automatically"
      />
      {subscriptions.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading your subscriptions…
        </p>
      ) : subscriptions.data === undefined ? (
        <div role="alert" className={`${CARD} flex flex-col items-start gap-3 p-6`}>
          <p className={ERROR}>{subscriptions.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void subscriptions.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {subscriptions.isError && (
            <div
              role="alert"
              className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
            >
              <p className={ERROR}>Couldn&apos;t refresh. Showing the last list.</p>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void subscriptions.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          {/* Keyed by scope, so a switch drops a failed write's message. */}
          <SubscriptionsBody key={scope} data={subscriptions.data} />
        </>
      )}
    </>
  )
}

function SubscriptionsBody({ data }: { data: SubscriptionsResponse }) {
  const actions = useSubscriptionActions()
  return (
    <div className="flex flex-col gap-4">
      <SummaryTiles totals={data.totals} />
      {actions.error !== null && (
        <p role="alert" className={ERROR}>
          {actions.error}
        </p>
      )}
      <SubscriptionsList rows={data.subscriptions} actions={actions} />
      <AdvisorBanner />
      {data.questions.length > 0 && (
        <QuestionsCard questions={data.questions} actions={actions} />
      )}
      {data.notSubscriptions.length > 0 && (
        <NotSubscriptionsCard merchants={data.notSubscriptions} actions={actions} />
      )}
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { overviewQuery } from '../../apis/overview.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import type { OverviewResponse, Scope } from '../../../shared/contracts.ts'
import AccountsCard from './AccountsCard.tsx'
import ActivityCard from './ActivityCard.tsx'
import AlertsCard from './AlertsCard.tsx'
import HeroCard from './HeroCard.tsx'
import MoreLinks from './MoreLinks.tsx'
import SpendingCard from './SpendingCard.tsx'
import TaxCard from './TaxCard.tsx'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from './styles.ts'

// The Overview screen (prd-02, issue 45; docs/design/handoff.md Screen 1 as
// docs/design/CHANGES-2.md §2 lays it out): the safe-to-spend hero and its
// ledger, the account cards, Strawb's tax set-aside, alerts and recent
// activity, all from one overview read for the chosen scope, and spending
// by category (issue 271), which reads its own.
//
// The read is keyed by scope, so a scope switch shows the loading card until
// that scope's numbers arrive, never the previous scope's. A failed refetch
// keeps the last numbers on screen with a banner saying so. The title stays
// "Overview": the prototype's greeting is not used.
//
// `dataAsOf` is not shown here; the header's sync pill owns freshness.
export default function Overview() {
  const { scope } = useScope()
  const overview = useQuery(overviewQuery(scope))

  return (
    <>
      <ScreenHeader title="Overview" />
      {overview.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading your overview…
        </p>
      ) : overview.data === undefined ? (
        <div role="alert" className={`${CARD} flex flex-col items-start gap-3 p-6`}>
          <p className={ERROR}>{overview.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void overview.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {overview.isError && (
            <div
              role="alert"
              className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
            >
              <p className={ERROR}>Couldn&apos;t refresh. Showing the last numbers.</p>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void overview.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          <OverviewBody data={overview.data} scope={scope} />
        </>
      )}
    </>
  )
}

function OverviewBody({
  data,
  scope,
}: {
  data: OverviewResponse
  scope: Scope
}) {
  return (
    <section aria-label="Overview" className="flex flex-col gap-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4.5">
        <HeroCard result={data.safeToSpend} />
        {scope !== 'strawb' && (
          <AccountsCard side="personal" accounts={data.accounts} />
        )}
        {scope !== 'personal' && (
          <AccountsCard side="strawb" accounts={data.accounts} />
        )}
        {scope !== 'personal' && <TaxCard result={data.safeToSpend} />}
      </div>
      <SpendingCard scope={scope} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-4.5">
        {/* Keyed by scope, so a switch drops a failed request's message and
            the sub-filter rather than carrying them into the new scope. */}
        <AlertsCard
          key={`alerts-${scope}`}
          alerts={data.alerts}
          today={data.safeToSpend.today}
        />
        <ActivityCard
          key={`activity-${scope}`}
          rows={data.recentActivity}
          scope={scope}
          today={data.safeToSpend.today}
        />
      </div>
      <MoreLinks />
    </section>
  )
}

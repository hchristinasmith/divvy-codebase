import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { habitsQuery } from '../../apis/habits.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import PatternInsights from '../../components/Insights/PatternInsights.tsx'
import type { HabitsResponse, Scope } from '../../../shared/contracts.ts'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import RunwayCard from './RunwayCard.tsx'
import StreaksCard from './StreaksCard.tsx'
import TruthReportCard from './TruthReportCard.tsx'
import WorthItCard from './WorthItCard.tsx'
import { BOTTOM_GRID, SECTION, SIDE_COLUMN, TOP_GRID } from './styles.ts'

// The Habits screen (prd-02, issue 57; docs/design/handoff.md Screen 5):
// runway, the streaks the data supports and the Worth it? list from one
// read (server/routes/habits.ts), the verdict pills that write to it, the
// Patterns card holding prd-04's insights (PatternInsights, #63), and the
// Weekly truth report pointing to Claude desktop. This screen does no
// arithmetic.
//
// The prototype's projected-date card is not here: the route has no such
// field, as its formula is an open question in prd-02, so it is hidden
// rather than faked.
//
// The read is keyed by scope, so a scope switch shows the loading card until
// that scope's habits arrive, never the previous scope's. A failed refetch
// keeps the last habits on screen with a banner saying so. The states are
// the Bills screen's.
export default function Habits() {
  const { scope } = useScope()
  const habits = useQuery(habitsQuery(scope))

  return (
    <>
      <ScreenHeader title="Habits" subtitle="An honest mirror · last 90 days" />
      {habits.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading your habits…
        </p>
      ) : habits.data === undefined ? (
        <div role="alert" className={`${CARD} flex flex-col items-start gap-3 p-6`}>
          <p className={ERROR}>{habits.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void habits.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {habits.isError && (
            <div
              role="alert"
              className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
            >
              <p className={ERROR}>Couldn&apos;t refresh. Showing the last habits.</p>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void habits.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          {/* Keyed by scope, so a switch drops a failed write's message. */}
          <HabitsBody key={scope} scope={scope} data={habits.data} />
        </>
      )}
    </>
  )
}

function HabitsBody({ scope, data }: { scope: Scope; data: HabitsResponse }) {
  return (
    <div className={SECTION}>
      <div className={TOP_GRID}>
        <RunwayCard runwayTenths={data.runwayTenths} />
        <StreaksCard streaks={data.streaks} />
      </div>
      <div className={BOTTOM_GRID}>
        <WorthItCard rows={data.verdicts} />
        <div className={SIDE_COLUMN}>
          <PatternInsights scope={scope} />
          <TruthReportCard />
        </div>
      </div>
    </div>
  )
}

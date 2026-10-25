import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { goalsQuery } from '../../apis/goals.ts'
import type { GoalsResponse } from '../../../shared/contracts.ts'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import GoalCard from './GoalCard.tsx'
import NewGoalCard from './NewGoalCard.tsx'
import RecordNote from './RecordNote.tsx'
import { GRID, SECTION } from './styles.ts'
import { useContribute, useGoalWritePending } from './useGoalActions.ts'

// The Goals screen (prd-02, issue 56; docs/design/handoff.md Screen 4):
// each goal's saved figure, target, bar and pace from the goals read
// (server/routes/goals.ts), +$50 and +$200 to record a contribution, a card
// to create a goal, and the note that a contribution is a record, not a
// transfer (prd-02 Ruling 5). This screen does no money arithmetic.
//
// No subtitle: the prototype's "Funded from Personal · Savings" names an
// account, and a goal carries none. Goals have no scope, so the toggle in
// the header does not change this list.
//
// A failed refetch keeps the last list on screen with a banner saying so.
// The loading, error and refetch-error states are the Overview's,
// re-implemented here.
export default function Goals() {
  const goals = useQuery(goalsQuery())

  return (
    <>
      <ScreenHeader title="Goals" />
      {goals.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading your goals…
        </p>
      ) : goals.data === undefined ? (
        <div role="alert" className={`${CARD} flex flex-col items-start gap-3 p-6`}>
          <p className={ERROR}>{goals.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void goals.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {goals.isError && (
            <div
              role="alert"
              className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
            >
              <p className={ERROR}>Couldn&apos;t refresh. Showing the last goals.</p>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void goals.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          <GoalsBody data={goals.data} />
        </>
      )}
    </>
  )
}

function GoalsBody({ data }: { data: GoalsResponse }) {
  const { contribute, error } = useContribute()
  const busy = useGoalWritePending()
  return (
    <section aria-label="Goals" className={SECTION}>
      {error !== null && (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      )}
      <div className={GRID}>
        {data.items.length === 0 && (
          <p className={`${CARD} ${MUTED} p-6`}>No goals yet.</p>
        )}
        {data.items.map((goal) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            busy={busy}
            onContribute={contribute}
          />
        ))}
        <NewGoalCard />
      </div>
      <RecordNote />
    </section>
  )
}

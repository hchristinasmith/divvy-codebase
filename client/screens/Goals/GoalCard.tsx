import { formatCents } from '../../../shared/money.ts'
import type { GoalResponse } from '../../../shared/contracts.ts'
import { BAR_FILL } from '../Overview/styles.ts'
import { barPercent } from '../Overview/format.ts'
import { formatByDate, paceLine } from './format.ts'
import {
  BAR,
  BY_DATE,
  GOAL_CARD,
  LARGE_STEP,
  NAME,
  NAME_ROW,
  OF_TARGET,
  PACE,
  SAVED,
  SAVED_ROW,
  SMALL_STEP,
  STEP_ROW,
} from './styles.ts'
import { STEP_LARGE_CENTS, STEP_SMALL_CENTS } from './useGoalActions.ts'

// One goal (docs/design/handoff.md Screen 4): its name and by-date, what is
// saved of the target, a bar, the pace, and the two buttons that record a
// contribution. Every figure is a route field formatted by `formatCents`.
// Each button's accessible name says which goal it records for, since every
// card shows the same "+$50" and "+$200"; "Record" because a contribution
// is a record, not a transfer (prd-02 Ruling 5).
export default function GoalCard({
  goal,
  busy,
  onContribute,
}: {
  goal: GoalResponse
  /** A goal write is in flight: both buttons are disabled. */
  busy: boolean
  onContribute: (id: string, amountCents: number) => void
}) {
  // A display percentage for the bar's width, from the route's cents only;
  // not a money figure, and never shown as one.
  const percent = barPercent(goal.savedCents, goal.targetCents)
  return (
    <article aria-label={goal.name} className={GOAL_CARD}>
      <div className={NAME_ROW}>
        <span data-testid="goal-name" className={NAME}>
          {goal.name}
        </span>
        {goal.targetDate !== null && (
          <span data-testid="goal-by" className={BY_DATE}>
            {formatByDate(goal.targetDate)}
          </span>
        )}
      </div>
      <div className={SAVED_ROW}>
        <span data-testid="goal-saved" className={SAVED}>
          {formatCents(goal.savedCents)}
        </span>
        <span data-testid="goal-target" className={OF_TARGET}>
          of {formatCents(goal.targetCents)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${goal.name}, saved as a share of the target`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={BAR}
      >
        <div className={BAR_FILL} style={{ width: `${percent}%` }} />
      </div>
      <p data-testid="goal-pace" className={PACE}>
        {paceLine(goal)}
      </p>
      <div className={STEP_ROW}>
        <button
          type="button"
          className={SMALL_STEP}
          aria-label={`Record $50 for ${goal.name}`}
          disabled={busy}
          onClick={() => onContribute(goal.id, STEP_SMALL_CENTS)}
        >
          +$50
        </button>
        <button
          type="button"
          className={LARGE_STEP}
          aria-label={`Record $200 for ${goal.name}`}
          disabled={busy}
          onClick={() => onContribute(goal.id, STEP_LARGE_CENTS)}
        >
          +$200
        </button>
      </div>
    </article>
  )
}

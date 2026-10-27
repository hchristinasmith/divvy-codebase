import { useState } from 'react'
import { formatCents } from '../../../shared/money.ts'
import type { BudgetResponse } from '../../../shared/contracts.ts'
import { ERROR, SECONDARY_BUTTON } from '../Overview/styles.ts'
import { barPercent } from '../Overview/format.ts'
import { DANGER_BUTTON, TEXT_BUTTON } from '../Bills/styles.ts'
import { canStepDown, stepLimit } from './fields.ts'
import { budgetTone, statusLabel } from './format.ts'
import {
  BAR,
  BUDGET_CARD,
  CONFIRM_ROW,
  CONFIRM_TEXT,
  FOOT_ROW,
  NAME,
  NAME_ROW,
  NOTE,
  OF_LIMIT,
  SPENT,
  SPENT_ROW,
  STEP_BUTTON,
  STEP_ROW,
  fillClass,
  statusClass,
} from './styles.ts'
import { useBudgetWrite } from './useBudgetActions.ts'

// One budget (docs/design/handoff.md Screen 2): its category, its status,
// what is spent of the limit, a bar, the note, and − / + to move the limit
// by $10. Every figure is a route field formatted by `formatCents`, and the
// status is the route's: over when `overCents > 0`, else what is left.
// Delete asks first, as the Bills form does. Each button's accessible name
// says which budget it acts on, since every card shows the same − and +.
export default function BudgetCard({
  budget,
  busy,
  onStep,
}: {
  budget: BudgetResponse
  /** A budget write is in flight: every button is disabled. */
  busy: boolean
  onStep: (id: string, limitCents: number) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const remove = useBudgetWrite()
  const tone = budgetTone(budget)
  // A display percentage for the bar's width, from the route's cents only;
  // not a money figure, and never shown as one.
  const percent = barPercent(budget.spentCents, budget.limitCents)
  const name = budget.category

  return (
    <article aria-label={name} data-budget-id={budget.id} className={BUDGET_CARD}>
      <div className={NAME_ROW}>
        <span data-testid="budget-name" className={NAME}>
          {name}
        </span>
        <span
          data-testid="budget-status"
          data-tone={tone}
          className={statusClass(tone)}
        >
          {statusLabel(budget)}
        </span>
      </div>
      <div className={SPENT_ROW}>
        <span data-testid="budget-spent" className={SPENT}>
          {formatCents(budget.spentCents)}
        </span>
        <span data-testid="budget-limit" className={OF_LIMIT}>
          of {formatCents(budget.limitCents)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${name}, spent as a share of the limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={BAR}
      >
        <div
          data-testid="budget-fill"
          className={fillClass(tone)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className={FOOT_ROW}>
        <p data-testid="budget-note" className={NOTE}>
          {budget.note ?? ''}
        </p>
        <div className={STEP_ROW}>
          <button
            type="button"
            className={STEP_BUTTON}
            aria-label={`Lower the ${name} limit by $10`}
            disabled={busy || !canStepDown(budget.limitCents)}
            onClick={() => onStep(budget.id, stepLimit(budget.limitCents, 'down'))}
          >
            −
          </button>
          <button
            type="button"
            className={STEP_BUTTON}
            aria-label={`Raise the ${name} limit by $10`}
            disabled={busy}
            onClick={() => onStep(budget.id, stepLimit(budget.limitCents, 'up'))}
          >
            +
          </button>
        </div>
      </div>
      {remove.error !== null && (
        <p role="alert" className={ERROR}>
          {remove.error}
        </p>
      )}
      {confirming ? (
        <div className={CONFIRM_ROW}>
          <p className={CONFIRM_TEXT}>{`Delete the “${name}” budget?`}</p>
          <button
            type="button"
            className={DANGER_BUTTON}
            disabled={busy}
            onClick={() => remove.run({ kind: 'delete', id: budget.id }, () => {})}
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              remove.reset()
            }}
          >
            Keep
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className={TEXT_BUTTON}
            aria-label={`Delete the ${name} budget`}
            disabled={busy}
            onClick={() => {
              setConfirming(true)
              remove.reset()
            }}
          >
            Delete
          </button>
        </div>
      )}
    </article>
  )
}

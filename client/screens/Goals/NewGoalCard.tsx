import { useState } from 'react'
import GoalForm from './GoalForm.tsx'
import { GOAL_CARD, NEW_GOAL_CARD, NEW_GOAL_HINT, NEW_GOAL_TITLE } from './styles.ts'

// The prototype's dashed "New goal" card, which opens the form in its place.
// Goals are created in the app (prd-02, issue 56), so the prototype's "Set
// one with the advisor" becomes "Set a target and a by-date".
export default function NewGoalCard() {
  const [open, setOpen] = useState(false)
  if (open) {
    return (
      <div className={GOAL_CARD}>
        <GoalForm onClose={() => setOpen(false)} />
      </div>
    )
  }
  return (
    <button type="button" className={NEW_GOAL_CARD} onClick={() => setOpen(true)}>
      <span className={NEW_GOAL_TITLE}>New goal</span>
      <span className={NEW_GOAL_HINT}>Set a target and a by-date</span>
    </button>
  )
}

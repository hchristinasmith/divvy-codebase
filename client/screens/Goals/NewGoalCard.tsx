import { useEffect, useRef, useState } from 'react'
import GoalForm from './GoalForm.tsx'
import { GOAL_CARD, NEW_GOAL_CARD, NEW_GOAL_HINT, NEW_GOAL_TITLE } from './styles.ts'

// The prototype's dashed "New goal" card, which opens the form in its place.
// Goals are created in the app (prd-02, issue 56), so the prototype's "Set
// one with the advisor" becomes "Set a target and a by-date".
//
// Closing the form (Cancel, or a save that landed) puts focus back on this
// button, since the control that had it is gone. The first render does not
// take focus.
export default function NewGoalCard() {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const closed = useRef(false)

  useEffect(() => {
    if (!open && closed.current) {
      closed.current = false
      button.current?.focus()
    }
  }, [open])

  function close() {
    closed.current = true
    setOpen(false)
  }

  if (open) {
    return (
      <div className={GOAL_CARD}>
        <GoalForm onClose={close} />
      </div>
    )
  }
  return (
    <button
      ref={button}
      type="button"
      className={NEW_GOAL_CARD}
      onClick={() => setOpen(true)}
    >
      <span className={NEW_GOAL_TITLE}>New goal</span>
      <span className={NEW_GOAL_HINT}>Set a target and a by-date</span>
    </button>
  )
}

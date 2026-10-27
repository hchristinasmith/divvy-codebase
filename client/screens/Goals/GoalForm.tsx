import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CARD_TITLE, ERROR, SECONDARY_BUTTON } from '../Overview/styles.ts'
import Field from './Field.tsx'
import { checkDraft, emptyDraft, type Draft, type DraftErrors } from './fields.ts'
import {
  BUTTON_ROW,
  FORM,
  FORM_GRID,
  NUMBER_INPUT,
  PRIMARY_BUTTON,
  TEXT_INPUT,
} from './styles.ts'
import { useCreateGoal, useGoalWritePending } from './useGoalActions.ts'

// Create a goal in the app (issue 56; the prototype's "Set one with the
// advisor" is replaced). What is typed stays text until Save and becomes
// cents only through ./fields.ts. A refusal shows the server's own message
// and keeps what was typed. The form closes once the write and the refetch
// after it have landed, so the new card is already on screen. The form
// opens with focus in Name, because the button that opened it is gone.
export default function GoalForm({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [errors, setErrors] = useState<DraftErrors>({})
  const write = useCreateGoal()
  const busy = useGoalWritePending()
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  function edit(fields: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...fields }))
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(fields)) {
        if (key === 'name' || key === 'target' || key === 'targetDate') {
          delete next[key]
        }
      }
      return next
    })
    if (write.error !== null) write.reset()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const checked = checkDraft(draft)
    if ('errors' in checked) {
      setErrors(checked.errors)
      return
    }
    setErrors({})
    write.run(checked.request, onClose)
  }

  return (
    <form aria-label="New goal" noValidate className={FORM} onSubmit={submit}>
      <h2 className={`${CARD_TITLE} text-ink`}>New goal</h2>
      <div className={FORM_GRID}>
        <Field label="Name" error={errors.name}>
          {(control) => (
            <input
              {...control}
              ref={nameInput}
              type="text"
              className={TEXT_INPUT}
              value={draft.name}
              disabled={busy}
              onChange={(event) => edit({ name: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="Target ($)"
          hint="In dollars, like 1500.00."
          error={errors.target}
        >
          {(control) => (
            <input
              {...control}
              type="text"
              inputMode="decimal"
              className={NUMBER_INPUT}
              value={draft.target}
              disabled={busy}
              onChange={(event) => edit({ target: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="By-date"
          hint="Optional. Without one there is no monthly pace."
          error={errors.targetDate}
        >
          {(control) => (
            <input
              {...control}
              type="date"
              className={NUMBER_INPUT}
              value={draft.targetDate}
              disabled={busy}
              onChange={(event) => edit({ targetDate: event.target.value })}
            />
          )}
        </Field>
      </div>
      {write.error !== null && (
        <p role="alert" className={ERROR}>
          {write.error}
        </p>
      )}
      <div className={BUTTON_ROW}>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
          {write.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

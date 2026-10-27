import { useId } from 'react'
import type { ReactNode } from 'react'
import { FIELD_ERROR, HINT, LABEL } from '../Settings/styles.ts'

// A labelled form control with its hint and error. The same wiring as
// `TextField` and `SelectField` in client/screens/Settings/SettingsForm.tsx,
// which are private to that file: the control gets the label's id, says it
// is invalid, and is described by its error first, then its hint.

export interface ControlProps {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': boolean
}

export default function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: (control: ControlProps) => ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [
    error === undefined ? null : errorId,
    hint === undefined ? null : hintId,
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': error !== undefined,
      })}
      {error !== undefined && (
        <p id={errorId} role="alert" className={FIELD_ERROR}>
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p id={hintId} className={HINT}>
          {hint}
        </p>
      )}
    </div>
  )
}

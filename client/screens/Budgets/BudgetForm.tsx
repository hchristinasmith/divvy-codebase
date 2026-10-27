import { useState } from 'react'
import type { FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { categoriesQuery } from '../../apis/overview.ts'
import { isDrawingCategory } from '../../../shared/drawings.ts'
import type { RowScope, Scope } from '../../../shared/contracts.ts'
import { CARD_TITLE, ERROR, SECONDARY_BUTTON } from '../Overview/styles.ts'
import Field from '../Bills/Field.tsx'
import { scopeLabel } from '../Bills/format.ts'
import {
  BUTTON_ROW,
  FORM,
  FORM_GRID,
  INPUT,
  PRIMARY_BUTTON,
  SELECT as WORDS_FIELD,
} from '../Bills/styles.ts'
import { checkDraft, emptyDraft, type Draft, type DraftErrors } from './fields.ts'
import { useBudgetWrite, useBudgetWritePending } from './useBudgetActions.ts'

// Add a budget (issue 53): a category from the server's list, a weekly
// limit in dollars, an optional note, and the scope when the screen shows
// both. What is typed stays text until Save and becomes cents only through
// ./fields.ts. A refusal (a duplicate is 409) shows the server's own message
// and keeps what was typed. The form closes once the write and the refetch
// after it have landed, so the new card is already on screen.
//
// Drawings is left out of the picker: the server refuses a budget on it,
// since Drawings is never spending (prd-02 Ruling 15).

function toRowScope(value: string): RowScope {
  return value === 'strawb' ? 'strawb' : 'personal'
}

export default function BudgetForm({
  scope,
  onClose,
}: {
  scope: Scope
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    emptyDraft(scope === 'all' ? 'personal' : scope),
  )
  const [errors, setErrors] = useState<DraftErrors>({})
  const write = useBudgetWrite()
  const busy = useBudgetWritePending()
  const categories = useQuery(categoriesQuery)

  function edit(fields: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...fields }))
    setErrors((current) => {
      const next = { ...current }
      if ('category' in fields) delete next.category
      if ('limit' in fields) delete next.limit
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
    write.run({ kind: 'create', body: checked }, onClose)
  }

  const groups = (categories.data ?? [])
    .map((group) => ({
      name: group.name,
      categories: group.categories.filter((name) => !isDrawingCategory(name)),
    }))
    .filter((group) => group.categories.length > 0)

  return (
    <form aria-label="Add a budget" noValidate className={FORM} onSubmit={submit}>
      <h2 className={CARD_TITLE}>Add a budget</h2>
      <div className={FORM_GRID}>
        <Field label="Category" error={errors.category}>
          {(control) => (
            <select
              {...control}
              className={WORDS_FIELD}
              value={draft.category}
              disabled={busy || categories.isPending}
              onChange={(event) => edit({ category: event.target.value })}
            >
              <option value="">
                {categories.isPending ? 'Loading categories…' : 'Choose a category'}
              </option>
              {groups.map((group) => (
                <optgroup key={group.name} label={group.name}>
                  {group.categories.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Limit ($)"
          hint="Per week, from payday. In dollars, like 120.00."
          error={errors.limit}
        >
          {(control) => (
            <input
              {...control}
              type="text"
              inputMode="decimal"
              className={INPUT}
              value={draft.limit}
              disabled={busy}
              onChange={(event) => edit({ limit: event.target.value })}
            />
          )}
        </Field>
        <Field label="Note" hint="Optional.">
          {(control) => (
            <input
              {...control}
              type="text"
              className={WORDS_FIELD}
              value={draft.note}
              disabled={busy}
              onChange={(event) => edit({ note: event.target.value })}
            />
          )}
        </Field>
        {scope === 'all' && (
          <Field label="Scope">
            {(control) => (
              <select
                {...control}
                className={WORDS_FIELD}
                value={draft.scope}
                disabled={busy}
                onChange={(event) => edit({ scope: toRowScope(event.target.value) })}
              >
                <option value="personal">Personal</option>
                <option value="strawb">Strawb</option>
              </select>
            )}
          </Field>
        )}
      </div>
      {scope !== 'all' && (
        <p className="m-0 text-body-13 text-ink-muted">
          {`Added to ${scopeLabel(draft.scope)} budgets`}
        </p>
      )}
      {categories.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className={ERROR}>
            Categories could not be loaded: {categories.error.message}
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void categories.refetch()}
          >
            Try again
          </button>
        </div>
      )}
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

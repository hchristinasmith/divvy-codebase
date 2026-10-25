import { useState } from 'react'
import type { FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { billAccountsQuery } from '../../apis/bills.ts'
import type {
  BillResponse,
  RowScope,
  Scope,
} from '../../../shared/contracts.ts'
import { CARD_TITLE, ERROR, SECONDARY_BUTTON } from '../Overview/styles.ts'
import Field from './Field.tsx'
import {
  ACCOUNT_DEFAULT,
  ACCOUNT_DETACH,
  billPatch,
  checkDraft,
  createRequest,
  draftFromBill,
  emptyDraft,
  sameDraft,
  type Draft,
  type DraftErrors,
} from './fields.ts'
import { REPEAT_LABELS, REPEAT_OPTIONS, scopeLabel, toRepeat } from './format.ts'
import {
  BUTTON_ROW,
  DANGER_BUTTON,
  FORM,
  FORM_GRID,
  INPUT,
  PRIMARY_BUTTON,
  SELECT as WORDS_FIELD,
  TEXT_BUTTON,
} from './styles.ts'
import { useBillWrite, useBillWritePending } from './useBillActions.ts'

// Add a bill, or edit one in place of its row (issue 54). What is typed
// stays text until Save and becomes cents only through ./fields.ts. A
// refusal shows the server's own message and keeps what was typed. The form
// closes once the write and the refetch after it have landed, so the new or
// changed row is already on screen.
//
// The bill response names its account but carries no account id, so the
// edit form cannot preselect it: it offers "keep current", "no account" or
// another account, and sends `accountId` only when that changes. For the
// same reason it cannot move a bill to the other scope.

export type FormMode =
  | { kind: 'add'; scope: Scope }
  | { kind: 'edit'; bill: BillResponse }

function startingDraft(mode: FormMode): Draft {
  if (mode.kind === 'edit') return draftFromBill(mode.bill)
  return emptyDraft(mode.scope === 'all' ? 'personal' : mode.scope)
}

function toRowScope(value: string): RowScope {
  return value === 'strawb' ? 'strawb' : 'personal'
}

export default function BillForm({
  mode,
  onClose,
}: {
  mode: FormMode
  onClose: () => void
}) {
  const [start] = useState(() => startingDraft(mode))
  const [draft, setDraft] = useState(start)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [confirming, setConfirming] = useState(false)
  const write = useBillWrite()
  const busy = useBillWritePending()
  const accounts = useQuery(billAccountsQuery)
  const bill = mode.kind === 'edit' ? mode.bill : null
  const changed = !sameDraft(draft, start)

  function edit(fields: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...fields }))
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(fields)) {
        if (key === 'name' || key === 'amount' || key === 'firstDueDate') {
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
    if (bill === null) {
      write.run({ kind: 'create', body: createRequest(checked, draft) }, onClose)
      return
    }
    const patch = billPatch(bill, checked, draft)
    // "1200" for "1200.00" is a change of text, not of the bill.
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    write.run({ kind: 'update', id: bill.id, patch }, onClose)
  }

  const title = bill === null ? 'Add a bill' : `Edit ${bill.name}`
  const options =
    accounts.data?.items.filter((account) => account.scope === draft.scope) ?? []

  return (
    <form
      aria-label={title}
      noValidate
      className={FORM}
      onSubmit={submit}
    >
      <h2 className={CARD_TITLE}>{bill === null ? 'Add a bill' : 'Edit bill'}</h2>
      <div className={FORM_GRID}>
        <Field label="Name" error={errors.name}>
          {(control) => (
            <input
              {...control}
              type="text"
              className={WORDS_FIELD}
              value={draft.name}
              disabled={busy}
              onChange={(event) => edit({ name: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="Amount ($)"
          hint="In dollars, like 1200.00."
          error={errors.amount}
        >
          {(control) => (
            <input
              {...control}
              type="text"
              inputMode="decimal"
              className={INPUT}
              value={draft.amount}
              disabled={busy}
              onChange={(event) => edit({ amount: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="First due date"
          hint="The first time it falls due. A repeating bill's later dates follow from this one."
          error={errors.firstDueDate}
        >
          {(control) => (
            <input
              {...control}
              type="date"
              className={INPUT}
              value={draft.firstDueDate}
              disabled={busy}
              onChange={(event) => edit({ firstDueDate: event.target.value })}
            />
          )}
        </Field>
        <Field label="Repeat">
          {(control) => (
            <select
              {...control}
              className={WORDS_FIELD}
              value={draft.repeat}
              disabled={busy}
              onChange={(event) => {
                const repeat = toRepeat(event.target.value)
                if (repeat !== null) edit({ repeat })
              }}
            >
              {REPEAT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {REPEAT_LABELS[option]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {mode.kind === 'add' && mode.scope === 'all' && (
          <Field label="Scope">
            {(control) => (
              <select
                {...control}
                className={WORDS_FIELD}
                value={draft.scope}
                disabled={busy}
                onChange={(event) =>
                  // Accounts belong to one scope, so the choice starts over.
                  edit({
                    scope: toRowScope(event.target.value),
                    account: ACCOUNT_DEFAULT,
                  })
                }
              >
                <option value="personal">Personal</option>
                <option value="strawb">Strawb</option>
              </select>
            )}
          </Field>
        )}
        <Field label="Paid from">
          {(control) => (
            <select
              {...control}
              className={WORDS_FIELD}
              value={draft.account}
              disabled={busy || accounts.isPending}
              onChange={(event) => edit({ account: event.target.value })}
            >
              {accounts.isPending ? (
                <option value={ACCOUNT_DEFAULT}>Loading accounts…</option>
              ) : (
                <>
                  <option value={ACCOUNT_DEFAULT}>
                    {bill === null || bill.accountName === null
                      ? 'No account'
                      : `Keep current (${bill.accountName})`}
                  </option>
                  {bill !== null && bill.accountName !== null && (
                    <option value={ACCOUNT_DETACH}>No account</option>
                  )}
                  {options.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </>
              )}
            </select>
          )}
        </Field>
      </div>
      {mode.kind === 'add' && mode.scope !== 'all' && (
        <p className="m-0 text-body-13 text-ink-muted">
          {`Added to ${scopeLabel(draft.scope)} bills`}
        </p>
      )}
      {accounts.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className={ERROR}>
            Accounts could not be loaded: {accounts.error.message}
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void accounts.refetch()}
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
      {confirming && bill !== null ? (
        <div className={BUTTON_ROW}>
          <p className="m-0 text-body-14 text-ink">
            {`Delete “${bill.name}”? This can't be undone.`}
          </p>
          <button
            type="button"
            className={DANGER_BUTTON}
            disabled={busy}
            onClick={() => write.run({ kind: 'delete', id: bill.id }, onClose)}
          >
            {write.isPending ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              write.reset()
            }}
          >
            Keep
          </button>
        </div>
      ) : (
        <div className={BUTTON_ROW}>
          <button
            type="submit"
            className={PRIMARY_BUTTON}
            disabled={busy || (bill !== null && !changed)}
          >
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
          {bill !== null && (
            <button
              type="button"
              className={TEXT_BUTTON}
              disabled={busy}
              onClick={() => {
                setConfirming(true)
                write.reset()
              }}
            >
              Delete bill
            </button>
          )}
        </div>
      )}
    </form>
  )
}

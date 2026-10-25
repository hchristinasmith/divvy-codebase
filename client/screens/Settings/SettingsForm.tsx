import { useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { grabSettings, updateSettings } from '../../apis/settings.ts'
import { invalidateOverview, queryKeys } from '../../apis/queryKeys.ts'
import {
  CURRENCY_SYMBOLS,
  type CurrencySymbol,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '../../../shared/contracts.ts'
import {
  basisPointsToPercentField,
  centsToDollarsField,
  parseDollarsField,
  parsePercentField,
} from './fields.ts'
import {
  CARD,
  ERROR,
  FIELD_ERROR,
  HEADING,
  HINT,
  INPUT,
  LABEL,
  PRIMARY_BUTTON,
} from './styles.ts'

// The settings the safe-to-spend hero reads (issue 46; prd-02 Rulings 9 and
// 11): the tax rate on Strawb's profit, Strawb's profit year to date, the
// payday weekday, the personal income tax owed, and the currency symbol.
// What is typed stays text until Save, and becomes cents and basis points
// only through ./fields.ts.

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

interface Draft {
  taxRate: string
  profit: string
  payday: string
  personalTaxOwed: string
  currency: CurrencySymbol
}

type DraftErrors = Partial<
  Record<'taxRate' | 'profit' | 'personalTaxOwed', string>
>

function toDraft(settings: SettingsResponse): Draft {
  return {
    taxRate: basisPointsToPercentField(settings.taxRateBasisPoints),
    profit: centsToDollarsField(settings.profitCents),
    payday: String(settings.paydayWeekday),
    personalTaxOwed: centsToDollarsField(settings.personalTaxOwedCents),
    currency: settings.currency,
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.taxRate === b.taxRate &&
    a.profit === b.profit &&
    a.payday === b.payday &&
    a.personalTaxOwed === b.personalTaxOwed &&
    a.currency === b.currency
  )
}

export default function SettingsForm() {
  const settings = useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: grabSettings,
  })

  return (
    <section className={CARD} aria-labelledby="settings-money-heading">
      <h2 id="settings-money-heading" className={HEADING}>
        Tax and payday
      </h2>
      {settings.isPending ? (
        <p className={HINT}>Loading settings…</p>
      ) : settings.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className={ERROR}>
            Settings could not be loaded: {settings.error.message}
          </p>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            onClick={() => void settings.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <SettingsFields settings={settings.data} />
      )}
    </section>
  )
}

function SettingsFields({ settings }: { settings: SettingsResponse }) {
  const queryClient = useQueryClient()
  const [server, setServer] = useState(settings)
  const [draft, setDraft] = useState(() => toDraft(settings))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saved, setSaved] = useState(false)

  const mutation = useMutation({
    mutationFn: updateSettings,
    onMutate: () => setSaved(false),
    onSuccess: async (data) => {
      setServer(data)
      setDraft(toDraft(data))
      setSaved(true)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.all }),
        invalidateOverview(queryClient),
      ])
    },
  })

  function edit(change: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...change }))
    setSaved(false)
    if (mutation.isError) mutation.reset()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const taxRate = parsePercentField(draft.taxRate)
    const profit = parseDollarsField(draft.profit)
    const personalTaxOwed = parseDollarsField(draft.personalTaxOwed)

    const found: DraftErrors = {}
    if ('error' in taxRate) found.taxRate = taxRate.error
    if ('error' in profit) found.profit = profit.error
    if ('error' in personalTaxOwed)
      found.personalTaxOwed = personalTaxOwed.error
    setErrors(found)
    if ('error' in taxRate || 'error' in profit || 'error' in personalTaxOwed) {
      return
    }

    // Only what changed from what the server last said.
    const patch: UpdateSettingsRequest = {}
    const payday = Number(draft.payday)
    if (taxRate.value !== server.taxRateBasisPoints) {
      patch.taxRateBasisPoints = taxRate.value
    }
    if (profit.value !== server.profitCents) patch.profitCents = profit.value
    if (payday !== server.paydayWeekday) patch.paydayWeekday = payday
    if (personalTaxOwed.value !== server.personalTaxOwedCents) {
      patch.personalTaxOwedCents = personalTaxOwed.value
    }
    if (draft.currency !== server.currency) patch.currency = draft.currency

    if (Object.keys(patch).length === 0) {
      setDraft(toDraft(server))
      return
    }
    mutation.mutate(patch)
  }

  const unchanged = sameDraft(draft, toDraft(server))

  return (
    <form className="mt-5 flex flex-col gap-5" onSubmit={submit} noValidate>
      <TextField
        label="Tax rate (%)"
        hint="Applies to Strawb's profit only."
        value={draft.taxRate}
        error={errors.taxRate}
        onChange={(taxRate) => edit({ taxRate })}
      />
      <TextField
        label="Strawb profit, year to date ($)"
        hint="Xero will supply this once it is connected. Until then, type it in."
        value={draft.profit}
        error={errors.profit}
        onChange={(profit) => edit({ profit })}
      />
      <SelectField
        label="Payday"
        hint="Every week, on this day."
        value={draft.payday}
        onChange={(payday) => edit({ payday })}
      >
        {WEEKDAYS.map((day, index) => (
          <option key={day} value={String(index)}>
            {day}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Personal income tax owed ($)"
        hint="What you owe Inland Revenue. No rate is applied."
        value={draft.personalTaxOwed}
        error={errors.personalTaxOwed}
        onChange={(personalTaxOwed) => edit({ personalTaxOwed })}
      />
      <SelectField
        label="Currency symbol"
        value={draft.currency}
        onChange={(currency) => {
          const symbol = CURRENCY_SYMBOLS.find((s) => s === currency)
          if (symbol !== undefined) edit({ currency: symbol })
        }}
      >
        {CURRENCY_SYMBOLS.map((symbol) => (
          <option key={symbol} value={symbol}>
            {symbol}
          </option>
        ))}
      </SelectField>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className={PRIMARY_BUTTON}
          disabled={unchanged || mutation.isPending}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
        {mutation.isError && (
          <p role="alert" className={ERROR}>
            {mutation.error.message}
          </p>
        )}
        {saved && (
          <p role="status" className="text-body-13 font-semibold text-ok">
            Saved
          </p>
        )}
      </div>
    </form>
  )
}

function TextField({
  label,
  hint,
  value,
  error,
  onChange,
}: {
  label: string
  hint: string
  value: string
  error: string | undefined
  onChange: (value: string) => void
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        className={INPUT}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? hintId : `${errorId} ${hintId}`}
        onChange={(event) => onChange(event.target.value)}
      />
      {error !== undefined && (
        <p id={errorId} role="alert" className={FIELD_ERROR}>
          {error}
        </p>
      )}
      <p id={hintId} className={HINT}>
        {hint}
      </p>
    </div>
  )
}

function SelectField({
  label,
  hint,
  value,
  onChange,
  children,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <select
        id={id}
        className={INPUT}
        value={value}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      {hint !== undefined && (
        <p id={hintId} className={HINT}>
          {hint}
        </p>
      )}
    </div>
  )
}

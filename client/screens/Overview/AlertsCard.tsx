import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { dismissOverviewAlert } from '../../apis/overview.ts'
import { invalidateOverview } from '../../apis/queryKeys.ts'
import { formatCents } from '../../../shared/money.ts'
import type { Alert, IsoDate } from '../../../shared/contracts.ts'
import { formatDay } from './format.ts'
import { CARD, CARD_TITLE, ERROR, FOCUS, LINK, MUTED } from './styles.ts'

// Open alerts (docs/design/handoff.md Screen 1 and "Interactions"): a
// coloured dot, what is wrong, a link to where it is fixed, and a dismiss.
// The list is the route's; a dismissal is sent to the server and the row
// goes only when the refetched list no longer has it, never before
// (no optimistic removal), so the list and the nav badge always agree.

const DOTS: Record<Alert['kind'], string> = {
  over_budget: 'bg-danger',
  bill_due_soon: 'bg-warn',
  bill_overdue: 'bg-warn',
  // The totals are missing this bill.
  bill_too_many_unpaid: 'bg-danger',
}

function alertText(alert: Alert, today: IsoDate): string {
  const amount = formatCents(alert.amountCents)
  const due = alert.dueDate === null ? '' : formatDay(alert.dueDate, today)
  switch (alert.kind) {
    case 'over_budget':
      return `${alert.subject} is ${amount} over budget.`
    case 'bill_due_soon':
      return `${alert.subject} (${amount}) is due ${due}.`
    case 'bill_overdue':
      return `${alert.subject} (${amount}) is overdue, due ${due}.`
    case 'bill_too_many_unpaid':
      return `${alert.subject} (${amount}) has too many unpaid occurrences and is left out of the totals.`
  }
}

function alertAction(alert: Alert): { label: string; to: string } {
  return alert.kind === 'over_budget'
    ? { label: 'See budget', to: '/budgets' }
    : { label: 'View bills', to: '/bills' }
}

export default function AlertsCard({
  alerts,
  today,
}: {
  alerts: Alert[]
  today: IsoDate
}) {
  const client = useQueryClient()
  const dismiss = useMutation({
    mutationFn: dismissOverviewAlert,
    // Returned, so the dismissal stays pending until the refetch lands.
    onSuccess: () => invalidateOverview(client),
  })

  return (
    <section
      aria-labelledby="alerts-heading"
      className={`${CARD} flex flex-col gap-3 p-6`}
    >
      <div className="flex items-center justify-between">
        <h2 id="alerts-heading" className={`${CARD_TITLE} text-ink`}>
          Alerts
        </h2>
        <span data-testid="alerts-open" className="text-body-12 text-ink-muted">
          {alerts.length > 0 ? `${alerts.length} open` : ''}
        </span>
      </div>
      {dismiss.isError && (
        <p role="alert" className={ERROR}>
          {dismiss.error.message}
        </p>
      )}
      {alerts.length === 0 ? (
        <p className={`${MUTED} py-3`}>All clear. Nothing needs you right now.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {alerts.map((alert) => {
            const text = alertText(alert, today)
            const action = alertAction(alert)
            const busy = dismiss.isPending && dismiss.variables === alert.id
            return (
              <li
                key={alert.id}
                data-alert-id={alert.id}
                className="flex items-start gap-3 border-t border-divider py-2.5"
              >
                <span
                  data-alert-kind={alert.kind}
                  className={`mt-1.5 h-2 w-2 flex-none rounded-full ${DOTS[alert.kind]}`}
                />
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-body-14 leading-[1.35] text-ink">
                    {text}
                  </span>
                  <Link to={action.to} className={`${LINK} text-body-12`}>
                    {action.label}
                  </Link>
                </div>
                <button
                  type="button"
                  aria-label={`Dismiss: ${text}`}
                  disabled={busy}
                  onClick={() => dismiss.mutate(alert.id)}
                  className={`cursor-pointer bg-transparent px-1 py-0.5 text-[16px] leading-none text-ink-faint hover:text-ink disabled:cursor-not-allowed ${FOCUS}`}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

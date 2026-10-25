import { formatCents } from '../../../shared/money.ts'
import type { SubscriptionRow } from '../../../shared/contracts.ts'
import SideChip from './SideChip.tsx'
import { cadenceLabel, cycleLabel, formatDay, plural } from './format.ts'
import { FOCUS } from './styles.ts'
import type { SubscriptionActions } from './useSubscriptionActions.ts'

// One subscription row (docs/design/handoff.md Screen 3): the name and
// which side pays, a meta line, the latest charge with its cycle, and the
// Cancel toggle. Every figure is a route field passed to `formatCents`.
//
// Cancelling records the date only; nothing is sent to the merchant or the
// bank. A cancelled row is dimmed and struck through, and its button undoes
// the cancel. A charge after the cancel date makes the row active again,
// and a warning line says when it landed.

function metaLine(row: SubscriptionRow): string {
  const parts = [
    cadenceLabel(row.cadence),
    `Last charged ${formatDay(row.lastChargedOn)}`,
    plural(row.chargeCount, 'charge'),
    row.marked ? 'You marked it' : 'Found automatically',
  ]
  // A weekly or yearly charge, as the route counts it in the monthly total.
  if (
    row.status === 'active' &&
    row.cadence !== 'monthly' &&
    row.perMonthCents !== null
  ) {
    parts.push(`counts as ${formatCents(row.perMonthCents)} a month`)
  }
  if (row.status === 'cancelled' && row.cancelledOn !== null) {
    parts.push(`Cancelled ${formatDay(row.cancelledOn)}`)
  }
  return parts.join(' · ')
}

const TEXT_BUTTON = `self-start cursor-pointer bg-transparent p-0 text-body-12 font-semibold text-deep hover:text-rose hover:underline disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

const TOGGLE = `cursor-pointer rounded-pill px-3.5 py-[7px] text-body-12 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

export default function SubscriptionItem({
  row,
  actions,
}: {
  row: SubscriptionRow
  actions: SubscriptionActions
}) {
  const cancelled = row.status === 'cancelled'
  const target = { scope: row.scope, merchantKey: row.merchantKey }

  return (
    <li
      data-merchant={`${row.scope}:${row.merchantKey}`}
      className={`grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-divider py-3.5 last:border-b-0 ${
        cancelled ? 'opacity-55' : ''
      }`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="subscription-name"
            className={`text-body-15 font-semibold text-ink ${cancelled ? 'line-through' : ''}`}
          >
            {row.name}
          </span>
          <SideChip scope={row.scope} />
        </div>
        <span data-testid="subscription-meta" className="text-body-12 text-ink-muted">
          {metaLine(row)}
        </span>
        {row.chargedAgainOn !== null && (
          <span className="text-body-12 text-warn">
            {`Charged again on ${formatDay(row.chargedAgainOn)} after you cancelled`}
          </span>
        )}
        {row.detected ? (
          // Clearing her answer would leave a detected row listed, so the
          // way out is to say it is not one.
          <button
            type="button"
            className={TEXT_BUTTON}
            aria-label={`Not a subscription: ${row.name}`}
            disabled={actions.isPending}
            onClick={() => actions.mark(target, 'not_subscription')}
          >
            Not a subscription
          </button>
        ) : (
          row.marked && (
            // Listed only because she said so: the exact inverse of her mark.
            <button
              type="button"
              className={TEXT_BUTTON}
              aria-label={`Unmark ${row.name}`}
              disabled={actions.isPending}
              onClick={() => actions.mark(target, null)}
            >
              Unmark
            </button>
          )
        )}
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span data-testid="subscription-amount" className="font-mono text-body-15 text-ink">
          {formatCents(row.amountCents)}
        </span>
        <span className="text-body-11 text-ink-muted">{cycleLabel(row.cadence)}</span>
      </div>
      {cancelled ? (
        <button
          type="button"
          className={`${TOGGLE} bg-surface text-ink-muted`}
          aria-label={`Cancelled ${row.name}, undo`}
          disabled={actions.isPending}
          onClick={() => actions.uncancel(target)}
        >
          Cancelled
        </button>
      ) : (
        <button
          type="button"
          className={`${TOGGLE} bg-blush text-rose hover:bg-blush-hover`}
          aria-label={`Cancel ${row.name}`}
          disabled={actions.isPending}
          onClick={() => actions.cancel(target)}
        >
          Cancel
        </button>
      )}
    </li>
  )
}

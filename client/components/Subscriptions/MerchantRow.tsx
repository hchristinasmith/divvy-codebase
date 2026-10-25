import type { ReactNode } from 'react'
import { formatCents } from '../../../shared/money.ts'
import type { SubscriptionMerchant } from '../../../shared/contracts.ts'
import SideChip from './SideChip.tsx'
import { formatDay, plural } from './format.ts'

// A merchant that is not in the list, in the "Is this a subscription?" and
// "Not subscriptions" cards: its name and side, when it last charged and how
// often, and its latest charge. The buttons are the card's.
export default function MerchantRow({
  merchant,
  children,
}: {
  merchant: SubscriptionMerchant
  children: ReactNode
}) {
  return (
    <li
      data-merchant={`${merchant.scope}:${merchant.merchantKey}`}
      className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-t border-divider py-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-15 font-semibold text-ink">{merchant.name}</span>
          <SideChip scope={merchant.scope} />
        </div>
        <span className="text-body-12 text-ink-muted">
          {`Last charged ${formatDay(merchant.lastChargedOn)} · ${plural(merchant.chargeCount, 'charge')}`}
        </span>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="font-mono text-body-15 text-ink">
          {formatCents(merchant.amountCents)}
        </span>
        <span className="text-body-11 text-ink-muted">latest charge</span>
      </div>
      <div className="flex gap-2">{children}</div>
    </li>
  )
}

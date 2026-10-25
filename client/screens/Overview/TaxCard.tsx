import { useQuery } from '@tanstack/react-query'
import { grabSettings } from '../../apis/settings.ts'
import { queryKeys } from '../../apis/queryKeys.ts'
import { formatCents } from '../../../shared/money.ts'
import type { SafeToSpendResult } from '../../../shared/contracts.ts'
import { barPercent, formatRate } from './format.ts'
import { BAR_FILL, BAR_TRACK, BLUSH_CARD } from './styles.ts'

// Strawb's tax set-aside (docs/design/handoff.md Screen 1): what is in the
// Strawb tax pot against what is owed on its profit so far, and the
// shortfall the hero holds back. Every figure is the server's
// (prd-02 Ruling 11). The prototype's "Next payment" and "auto top-up"
// lines are left out: Divvy has neither.
//
// The rate label reads the settings query here, not in the screen, so it is
// only asked for once there is a card to put it on. If settings cannot be
// read the label is left out rather than guessed.
export default function TaxCard({ result }: { result: SafeToSpendResult }) {
  const settings = useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: grabSettings,
  })
  const percent = barPercent(
    result.strawbTaxPotCents,
    result.strawbTaxOwedCents,
  )
  return (
    <section
      aria-labelledby="tax-heading"
      data-testid="tax-card"
      className={`${BLUSH_CARD} flex flex-col gap-3 p-6`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="tax-heading" className="m-0 text-body-15 font-semibold text-rose">
          Tax set-aside
        </h2>
        {settings.data && (
          <span
            data-testid="tax-rate"
            className="text-body-12 font-semibold text-rose"
          >
            {formatRate(settings.data.taxRateBasisPoints)} of profit
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          data-testid="tax-pot"
          className="font-display text-display-40 font-medium leading-none text-ink"
        >
          {formatCents(result.strawbTaxPotCents)}
        </span>
        <span data-testid="tax-owed" className="text-body-13 text-rose">
          of {formatCents(result.strawbTaxOwedCents)} owed so far
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Tax set aside, as a share of tax owed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={`${BAR_TRACK} bg-surface`}
      >
        <div className={BAR_FILL} style={{ width: `${percent}%` }} />
      </div>
      {result.strawbTaxHoldCents > 0 && (
        <span data-testid="tax-short" className="text-body-13 text-rose">
          {formatCents(result.strawbTaxHoldCents)} short
        </span>
      )}
    </section>
  )
}

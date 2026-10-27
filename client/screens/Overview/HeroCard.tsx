import { formatCents } from '../../../shared/money.ts'
import type { SafeToSpendResult } from '../../../shared/contracts.ts'
import Ledger from './Ledger.tsx'
import { barPercent, formatDay } from './format.ts'
import { BAR_FILL, BAR_TRACK, CARD, EYEBROW } from './styles.ts'

// The safe-to-spend hero (docs/design/handoff.md Screen 1). It shows the
// server's `safeCents` and never works it out (prd-02 Ruling 1): there is no
// goal-contribution field in the contract, so a contribution cannot reach
// this number (Ruling 5).
//
// The clamp and the bar are presentation, not money math. The amount is clamped
// at $0 and a "short by" line takes the per-day line's place when
// `safeCents` is negative (Ruling 3); `shortByCents` is the server's. The
// bar's width is `safeCents` as a share of `liquidCents`, a ratio for the
// eye only.
export default function HeroCard({ result }: { result: SafeToSpendResult }) {
  const percent = barPercent(result.safeCents, result.liquidCents)
  const short = result.safeCents < 0
  const days = result.daysToPayday
  return (
    <section
      aria-labelledby="hero-heading"
      className={`${CARD} col-span-full grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-center gap-6 p-7`}
    >
      <div className="flex flex-col gap-1.5">
        <h2 id="hero-heading" className={`${EYEBROW} text-deep`}>
          Safe to spend
        </h2>
        <span
          data-testid="hero-amount"
          className="font-display text-display-72 font-medium leading-none tracking-hero text-ink"
        >
          {formatCents(Math.max(0, result.safeCents))}
        </span>
        <span className="text-body-14 text-ink-muted">
          until payday on {formatDay(result.nextPayday, result.today)} · after tax, bills
          and budgets
        </span>
        <div
          role="progressbar"
          aria-label="Safe to spend, as a share of what is across accounts"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className={`${BAR_TRACK} mt-2 bg-blush`}
        >
          <div className={BAR_FILL} style={{ width: `${percent}%` }} />
        </div>
        {short ? (
          <span
            data-testid="hero-short-by"
            className="text-body-12 font-semibold text-danger"
          >
            short by {formatCents(result.shortByCents)}
          </span>
        ) : (
          <span data-testid="hero-per-day" className="text-body-12 text-ink-muted">
            {formatCents(result.perDayCents)} a day for the next {days}{' '}
            {days === 1 ? 'day' : 'days'}
          </span>
        )}
      </div>
      <Ledger result={result} />
    </section>
  )
}

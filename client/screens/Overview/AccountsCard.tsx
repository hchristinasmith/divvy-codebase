import { formatCents, sumCents } from '../../../shared/money.ts'
import type {
  AccountRole,
  AccountSummary,
  RowScope,
} from '../../../shared/contracts.ts'
import { BLUSH_CARD, CARD, EYEBROW } from './styles.ts'

// The Personal and Strawb account cards (docs/design/CHANGES-2.md §2): an
// eyebrow, the total, and a tile per account. Personal is a white card on
// canvas tiles; Strawb a blush card on translucent white tiles.
//
// The card keeps only its own side's accounts even though the route already
// scopes them, so a personal account can never show under Strawb or the
// reverse (prd-02 Done-when 3). The total is a display sum of the balances
// shown, credit cards included; it is not safe-to-spend and feeds nothing
// (prd-02 Ruling 2).

const ROLE_LABELS: Record<AccountRole, string> = {
  current: 'Current',
  savings: 'Savings',
  tax_pot: 'Tax pot',
  credit_card: 'Credit card',
}

const SIDES: Record<
  RowScope,
  { title: string; card: string; eyebrow: string; tile: string; text: string }
> = {
  personal: {
    title: 'Personal',
    card: CARD,
    eyebrow: 'text-deep',
    tile: 'bg-canvas',
    text: 'text-ink-muted',
  },
  strawb: {
    title: 'Strawb',
    card: BLUSH_CARD,
    eyebrow: 'text-rose',
    tile: 'bg-surface/70',
    text: 'text-rose',
  },
}

export default function AccountsCard({
  side,
  accounts,
}: {
  side: RowScope
  accounts: AccountSummary[]
}) {
  const style = SIDES[side]
  const own = accounts.filter((account) => account.scope === side)
  const total = sumCents(own.map((account) => account.balanceCents))
  const headingId = `accounts-${side}-heading`
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`accounts-${side}`}
      className={`${style.card} flex flex-col gap-4 p-5.5`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className={`${EYEBROW} ${style.eyebrow}`}>
          {style.title}
        </h2>
        <span
          data-testid="accounts-total"
          className="font-display text-display-40 font-medium leading-none tracking-title text-ink"
        >
          {formatCents(total)}
        </span>
      </div>
      {own.length === 0 ? (
        <p className={`m-0 text-body-14 ${style.text}`}>
          No accounts in this scope yet.
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2 p-0">
          {own.map((account) => (
            <li
              key={account.id}
              className={`flex min-w-0 flex-col gap-1.5 rounded-inset p-3 ${style.tile}`}
            >
              <span
                className={`truncate text-body-11 font-semibold ${style.text}`}
              >
                {account.name}
              </span>
              <span className="font-mono text-body-15 text-ink">
                {formatCents(account.balanceCents)}
              </span>
              <span className={`text-body-11 ${style.text}`}>
                {account.role === null
                  ? 'No role set'
                  : ROLE_LABELS[account.role]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

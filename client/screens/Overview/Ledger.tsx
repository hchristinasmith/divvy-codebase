import { formatCents } from '../../../shared/money.ts'
import type { SafeToSpendResult } from '../../../shared/contracts.ts'

// The working beside the hero (docs/design/handoff.md Screen 1): what is
// across the accounts, each thing taken off it, and what is left. Every
// figure is one the server sent (prd-02 Ruling 1); nothing here adds or
// subtracts. Taken-off rows show the positive amount with the "−" in the
// label, as the prototype does. The last row is the signed `safeCents`, so
// the column adds up even when the hero above is clamped to $0.

interface LedgerLine {
  key: string
  label: string
  cents: number
}

function lines(result: SafeToSpendResult): LedgerLine[] {
  return [
    { key: 'liquid', label: 'Across accounts', cents: result.liquidCents },
    { key: 'tax', label: '− Tax reserve', cents: result.taxHoldCents },
    { key: 'bills', label: '− Bills due', cents: result.unpaidBillsCents },
    {
      key: 'budgets',
      label: '− Budgets left',
      cents: result.remainingBudgetCents,
    },
    { key: 'cards', label: '− Card debt', cents: result.cardDebtCents },
  ]
}

export default function Ledger({ result }: { result: SafeToSpendResult }) {
  return (
    <dl
      aria-label="How safe to spend is worked out"
      className="m-0 flex flex-col rounded-summary bg-canvas px-4 py-1.5 font-mono text-body-13"
    >
      {lines(result).map((line) => (
        <div
          key={line.key}
          data-ledger={line.key}
          className="flex justify-between gap-3 border-b border-line py-2.5"
        >
          <dt className="whitespace-nowrap text-ink-muted">{line.label}</dt>
          <dd className="m-0">{formatCents(line.cents)}</dd>
        </div>
      ))}
      <div
        data-ledger="safe"
        className="flex justify-between gap-3 py-2.5 font-medium"
      >
        <dt className="whitespace-nowrap">= Safe to spend</dt>
        <dd className="m-0 text-deep">{formatCents(result.safeCents)}</dd>
      </div>
    </dl>
  )
}

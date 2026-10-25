import type { RowScope } from '../../../shared/contracts.ts'

// Which side pays for it, beside the name: Strawb in blush and rose,
// Personal on the canvas in muted ink.
const CHIP: Record<RowScope, { label: string; className: string }> = {
  strawb: { label: 'Strawb', className: 'bg-blush text-rose' },
  personal: { label: 'Personal', className: 'bg-canvas text-ink-muted' },
}

export default function SideChip({ scope }: { scope: RowScope }) {
  const chip = CHIP[scope]
  return (
    <span
      className={`rounded-pill px-2 py-0.5 text-body-11 font-semibold ${chip.className}`}
    >
      {chip.label}
    </span>
  )
}

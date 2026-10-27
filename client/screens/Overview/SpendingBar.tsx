import type { SpendingByCategoryResponse } from '../../../shared/contracts.ts'
import { BAR_TRACK } from './styles.ts'

// The storage-style spending bar and its legend colours, shared by the
// Overview's "Spending by category" card (issue 271) and the Spending screen
// (issue 272), so both draw a month's lines the same way. Every figure is
// the route's; nothing here adds anything up.

// By rank, then the tail. Theme colours only, and none of ok, warn or
// danger: a category is not good or bad. Uncategorised is ink, the one
// near-neutral dark in the theme, so it reads apart from every pink rank,
// from Other's mauve, and from the canvas track behind the bar.
const RANK_COLOURS = [
  'bg-deep',
  'bg-pink',
  'bg-rose',
  'bg-blush-hover',
  'bg-ink-faint',
]
const OTHER_COLOUR = 'bg-ink-muted'
const UNCATEGORISED_COLOUR = 'bg-ink'

/** One line of the bar and its list: a category, Other or Uncategorised. */
export interface SpendingLine {
  key: string
  kind: 'category' | 'other' | 'uncategorised'
  label: string
  cents: number
  colour: string
}

/**
 * The response's lines in display order: categories largest first as the
 * route sent them, then Other and Uncategorised when they are not 0.
 */
export function linesOf(data: SpendingByCategoryResponse): SpendingLine[] {
  const lines: SpendingLine[] = data.categories.map((line, rank) => ({
    key: `category:${line.category}`,
    kind: 'category',
    label: line.category,
    cents: line.spentCents,
    colour: RANK_COLOURS[rank % RANK_COLOURS.length],
  }))
  if (data.otherCents > 0) {
    lines.push({
      key: 'other',
      kind: 'other',
      label: 'Other',
      cents: data.otherCents,
      colour: OTHER_COLOUR,
    })
  }
  if (data.uncategorisedCents > 0) {
    lines.push({
      key: 'uncategorised',
      kind: 'uncategorised',
      label: 'Uncategorised',
      cents: data.uncategorisedCents,
      colour: UNCATEGORISED_COLOUR,
    })
  }
  return lines
}

/**
 * The bar itself, hidden from assistive tech: the list beside it carries
 * the figures. Each segment's width is its line's share of the bar:
 * `flexGrow` takes the cents as they are. That is presentation, not money
 * arithmetic.
 */
export function SpendingBar({ lines }: { lines: readonly SpendingLine[] }) {
  return (
    <div
      aria-hidden="true"
      data-testid="spending-bar"
      className={`${BAR_TRACK} flex gap-1 bg-canvas`}
    >
      {lines.map((line) => (
        <span
          key={line.key}
          data-spending-segment={line.kind}
          className={`min-w-0 basis-0 ${line.colour}`}
          style={{ flexGrow: line.cents }}
        />
      ))}
    </div>
  )
}

/** The legend dot in a line's colour. */
export function SpendingSwatch({ line }: { line: SpendingLine }) {
  return (
    <span
      aria-hidden="true"
      className={`size-2.5 shrink-0 rounded-pill ${line.colour}`}
    />
  )
}

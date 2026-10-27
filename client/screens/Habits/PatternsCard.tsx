import type { ReactNode } from 'react'
import { EMPTY, LIST_CARD, SUB, TITLE } from './styles.ts'

// Patterns (handoff.md Screen 5). prd-02 ships it as an empty state; prd-04
// mounts its insights here by passing them as `children` (prd-02, Out of
// scope: "prd-04 mounts them on the Habits and Overview components this PRD
// builds").
// Nothing here invents a pattern: with no children, the card says that
// insights arrive later.
export default function PatternsCard({ children }: { children?: ReactNode }) {
  const hasContent = children !== undefined && children !== null && children !== false
  return (
    <section aria-label="Patterns" className={LIST_CARD}>
      <h2 className={TITLE}>Patterns</h2>
      <p className={SUB}>Unflattering on purpose. Pulled from the last 90 days.</p>
      {hasContent ? (
        children
      ) : (
        <p className={EMPTY} data-testid="patterns-empty">
          No patterns yet. Insights from your own spending arrive here later.
        </p>
      )}
    </section>
  )
}

import { useRef, type ReactNode } from 'react'
import type { Scope } from '../../../shared/contracts.ts'
import PatternsCard from '../../screens/Habits/PatternsCard.tsx'
import { ERROR } from '../../screens/Overview/styles.ts'
import InsightCard from './InsightCard.tsx'
import { useDismissInsight, useInsights } from './useInsights.ts'

// The Habits screen's Patterns card filled with the scope's insights
// (prd-04 Ruling 2, Ruling 3; #63). Every insight is drawn by InsightCard
// and nothing else here shows its title, body or chart, so InsightCard's
// guarantees for hostile text and specs hold.
//
// This renders PatternsCard itself so that it decides what the card's
// children are: with no insights it passes none, and the card shows its own
// empty state. While the list is loading it passes none too, so the card
// reads as it did before #63 until there is something to show. A failed
// read is said in the card; a failed dismiss is said above the list and the
// insight stays.
export default function PatternInsights({ scope }: { scope: Scope }) {
  const insights = useInsights(scope)
  const dismiss = useDismissInsight()
  // One dismiss at a time, so a double tap sends one request. A ref, not
  // `dismiss.isPending`: the second tap can land before that re-renders.
  const dismissing = useRef(false)
  const onDismiss = (id: number) => {
    if (dismissing.current) return
    dismissing.current = true
    dismiss.mutate(id, {
      onSettled: () => {
        dismissing.current = false
      },
    })
  }

  let content: ReactNode
  if (insights.data === undefined) {
    if (insights.isError) {
      content = (
        <p role="alert" className={ERROR}>
          Couldn&apos;t load patterns. {insights.error.message}
        </p>
      )
    }
  } else if (insights.data.length > 0) {
    content = (
      <>
        {dismiss.isError && (
          <p role="alert" className={ERROR}>
            Couldn&apos;t dismiss that insight. {dismiss.error.message}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {insights.data.map((insight) => (
            <li key={insight.id} data-insight-id={insight.id}>
              <InsightCard insight={insight} onDismiss={onDismiss} />
            </li>
          ))}
        </ul>
      </>
    )
  }

  return <PatternsCard>{content}</PatternsCard>
}

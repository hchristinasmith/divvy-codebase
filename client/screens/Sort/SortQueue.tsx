import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { categoriesQuery } from '../../apis/overview.ts'
import type {
  CategoriseGroupResponse,
  Scope,
} from '../../../shared/contracts.ts'
import { CARD, CARD_TITLE, ERROR, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import CategoryChooser from './CategoryChooser.tsx'
import GroupCard from './GroupCard.tsx'
import { useApplyGroup } from './useApplyGroup.ts'

// The queue: the groups as they were when it mounted, and a cursor over
// them. Applying a category moves to the next card once the server has
// answered; a refusal shows its message and keeps the card. Skip moves on
// and sends nothing. While a write is in flight every control is disabled.
export default function SortQueue({
  scope,
  groups,
  checking,
  onCheckAgain,
}: {
  scope: Scope
  groups: readonly CategoriseGroupResponse[]
  checking: boolean
  onCheckAgain: () => void
}) {
  const [queue] = useState(groups)
  const [cursor, setCursor] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const write = useApplyGroup()
  const categories = useQuery(categoriesQuery)
  const current = cursor < queue.length ? queue[cursor] : undefined

  const status = done !== null && (
    <p role="status" className={MUTED}>
      {done}
    </p>
  )

  if (current === undefined) {
    return (
      <div className="flex flex-col gap-4">
        {status}
        <section
          aria-label="All sorted"
          className={`${CARD} flex min-w-0 flex-col items-start gap-3 p-6`}
        >
          <h2 className={CARD_TITLE}>All sorted</h2>
          <p className={MUTED}>
            {queue.length === 0
              ? 'Nothing is uncategorised in this scope.'
              : 'You have been through every merchant in this list.'}
          </p>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} min-h-12`}
            disabled={checking}
            onClick={onCheckAgain}
          >
            Check again
          </button>
        </section>
      </div>
    )
  }

  function choose(category: string) {
    if (current === undefined) return
    setDone(null)
    write.apply(
      { scope, merchant_key: current.merchantKey, category },
      (changed) => {
        setDone(`Categorised ${changed}`)
        setCursor((c) => c + 1)
      },
    )
  }

  function skip() {
    write.reset()
    setDone(null)
    setCursor((c) => c + 1)
  }

  return (
    <div className="flex flex-col gap-4">
      {status}
      <GroupCard
        group={current}
        position={`${cursor + 1} / ${queue.length}`}
      >
        {write.error !== null && (
          <p role="alert" className={ERROR}>
            {write.error}
          </p>
        )}
        {categories.isError && (
          <p className={ERROR}>Couldn&apos;t load the category list.</p>
        )}
        <CategoryChooser
          key={current.merchantKey}
          merchant={current.name}
          groups={categories.data}
          disabled={write.isPending}
          onChoose={choose}
        />
        <button
          type="button"
          className={`${SECONDARY_BUTTON} min-h-12 self-start`}
          disabled={write.isPending}
          onClick={skip}
        >
          Skip
        </button>
      </GroupCard>
    </div>
  )
}

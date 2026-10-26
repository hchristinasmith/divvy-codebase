import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  categoriesQuery,
  setTransactionCategory,
} from '../../apis/overview.ts'
import { invalidateOverview } from '../../apis/queryKeys.ts'
import { SCOPES } from '../../context/ScopeContext.tsx'
import type { ActivityRow, IsoDate, Scope } from '../../../shared/contracts.ts'
import SegmentedControl from '../../components/Shell/SegmentedControl.tsx'
import ActivityRowItem from './ActivityRowItem.tsx'
import {
  CARD,
  CARD_TITLE,
  ERROR,
  MUTED,
  SECONDARY_BUTTON,
} from './styles.ts'

// Recent activity (docs/design/handoff.md Screen 1 and "Scope toggle"): the
// route's latest rows for the scope, a sub-filter, and the inline category
// edit.
//
// The sub-filter offers All, Personal and Strawb in All, and only the
// scope's own pill otherwise; it starts on the scope. The screen keys this
// card by scope, so a scope switch resets it. It filters the rows the route
// sent, so "Personal" in All can show fewer rows than the route's limit.
//
// A category edit goes to the update route (M1 #9) and the row changes only
// when the refetched overview says so: a refusal shows the server's message
// under the row and the old category stays, never a silent revert.

interface CategoryEdit {
  id: string
  category: string
}

export default function ActivityCard({
  rows,
  scope,
  today,
}: {
  rows: ActivityRow[]
  scope: Scope
  today: IsoDate
}) {
  const [filter, setFilter] = useState<Scope>(scope)
  const client = useQueryClient()
  const categories = useQuery(categoriesQuery)
  const edit = useMutation({
    mutationFn: ({ id, category }: CategoryEdit) =>
      setTransactionCategory(id, category),
    // Returned, so the row shows "Saving…" until the refetch lands.
    onSuccess: () => invalidateOverview(client),
  })

  const pills = SCOPES.filter((s) => scope === 'all' || s.value === scope)
  const shown = rows.filter((row) => filter === 'all' || row.scope === filter)

  return (
    <section
      aria-labelledby="activity-heading"
      className={`${CARD} flex flex-col gap-3.5 p-6`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="activity-heading" className={`${CARD_TITLE} text-ink`}>
          Recent activity
        </h2>
        <SegmentedControl
          label="Activity filter"
          options={pills}
          value={filter}
          onChange={setFilter}
        />
      </div>
      {categories.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className={ERROR}>
            Couldn&apos;t load categories. Editing is off.
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void categories.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {shown.length === 0 ? (
        <p className={MUTED}>No recent activity.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((row) => (
            <ActivityRowItem
              key={row.id}
              row={row}
              groups={categories.data}
              saving={edit.isPending && edit.variables.id === row.id}
              error={
                edit.isError && edit.variables.id === row.id
                  ? edit.error.message
                  : null
              }
              today={today}
              onCategory={(category) => edit.mutate({ id: row.id, category })}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

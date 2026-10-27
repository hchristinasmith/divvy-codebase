import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { budgetsQuery } from '../../apis/budgets.ts'
import { overviewQuery } from '../../apis/overview.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import type { BudgetsResponse, Scope } from '../../../shared/contracts.ts'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import { PRIMARY_BUTTON } from '../Bills/styles.ts'
import BudgetCard from './BudgetCard.tsx'
import BudgetForm from './BudgetForm.tsx'
import { paydaySubtitle } from './format.ts'
import { EMPTY_CARD, EMPTY_TITLE, GRID, SECTION } from './styles.ts'
import { useBudgetWritePending, useStepLimit } from './useBudgetActions.ts'

// The Budgets screen (prd-02, issue 53; docs/design/handoff.md Screen 2):
// one card per in-scope budget with its status, spent of the limit, a bar
// and its note; − / + move the limit by $10; Add budget and Delete. Every
// figure comes from the budgets route (server/routes/budgets.ts), which
// reads the same lines safe-to-spend counts; this screen does no money
// arithmetic past the $10 step. Every write refetches the budgets and the
// overview.
//
// The handoff's "Claude Code owns budget creation" and its Advisor banner
// with "Ask why" are not here: budgets are created and changed in the app,
// and the advisor is read-only in Claude desktop (prd-02; issue 53's
// Done-when 2).
//
// The subtitle's days to payday are the overview's (the shared cache entry
// the Overview and the nav badge read), so there is no client date maths.
//
// The read is keyed by scope, so a scope switch shows the loading card until
// that scope's budgets arrive, never the previous scope's. A failed refetch
// keeps the last budgets on screen with a banner saying so. The states are
// the Bills screen's.
export default function Budgets() {
  const { scope } = useScope()
  const budgets = useQuery(budgetsQuery(scope))
  const overview = useQuery(overviewQuery(scope))

  return (
    <>
      <ScreenHeader
        title="Budgets"
        subtitle={paydaySubtitle(
          overview.data?.safeToSpend.daysToPayday,
          budgets.data,
        )}
      />
      {budgets.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading your budgets…
        </p>
      ) : budgets.data === undefined ? (
        <div role="alert" className={`${CARD} flex flex-col items-start gap-3 p-6`}>
          <p className={ERROR}>{budgets.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void budgets.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {budgets.isError && (
            <div
              role="alert"
              className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
            >
              <p className={ERROR}>Couldn&apos;t refresh. Showing the last budgets.</p>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void budgets.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          {/* Keyed by scope, so a switch drops an open form and a failed write's message. */}
          <BudgetsBody key={scope} data={budgets.data} scope={scope} />
        </>
      )}
    </>
  )
}

function BudgetsBody({ data, scope }: { data: BudgetsResponse; scope: Scope }) {
  const [adding, setAdding] = useState(false)
  const step = useStepLimit()
  const busy = useBudgetWritePending()

  return (
    <div className={SECTION}>
      <div className="flex justify-end">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={adding}
          onClick={() => setAdding(true)}
        >
          Add budget
        </button>
      </div>
      {adding && (
        <section aria-label="New budget" className={`${CARD} p-6`}>
          <BudgetForm scope={scope} onClose={() => setAdding(false)} />
        </section>
      )}
      {step.error !== null && (
        <p role="alert" className={ERROR}>
          {step.error}
        </p>
      )}
      {data.items.length === 0 ? (
        !adding && (
          <div className={EMPTY_CARD}>
            <p className={EMPTY_TITLE}>No budgets yet</p>
            <p className={MUTED}>Add one to set a weekly limit for a category.</p>
          </div>
        )
      ) : (
        <section aria-label="Budgets" className={GRID}>
          {data.items.map((budget) => (
            <BudgetCard
              key={budget.id}
              budget={budget}
              busy={busy}
              onStep={step.step}
            />
          ))}
        </section>
      )}
    </div>
  )
}

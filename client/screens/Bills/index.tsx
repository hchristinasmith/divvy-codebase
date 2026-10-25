import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { billsQuery } from '../../apis/bills.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import { formatCents } from '../../../shared/money.ts'
import type { BillsResponse, Scope } from '../../../shared/contracts.ts'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import BillForm from './BillForm.tsx'
import BillsList from './BillsList.tsx'
import SummaryTiles from './SummaryTiles.tsx'
import { PRIMARY_BUTTON, SECTION } from './styles.ts'
import { useBillWritePending, usePayBill } from './useBillActions.ts'

// The Bills screen (prd-02, issue 54; docs/design/handoff.md Screen 3): the
// bills due for the chosen scope, what is due before payday, the next one,
// what was paid this month, and the writes: add, edit, delete, Mark paid.
// Every figure comes from one read (server/routes/bills.ts); this screen
// does no arithmetic. Every write refetches the bills and the overview.
//
// There are no Xero payables, emailed invoices, automatic matching or
// overdue flags here: the route has none, and the client has no "today".
//
// The read is keyed by scope, so a scope switch shows the loading card until
// that scope's bills arrive, never the previous scope's. A failed refetch
// keeps the last bills on screen with a banner saying so. The states are the
// Subscriptions screen's.
export default function Bills() {
  const { scope } = useScope()
  const bills = useQuery(billsQuery(scope))

  return (
    <>
      <ScreenHeader
        title="Upcoming bills"
        subtitle={
          bills.data === undefined
            ? undefined
            : `${formatCents(bills.data.dueBeforePaydayCents)} due before payday`
        }
      />
      {bills.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading your bills…
        </p>
      ) : bills.data === undefined ? (
        <div role="alert" className={`${CARD} flex flex-col items-start gap-3 p-6`}>
          <p className={ERROR}>{bills.error?.message}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void bills.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {bills.isError && (
            <div
              role="alert"
              className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
            >
              <p className={ERROR}>Couldn&apos;t refresh. Showing the last bills.</p>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => void bills.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          {/* Keyed by scope, so a switch drops an open form and a failed write's message. */}
          <BillsBody key={scope} data={bills.data} scope={scope} />
        </>
      )}
    </>
  )
}

type Editing = { kind: 'add' } | { kind: 'edit'; id: string } | null

function BillsBody({ data, scope }: { data: BillsResponse; scope: Scope }) {
  // One form at a time: opening one closes the other.
  const [editing, setEditing] = useState<Editing>(null)
  const pay = usePayBill()
  const busy = useBillWritePending()
  const close = () => setEditing(null)

  return (
    <div className={SECTION}>
      <SummaryTiles data={data} scope={scope} />
      <div className="flex justify-end">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={editing?.kind === 'add'}
          onClick={() => setEditing({ kind: 'add' })}
        >
          Add bill
        </button>
      </div>
      {editing?.kind === 'add' && (
        <section aria-label="New bill" className={`${CARD} p-6`}>
          <BillForm mode={{ kind: 'add', scope }} onClose={close} />
        </section>
      )}
      {pay.error !== null && (
        <p role="alert" className={ERROR}>
          {pay.error}
        </p>
      )}
      <BillsList
        items={data.items}
        editingId={editing?.kind === 'edit' ? editing.id : null}
        busy={busy}
        onPay={pay.pay}
        onEdit={(id) => setEditing({ kind: 'edit', id })}
        onClose={close}
      />
    </div>
  )
}

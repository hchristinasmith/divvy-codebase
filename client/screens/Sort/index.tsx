import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { groupsQuery } from '../../apis/categorise.ts'
import { useScope } from '../../context/ScopeContext.tsx'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import SortQueue from './SortQueue.tsx'

// The Sort screen (prd-02 Ruling 17, issue 259): uncategorised settled
// transactions, one merchant card at a time, largest total first. Every
// figure comes from one read for the chosen scope
// (server/routes/categorise.ts); this screen does no arithmetic.
//
// The queue is a snapshot: `SortQueue` keeps the groups it was mounted
// with, so the refetch an apply triggers never reshuffles the cards under
// Hannah's thumb. It is keyed by scope and by round, so a scope switch or a
// "Check again" starts a fresh snapshot from the read as it is then. The
// loading, error and refetch-error states are the Subscriptions screen's.
export default function Sort() {
  const { scope } = useScope()
  const groups = useQuery(groupsQuery(scope))
  const [round, setRound] = useState(0)

  async function checkAgain() {
    const result = await groups.refetch()
    if (result.isSuccess) setRound((r) => r + 1)
  }

  return (
    <>
      <ScreenHeader
        title="Sort"
        subtitle="Uncategorised transactions, one merchant at a time"
      />
      {groups.isPending ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading uncategorised transactions…
        </p>
      ) : groups.data === undefined ? (
        <div
          role="alert"
          className={`${CARD} flex flex-col items-start gap-3 p-6`}
        >
          <p className={ERROR}>{groups.error?.message}</p>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} min-h-12`}
            onClick={() => void groups.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {groups.isError && (
            <p role="alert" className={`${CARD} ${ERROR} px-6 py-4`}>
              Couldn&apos;t check again. Showing the last list.
            </p>
          )}
          <SortQueue
            key={`${scope}:${round}`}
            scope={scope}
            groups={groups.data.groups}
            checking={groups.isFetching}
            onCheckAgain={() => void checkAgain()}
          />
        </>
      )}
    </>
  )
}

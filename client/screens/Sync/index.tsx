import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { syncAccountsQuery, syncStatusQuery } from '../../apis/sync.ts'
import SourcesCard from './SourcesCard.tsx'
import { useNow } from './useNow.ts'
import { CARD, ERROR, MUTED, SECONDARY_BUTTON } from './styles.ts'

// The Sync screen (prd-02 issue 59; docs/design/handoff.md Screen 7): a row
// per connected bank with the last sync's status and how long ago it was,
// and "Sync now", which starts a real sync through prd-01's trigger.
//
// Banks only: the Xero row, the "Pulled from Xero this week" card and the
// Xero half of the footer are prd-05's to add (prd-02 Ruling 4).
//
// Rows need both reads, the status and the accounts, so neither is shown
// without the other: until both arrive the screen is loading, and a first
// read that fails shows the error with "Try again". A later read that fails
// keeps the last rows with a banner saying so (the Overview's pattern).
export default function Sync() {
  const status = useQuery(syncStatusQuery())
  const accounts = useQuery(syncAccountsQuery)
  const tick = useNow()

  const retry = () => {
    void status.refetch()
    void accounts.refetch()
  }

  let body: ReactNode
  if (status.data === undefined || accounts.data === undefined) {
    const error =
      (status.data === undefined ? status.error : null) ??
      (accounts.data === undefined ? accounts.error : null)
    body =
      error === null ? (
        <p role="status" className={`${CARD} ${MUTED} p-6`}>
          Loading sync status…
        </p>
      ) : (
        <div
          role="alert"
          className={`${CARD} flex flex-col items-start gap-3 p-6`}
        >
          <p className={ERROR}>{error.message}</p>
          <button type="button" className={SECONDARY_BUTTON} onClick={retry}>
            Try again
          </button>
        </div>
      )
  } else {
    // A reply that landed after the last tick (or after the machine woke)
    // is aged against the moment it arrived, as the pill does.
    const now = Math.max(tick, status.dataUpdatedAt)
    body = (
      <section aria-label="Sync" className="flex flex-col gap-4.5">
        {(status.isError || accounts.isError) && (
          <div
            role="alert"
            className={`${CARD} flex flex-wrap items-center gap-3 px-6 py-4`}
          >
            <p className={ERROR}>
              Couldn&apos;t refresh. Showing the last status.
            </p>
            <button type="button" className={SECONDARY_BUTTON} onClick={retry}>
              Try again
            </button>
          </div>
        )}
        <SourcesCard status={status.data} accounts={accounts.data} now={now} />
      </section>
    )
  }

  return (
    <>
      <ScreenHeader title="Sync" subtitle="Banks" />
      {body}
    </>
  )
}

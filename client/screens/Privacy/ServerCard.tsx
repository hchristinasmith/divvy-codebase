import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BLUSH_CARD, CARD_TITLE } from '../Overview/styles.ts'
import {
  SERVER_STATUS_KEY,
  fetchServerStatus,
  formatWhen,
} from './serverStatus.ts'

// The blush Server card (docs/design/handoff.md Screen 8), showing only what
// the app can report truthfully (issue Done-when 2). The design's host,
// uptime, last backup and outbound-calls rows are omitted: the app has no
// source for any of them, and a guessed or hardcoded value there would be a
// false claim. The page's own address (window.location) is never shown
// either; it is a hostname, not a fact about the server.
//
// Basis for both rows: `GET /api/v1/sync/status` (`SyncStatus` in
// server/routes/sync.ts). lastSuccessAt is null before the first successful
// sync; nextRunAt is null while the scheduler is stopped. The card does not
// poll, so "Next sync" is the value as of when the screen opened.

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-t border-blush-hover py-2 text-body-14">
      <dt>{label}</dt>
      <dd className="m-0 ml-auto text-right font-mono text-ink">{value}</dd>
    </div>
  )
}

type CardState = 'loading' | 'ready' | 'error'

export default function ServerCard() {
  const headingId = useId()
  const { data, isError } = useQuery({
    queryKey: SERVER_STATUS_KEY,
    queryFn: fetchServerStatus,
    // A failure shows "Unavailable" at once rather than after retries.
    retry: false,
  })

  // Data wins over a later failed refetch: the last values read stay up.
  const state: CardState =
    data !== undefined ? 'ready' : isError ? 'error' : 'loading'

  let lastSync: string
  let nextSync: string
  if (data !== undefined) {
    lastSync =
      data.lastSuccessAt === null
        ? 'Never synced'
        : formatWhen(data.lastSuccessAt)
    nextSync =
      data.nextRunAt === null ? 'Not scheduled' : formatWhen(data.nextRunAt)
  } else if (state === 'error') {
    lastSync = 'Unavailable'
    nextSync = 'Unavailable'
  } else {
    lastSync = 'Checking…'
    nextSync = 'Checking…'
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="server-card"
      data-server-state={state}
      className={`${BLUSH_CARD} flex flex-col gap-2.5 p-6 text-rose`}
    >
      <h2 id={headingId} className={CARD_TITLE}>
        Server
      </h2>
      <dl className="m-0 flex flex-col">
        <Row label="Last successful sync" value={lastSync} />
        <Row label="Next sync" value={nextSync} />
        {/* MOUNT: prd-05 outbound-call line goes here (prd-05 wave 3, declared widening) */}
      </dl>
    </section>
  )
}

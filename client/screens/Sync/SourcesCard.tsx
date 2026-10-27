import type { SyncAccount, SyncScreenStatus } from '../../apis/sync.ts'
import SourceRow from './SourceRow.tsx'
import SyncFooter from './SyncFooter.tsx'
import { groupSources } from './sources.ts'
import { rowStateFor } from './syncState.ts'
import { CARD } from './styles.ts'

// The Sync screen's one card (Divvy.dc.html, Sync): a row per bank
// connection, then the footer with "Sync now". The status is global, so it
// is worked out once and every row shows the same one. With no accounts yet
// there is still one row, so the status and the button stay on screen.
export default function SourcesCard({
  status,
  accounts,
  now,
}: {
  status: SyncScreenStatus
  accounts: SyncAccount[]
  now: number
}) {
  const state = rowStateFor(status, now)
  const sources = groupSources(accounts)

  return (
    <div className={`${CARD} px-6 py-2`}>
      <ul aria-label="Bank connections" className="m-0 list-none p-0">
        {sources.length === 0 ? (
          <SourceRow name="No bank accounts yet" detail={null} state={state} />
        ) : (
          sources.map((source, index) => (
            <SourceRow
              // Names can repeat (an account with no connection shares a
              // bank's name), so the position is part of the key.
              key={`${index}-${source.name}`}
              name={source.name}
              detail={source.accounts.join(', ')}
              state={state}
            />
          ))
        )}
      </ul>
      <SyncFooter
        running={status.running}
        nextRunAt={status.nextRunAt}
        now={now}
      />
    </div>
  )
}

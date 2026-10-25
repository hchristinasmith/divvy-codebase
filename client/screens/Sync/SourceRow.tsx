import clsx from 'clsx'
import { DOT_LABELS, type SyncRowState } from './syncState.ts'

// One row of the sources card (Divvy.dc.html, Sync): the status dot and the
// bank's name, a detail line under them, and the time on the right in DM
// Mono. The prototype's Personal/Strawb chip is not drawn: the accounts list
// carries no scope to fill it from.
export default function SourceRow({
  name,
  detail,
  state,
}: {
  name: string
  // The account names, or null for the empty state's row.
  detail: string | null
  state: SyncRowState
}) {
  const line = [state.lead, detail].filter((part) => part !== null).join(' · ')
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-divider py-4">
      <div className="flex flex-col gap-[3px]">
        <div className="flex flex-wrap items-center gap-2">
          <span
            role="img"
            aria-label={DOT_LABELS[state.kind]}
            data-sync-state={state.kind}
            className={clsx(
              'inline-block h-2 w-2 shrink-0 rounded-full',
              state.tone === 'fresh' && 'bg-ok',
              state.tone === 'stale' && 'bg-warn',
              state.tone === 'failed' && 'bg-danger',
              state.tone === 'unknown' && 'bg-ink-faint',
            )}
          />
          <span className="text-body-15 font-semibold text-ink">{name}</span>
        </div>
        {line !== '' && (
          <span className="text-body-13 text-ink-muted">{line}</span>
        )}
      </div>
      <span
        data-sync-time
        className="whitespace-nowrap text-right font-mono text-body-12 text-ink-muted"
      >
        {state.time ?? ''}
      </span>
    </li>
  )
}

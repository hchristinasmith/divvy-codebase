import clsx from 'clsx'
import { useSyncPill } from '../../hooks/useSyncPill.ts'

// The header's sync status pill (docs/design/handoff.md "Global layout").
// A status, not a button: the prototype's pill opens Sync, but that is one
// of the phone entry points #33 has not chosen yet. Desktop reaches Sync from
// the sidebar.
export default function SyncPill() {
  const { state, label } = useSyncPill()
  return (
    <span
      data-sync-state={state}
      className="flex items-center gap-2 rounded-pill border border-line bg-surface px-3.5 py-2 text-body-13 text-ink"
    >
      <span
        className={clsx(
          'h-[7px] w-[7px] rounded-full',
          state === 'fresh' && 'bg-ok',
          state === 'stale' && 'bg-warn',
          state === 'unknown' && 'bg-ink-faint',
        )}
      />
      {label}
    </span>
  )
}

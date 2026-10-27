import { useSyncNow } from './useSyncNow.ts'
import { ERROR, PRIMARY_BUTTON, SPINNER } from './styles.ts'

// The foot of the sources card: what the schedule is, and "Sync now". The
// prototype's "Xero via OAuth" half is dropped with Xero (prd-02 Ruling 4).
//
// The button is busy while the press is in flight and for as long as the
// server says a sync is running, so the spinner stops only when a status
// read says `running: false`. A refused press shows one fixed message under
// the button, never the server's text; the next press clears it.
export default function SyncFooter({ running }: { running: boolean }) {
  const syncNow = useSyncNow()
  const busy = syncNow.isPending || running

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4">
      <span className="text-body-13 text-ink-muted">
        Auto-sync every 15 min. Banks via read-only Open Banking.
      </span>
      <div className="flex flex-col items-end gap-2">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={busy}
          aria-busy={busy}
          onClick={syncNow.press}
        >
          {busy && <span aria-hidden="true" data-spinner className={SPINNER} />}
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        {syncNow.error !== null && (
          <p role="alert" className={ERROR}>
            {syncNow.error}
          </p>
        )}
      </div>
    </div>
  )
}

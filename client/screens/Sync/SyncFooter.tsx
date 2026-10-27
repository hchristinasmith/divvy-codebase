import { useSyncNow } from './useSyncNow.ts'
import { ERROR, PRIMARY_BUTTON, SPINNER } from './styles.ts'

const BANKS = 'Banks via read-only Open Banking.'

const MINUTE = 60_000

// The schedule sentence, or null when there is none to show: the scheduler
// is stopped (null) or the server sent a time that does not parse.
function scheduleSentence(nextRunAt: string | null, now: number): string | null {
  if (nextRunAt === null) return null
  const at = Date.parse(nextRunAt)
  if (Number.isNaN(at)) return null
  if (at <= now) return 'Next sync due now.'
  return `Next sync in ${Math.ceil((at - now) / MINUTE)} min.`
}

// The foot of the sources card: what the schedule is, and "Sync now". The
// schedule is the server's `nextRunAt`, read against `now`: "Next sync in N
// min." while it is ahead, "Next sync due now." once it has passed, and no
// schedule sentence at all while the scheduler is stopped (nextRunAt null).
// The prototype's "Xero via OAuth" half is dropped with Xero (prd-02 Ruling 4).
//
// The button is busy while the press is in flight and for as long as the
// server says a sync is running, so the spinner stops only when a status
// read says `running: false`. A refused press shows one fixed message under
// the button, never the server's text; the next press clears it.
export default function SyncFooter({
  running,
  nextRunAt,
  now,
}: {
  running: boolean
  nextRunAt: string | null
  now: number
}) {
  const syncNow = useSyncNow()
  const busy = syncNow.isPending || running
  const schedule = scheduleSentence(nextRunAt, now)
  const copy = schedule === null ? BANKS : `${schedule} ${BANKS}`

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4">
      <span className="text-body-13 text-ink-muted">{copy}</span>
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

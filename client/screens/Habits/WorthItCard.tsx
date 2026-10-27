import type { VerdictRow } from '../../../shared/contracts.ts'
import { ERROR } from '../Overview/styles.ts'
import { VERDICT_PILLS, verdictMeta, verdictSummary } from './format.ts'
import {
  EMPTY,
  LIST_CARD,
  MERCHANT,
  MERCHANT_COLUMN,
  META,
  PILL_ROW,
  SUB,
  SUMMARY,
  TITLE,
  TITLE_ROW,
  VERDICT_LIST,
  VERDICT_ROW,
  verdictPill,
} from './styles.ts'
import { useTapVerdict, useVerdictWritePending } from './useVerdict.ts'

// Worth it? (handoff.md Screen 5): the spending the route lists, newest
// first, each with the two verdict pills. A tap sets the verdict; a tap on
// the selected pill clears it (./fields.ts). Every pill waits while a write
// is in flight, and a refused write shows the server's message.
export default function WorthItCard({ rows }: { rows: readonly VerdictRow[] }) {
  const { tap, error } = useTapVerdict()
  const busy = useVerdictWritePending()

  return (
    <section aria-label="Worth it?" className={LIST_CARD}>
      <div className={TITLE_ROW}>
        <h2 className={TITLE}>Worth it?</h2>
        <span className={SUMMARY} data-testid="verdict-summary">
          {verdictSummary(rows)}
        </span>
      </div>
      <p className={SUB}>
        Your own verdict on recent spending. The advisor uses this, not its opinion.
      </p>
      {error !== null && (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className={EMPTY}>No spending in the last 90 days to judge.</p>
      ) : (
        <ul className={VERDICT_LIST}>
          {rows.map((row) => (
            <li
              key={row.transactionId}
              className={VERDICT_ROW}
              data-transaction-id={row.transactionId}
            >
              <div className={MERCHANT_COLUMN}>
                <span className={MERCHANT} title={row.merchant}>
                  {row.merchant}
                </span>
                <span className={META}>{verdictMeta(row)}</span>
              </div>
              <div role="group" aria-label={`Verdict on ${row.merchant}`} className={PILL_ROW}>
                {VERDICT_PILLS.map(({ verdict, label }) => (
                  <button
                    key={verdict}
                    type="button"
                    aria-pressed={row.verdict === verdict}
                    disabled={busy}
                    className={verdictPill(verdict, row.verdict === verdict)}
                    onClick={() => tap(row, verdict)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

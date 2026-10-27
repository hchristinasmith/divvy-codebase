import { formatRunway, runwayNote } from './format.ts'
import { RUNWAY_CARD, RUNWAY_EYEBROW, RUNWAY_NOTE, RUNWAY_VALUE } from './styles.ts'

// Runway (handoff.md Screen 5): the route's months of runway, in tenths,
// written as text. The route computes it (shared/habits.ts); this card only
// formats it.
export default function RunwayCard({ runwayTenths }: { runwayTenths: number | null }) {
  return (
    <section aria-label="Runway" className={RUNWAY_CARD}>
      <h2 className={RUNWAY_EYEBROW}>Runway</h2>
      <p className={RUNWAY_VALUE} data-testid="runway-value">
        {formatRunway(runwayTenths)}
      </p>
      <p className={RUNWAY_NOTE}>{runwayNote(runwayTenths)}</p>
    </section>
  )
}

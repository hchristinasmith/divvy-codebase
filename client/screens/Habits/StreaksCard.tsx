import type { HabitStreak } from '../../../shared/contracts.ts'
import { streakValue } from './format.ts'
import {
  STREAKS_CARD,
  STREAKS_EMPTY,
  STREAKS_EYEBROW,
  STREAK_LABEL,
  STREAK_LIST,
  STREAK_ROW,
  STREAK_VALUE,
} from './styles.ts'

// Streaks (handoff.md Screen 5): only the streaks the route can compute
// from stored data, with its label and days. A streak it cannot compute is
// not in the list, so it is not shown at all rather than shown as zero.
export default function StreaksCard({ streaks }: { streaks: readonly HabitStreak[] }) {
  return (
    <section aria-label="Streaks" className={STREAKS_CARD}>
      <h2 className={STREAKS_EYEBROW}>Streaks</h2>
      {streaks.length === 0 ? (
        <p className={STREAKS_EMPTY}>No streak can be counted from your data yet.</p>
      ) : (
        <ul className={STREAK_LIST}>
          {streaks.map((streak) => (
            <li key={streak.key} className={STREAK_ROW} data-streak-key={streak.key}>
              <span className={STREAK_LABEL}>{streak.label}</span>
              <span className={STREAK_VALUE}>{streakValue(streak.days)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

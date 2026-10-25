import { Settings, Wand } from 'lucide-react'

// The screens of docs/design/handoff.md, by key.
export type ScreenKey =
  | 'overview'
  | 'budgets'
  | 'bills'
  | 'subscriptions'
  | 'goals'
  | 'habits'
  | 'advisor'
  | 'sync'
  | 'privacy'

export type IconName = ScreenKey | 'wishlist' | 'settings'

// Copied from `icon()` in docs/design/Divvy.dc.html: 24 viewBox line icons,
// stroke 2, round caps.
const PATHS: Record<ScreenKey, string[]> = {
  overview: ['M4 11.5 12 5l8 6.5', 'M6.5 10v9h11v-9', 'M10 19v-5h4v5'],
  budgets: ['M12 3a9 9 0 1 0 9 9h-9z', 'M15 3.5A9 9 0 0 1 20.5 9H15z'],
  bills: [
    'M7 3.5h10v17l-2.5-1.5L12 20.5 9.5 19 7 20.5z',
    'M9.5 8.5h5',
    'M9.5 12h5',
    'M9.5 15.5h3',
  ],
  subscriptions: ['M5 7h14', 'M5 12h14', 'M5 17h14', 'M18 15.5l1.5 1.5-1.5 1.5'],
  goals: [
    'M12 20s-7-4.4-7-9.6A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20z',
  ],
  advisor: [
    'M12 4v3',
    'M12 17v3',
    'M4 12h3',
    'M17 12h3',
    'M12 8.5 13.3 10.7 15.5 12 13.3 13.3 12 15.5 10.7 13.3 8.5 12 10.7 10.7z',
  ],
  sync: [
    'M5 12a7 7 0 0 1 12-5l1.5 1.5',
    'M18.5 5v3.5H15',
    'M19 12a7 7 0 0 1-12 5L5.5 15.5',
    'M5.5 19v-3.5H9',
  ],
  habits: ['M4 12a8 8 0 0 1 16 0', 'M12 12l3.5-3.5', 'M4 16h16'],
  privacy: ['M7 11V8.5a5 5 0 0 1 10 0V11', 'M6 11h12v9H6z', 'M12 14.5v2'],
}

export default function NavIcon({ name }: { name: IconName }) {
  // Wishlist and Settings are not handoff screens and have no handoff icon;
  // lucide's line icons match the stroke style.
  if (name === 'wishlist') return <Wand size={16} strokeWidth={2} aria-hidden />
  if (name === 'settings') {
    return <Settings size={16} strokeWidth={2} aria-hidden />
  }
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

import { screens } from '../../screens/routes.tsx'
import type { IconName } from './icons.tsx'

// What the sidebar and the phone tab bar link to, derived from the one route
// table in client/screens/routes.tsx.

export interface NavEntry {
  path: string
  label: string
  icon: IconName
  badge?: 'alerts'
}

// Below the handoff's screens: pages the handoff does not have that stay
// reachable (prd-02 Ruling 8; Wishlist until D11). Their routes live in
// App.tsx with the other old pages. Transactions, Targets, Subscriptions,
// Challenges and the old Dashboard are routed there but linked from nowhere.
export const SECONDARY_NAV: readonly NavEntry[] = [
  { path: '/wishlist', label: 'Wishlist', icon: 'wishlist' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
]

export const sidebarItems: readonly NavEntry[] = [
  ...screens.map(({ key, path, label, badge }) => ({
    path,
    label,
    icon: key,
    badge,
  })),
  ...SECONDARY_NAV,
]

// Phone tab bar: only the screens that declare a tab, in tab order. Bills,
// Sync and Privacy have none until #33 decides how a phone reaches them.
export const tabItems: readonly NavEntry[] = screens
  .flatMap((s) => (s.tab ? [{ ...s, tab: s.tab }] : []))
  .sort((a, b) => a.tab.order - b.tab.order)
  .map(({ key, path, tab }) => ({ path, label: tab.label, icon: key }))

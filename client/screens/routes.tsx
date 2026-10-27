import { Route } from 'react-router'
import type { ComponentType, ReactElement } from 'react'
import type { ScreenKey } from '../components/Shell/icons.tsx'
import Overview from './Overview/index.tsx'
import Budgets from './Budgets/index.tsx'
import Bills from './Bills/index.tsx'
import Subscriptions from '../components/Subscriptions/index.tsx'
import Goals from './Goals/index.tsx'
import Habits from './Habits/index.tsx'
import Advisor from './Advisor/index.tsx'
import Sort from './Sort/index.tsx'
import Sync from './Sync/index.tsx'
import Privacy from './Privacy/index.tsx'

// The one route table for the handoff's screens, and Sort (prd-02 Ruling 17),
// which the handoff does not have. The sidebar, the phone tab
// bar and App.tsx's routes all read it. A screen's issue replaces the default
// export of its stub, ./<Name>/index.tsx, and leaves this file and App.tsx
// alone. A screen with no stub (Subscriptions, issue 230, in
// ../components/Subscriptions/) adds its one entry and import here.

export interface ScreenRoute {
  key: ScreenKey
  path: string
  // Sidebar label.
  label: string
  Component: ComponentType
  // The sidebar shows the open-alert count beside this entry.
  badge?: 'alerts'
  // Present when the screen is in the phone tab bar.
  tab?: { label: string; order: number }
}

// In the handoff's sidebar order, with Sort before Sync. The tab bar has its
// own order.
export const screens: readonly ScreenRoute[] = [
  {
    key: 'overview',
    path: '/',
    label: 'Overview',
    Component: Overview,
    badge: 'alerts',
    tab: { label: 'Home', order: 1 },
  },
  {
    key: 'budgets',
    path: '/budgets',
    label: 'Budgets',
    Component: Budgets,
    tab: { label: 'Budgets', order: 2 },
  },
  { key: 'bills', path: '/bills', label: 'Bills', Component: Bills },
  {
    key: 'subscriptions',
    path: '/subscriptions',
    label: 'Subscriptions',
    Component: Subscriptions,
  },
  {
    key: 'goals',
    path: '/goals',
    label: 'Goals',
    Component: Goals,
    tab: { label: 'Goals', order: 4 },
  },
  {
    key: 'habits',
    path: '/habits',
    label: 'Habits',
    Component: Habits,
    tab: { label: 'Habits', order: 3 },
  },
  {
    key: 'advisor',
    path: '/advisor',
    label: 'Advisor',
    Component: Advisor,
    tab: { label: 'Advisor', order: 5 },
  },
  { key: 'sort', path: '/sort', label: 'Sort', Component: Sort },
  { key: 'sync', path: '/sync', label: 'Sync', Component: Sync },
  { key: 'privacy', path: '/privacy', label: 'Privacy', Component: Privacy },
]

export const screenRoutes: ReactElement[] = screens.map(
  ({ key, path, Component }) => (
    <Route key={key} path={path} element={<Component />} />
  ),
)

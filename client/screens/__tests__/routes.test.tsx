import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { Routes } from 'react-router'
import Shell from '../../components/Shell/Shell.tsx'
import {
  pendingFetch,
  renderWithProviders,
} from '../../components/Shell/__tests__/renderWithProviders.tsx'
import { screenRoutes, screens } from '../routes.tsx'

// A later screen issue replaces only its own directory's default export.
// This stands in for that replacement without touching routes.tsx.
vi.mock('../Goals/index.tsx', () => ({
  default: () => <h1>Goals, built by its own issue</h1>,
}))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const HANDOFF = [
  ['overview', '/', 'Overview'],
  ['budgets', '/budgets', 'Budgets'],
  ['bills', '/bills', 'Upcoming bills'],
  ['goals', '/goals', 'Goals, built by its own issue'],
  ['habits', '/habits', 'Habits'],
  ['advisor', '/advisor', 'Advisor'],
  ['sync', '/sync', 'Sync'],
  ['privacy', '/privacy', 'Privacy'],
] as const

describe('the route table', () => {
  it('holds the eight handoff screens in sidebar order', () => {
    expect(screens.map((s) => [s.key, s.path])).toEqual(
      HANDOFF.map(([key, path]) => [key, path]),
    )
  })

  it('puts five screens in the tab bar, in tab order', () => {
    const tabs = screens
      .filter((s) => s.tab)
      .sort((a, b) => (a.tab?.order ?? 0) - (b.tab?.order ?? 0))
      .map((s) => s.tab?.label)
    expect(tabs).toEqual(['Home', 'Budgets', 'Habits', 'Goals', 'Advisor'])
  })

  it.each(HANDOFF)('%s at %s renders inside the shell', (_key, path, title) => {
    renderWithProviders(
      <Shell>
        <Routes>{screenRoutes}</Routes>
      </Shell>,
      { path },
    )
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings.map((h) => h.textContent)).toEqual([title])
    expect(screen.getByRole('main').contains(headings[0])).toBe(true)
    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Tab bar' })).not.toBeNull()
  })

  it('every stub tells you it is not built yet rather than showing numbers', () => {
    // Goals is mocked above; Overview is built (issue 45).
    for (const [, path] of HANDOFF.filter(
      ([key]) => key !== 'goals' && key !== 'overview',
    )) {
      renderWithProviders(
        <Shell>
          <Routes>{screenRoutes}</Routes>
        </Shell>,
        { path },
      )
      expect(screen.getByRole('main').textContent).toContain(
        'This screen is built in a later step.',
      )
      expect(screen.getByRole('main').textContent).not.toMatch(/\$\d/)
      cleanup()
    }
  })
})

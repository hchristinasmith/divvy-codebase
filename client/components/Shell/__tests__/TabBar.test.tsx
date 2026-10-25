import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { Routes } from 'react-router'
import { screenRoutes } from '../../../screens/routes.tsx'
import Shell from '../Shell.tsx'
import TabBar from '../TabBar.tsx'
import { pendingFetch, renderWithProviders } from './renderWithProviders.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TABS = [
  ['Home', '/', 'Overview'],
  ['Budgets', '/budgets', 'Budgets'],
  ['Habits', '/habits', 'Habits'],
  ['Goals', '/goals', 'Goals'],
  ['Advisor', '/advisor', 'Advisor'],
] as const

function tabLinks() {
  const bar = screen.getByRole('navigation', { name: 'Tab bar' })
  return within(bar).getAllByRole('link')
}

describe('the phone tab bar', () => {
  it('shows exactly Home, Budgets, Habits, Goals and Advisor, in that order', () => {
    renderWithProviders(<TabBar />)
    expect(tabLinks().map((a) => a.textContent)).toEqual(
      TABS.map(([label]) => label),
    )
    expect(tabLinks().map((a) => a.getAttribute('href'))).toEqual(
      TABS.map(([, path]) => path),
    )
  })

  it('has no Bills, Sync or Privacy tab while #33 is open', () => {
    renderWithProviders(<TabBar />)
    const labels = tabLinks().map((a) => a.textContent)
    for (const absent of ['Bills', 'Sync', 'Privacy']) {
      expect(labels).not.toContain(absent)
    }
  })

  it('gives every tab a tap target at least 44px tall', () => {
    renderWithProviders(<TabBar />)
    for (const tab of tabLinks()) {
      expect(tab.classList.contains('min-h-[44px]')).toBe(true)
    }
  })

  it('rounds every tab at the 12px nav radius (update 2)', () => {
    renderWithProviders(<TabBar />)
    for (const tab of tabLinks()) {
      expect(tab.classList.contains('rounded-nav')).toBe(true)
    }
  })

  it('is fixed to the bottom and hidden from 720px up', () => {
    renderWithProviders(<TabBar />)
    const bar = screen.getByRole('navigation', { name: 'Tab bar' })
    for (const cls of ['fixed', 'bottom-0', 'shell:hidden']) {
      expect(bar.classList.contains(cls)).toBe(true)
    }
  })

  it.each(TABS)('%s routes to %s', (label, _path, heading) => {
    // Start on a screen with no tab, so every tab, Home included, has to
    // navigate.
    renderWithProviders(
      <Shell>
        <Routes>{screenRoutes}</Routes>
      </Shell>,
      { path: '/privacy' },
    )
    const bar = screen.getByRole('navigation', { name: 'Tab bar' })
    fireEvent.click(within(bar).getByRole('link', { name: label }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading)
    expect(
      within(bar)
        .getByRole('link', { name: label })
        .getAttribute('aria-current'),
    ).toBe('page')
  })
})

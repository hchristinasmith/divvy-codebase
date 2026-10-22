import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import ShellSidebar from '../ShellSidebar.tsx'
import { renderWithProviders } from './renderWithProviders.tsx'

const alerts = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../hooks/useAlertCount.ts', () => ({
  useAlertCount: () => alerts.count,
}))

afterEach(() => {
  cleanup()
  alerts.count = 0
})

function links() {
  const nav = screen.getByRole('navigation', { name: 'Primary' })
  return within(nav).getAllByRole('link')
}

describe('the desktop sidebar', () => {
  it('lists the eight handoff screens in order, then Wishlist and Settings', () => {
    renderWithProviders(<ShellSidebar />)
    expect(links().map((a) => a.textContent)).toEqual([
      'Overview',
      'Budgets',
      'Bills',
      'Goals',
      'Habits',
      'Advisor',
      'Sync',
      'Privacy',
      'Wishlist',
      'Settings',
    ])
    expect(links().map((a) => a.getAttribute('href'))).toEqual([
      '/',
      '/budgets',
      '/bills',
      '/goals',
      '/habits',
      '/advisor',
      '/sync',
      '/privacy',
      '/wishlist',
      '/settings',
    ])
  })

  it('links none of the pages prd-02 Ruling 8 retires', () => {
    renderWithProviders(<ShellSidebar />)
    const hrefs = links().map((a) => a.getAttribute('href'))
    for (const retired of [
      '/transactions',
      '/targets',
      '/manage-subscriptions',
      '/challenges',
      '/dashboard',
    ]) {
      expect(hrefs).not.toContain(retired)
    }
  })

  it('marks only the current screen active, not Overview everywhere', () => {
    renderWithProviders(<ShellSidebar />, { path: '/budgets' })
    const current = links()
      .filter((a) => a.getAttribute('aria-current') === 'page')
      .map((a) => a.textContent)
    expect(current).toEqual(['Budgets'])
  })

  it('shows the open-alert count beside Overview', () => {
    alerts.count = 3
    renderWithProviders(<ShellSidebar />)
    const overview = links()[0]
    expect(within(overview).getByTestId('nav-badge').textContent).toBe('3')
    expect(screen.getAllByTestId('nav-badge')).toHaveLength(1)
  })

  it('shows no badge when there are no alerts', () => {
    renderWithProviders(<ShellSidebar />)
    expect(screen.queryByTestId('nav-badge')).toBeNull()
  })

  it('is hidden under 720px', () => {
    renderWithProviders(<ShellSidebar />)
    const aside = screen.getByRole('complementary')
    expect(aside.classList.contains('hidden')).toBe(true)
    expect(aside.classList.contains('shell:flex')).toBe(true)
    expect(aside.classList.contains('w-56')).toBe(true)
  })
})

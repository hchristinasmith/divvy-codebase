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

  it('claims only what is true of this build in the Self-hosted card', () => {
    renderWithProviders(<ShellSidebar />)
    const card = screen.getByText('Self-hosted').parentElement
    expect(card?.textContent).toBe('Self-hostedRunning on your server.')
    // The handoff's "Nothing leaves it." is untrue once the advisor reads
    // data through Claude (D3).
    expect(screen.queryByText(/Nothing leaves it/)).toBeNull()
  })

  it('sits the Self-hosted card on an offset, with no border (update 2)', () => {
    renderWithProviders(<ShellSidebar />)
    const card = screen.getByText('Self-hosted').parentElement
    expect(card?.classList.contains('shadow-tile')).toBe(true)
    expect(card?.classList.contains('rounded-tile')).toBe(true)
    expect(
      [...(card?.classList ?? [])].filter((c) => c.startsWith('border')),
    ).toEqual([])
  })

  it('shows the two-line wordmark, named in words rather than letters', () => {
    renderWithProviders(<ShellSidebar />)
    const mark = screen.getByRole('img', { name: 'Divvy, hold the reins' })
    expect(mark.children).toHaveLength(2)
    const [letters, tagline] = [...mark.children]
    expect([...letters.children].map((c) => c.textContent)).toEqual([
      'D',
      'I',
      'V',
      'V',
      'Y',
    ])
    expect([...tagline.children].map((c) => c.textContent)).toEqual([
      'Hold',
      'the',
      'reins',
    ])
    // Both lines spread across the same 104px block, in --dv-deep.
    for (const cls of ['w-[104px]', 'text-deep']) {
      expect(mark.classList.contains(cls)).toBe(true)
    }
    for (const line of [letters, tagline]) {
      expect(line.classList.contains('flex')).toBe(true)
      expect(line.classList.contains('justify-between')).toBe(true)
    }
    for (const cls of ['font-display', 'text-display-22', 'font-semibold']) {
      expect(letters.classList.contains(cls)).toBe(true)
    }
    for (const cls of [
      'text-[10px]',
      'font-semibold',
      'uppercase',
      'tracking-tagline',
      'whitespace-nowrap',
    ]) {
      expect(tagline.classList.contains(cls)).toBe(true)
    }
  })

  it('is hidden under 720px', () => {
    renderWithProviders(<ShellSidebar />)
    const aside = screen.getByRole('complementary')
    expect(aside.classList.contains('hidden')).toBe(true)
    expect(aside.classList.contains('shell:flex')).toBe(true)
    expect(aside.classList.contains('w-56')).toBe(true)
  })
})

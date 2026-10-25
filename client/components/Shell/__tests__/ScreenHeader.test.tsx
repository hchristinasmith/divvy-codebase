import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import ScreenHeader from '../ScreenHeader.tsx'
import { pendingFetch, renderWithProviders } from './renderWithProviders.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ScreenHeader', () => {
  it('shows one title, the subtitle, the scope toggle and the sync pill', () => {
    renderWithProviders(
      <ScreenHeader title="Habits" subtitle="An honest mirror" />,
    )
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings.map((h) => h.textContent)).toEqual(['Habits'])
    expect(screen.getByText('An honest mirror')).not.toBeNull()
    expect(screen.getByRole('group', { name: 'Scope' })).not.toBeNull()
    expect(document.querySelector('[data-sync-state]')).not.toBeNull()
  })

  it('leaves the subtitle out when there is none', () => {
    renderWithProviders(<ScreenHeader title="Goals" />)
    const titleBlock = screen.getByRole('heading', { level: 1 }).parentElement
    // The phone wordmark and the title, nothing else.
    expect(titleBlock?.children).toHaveLength(2)
  })

  it('sets the page title in --dv-deep (update 2)', () => {
    renderWithProviders(<ScreenHeader title="Goals" />)
    const title = screen.getByRole('heading', { level: 1 })
    expect(title.classList.contains('text-deep')).toBe(true)
  })

  it('shows the Divvy wordmark on the phone only', () => {
    renderWithProviders(<ScreenHeader title="Goals" />)
    const wordmark = screen.getByText('Divvy')
    expect(wordmark.classList.contains('shell:hidden')).toBe(true)
  })

  it('adds no phone entry point to Privacy or Sync (#33 is open)', () => {
    renderWithProviders(<ScreenHeader title="Goals" />)
    expect(screen.queryByRole('link')).toBeNull()
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['All', 'Personal', 'Strawb'])
  })
})

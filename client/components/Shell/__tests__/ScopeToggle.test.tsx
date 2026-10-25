import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { Routes } from 'react-router'
import { useScope } from '../../../context/ScopeContext.tsx'
import { screenRoutes } from '../../../screens/routes.tsx'
import Shell from '../Shell.tsx'
import ScopeToggle from '../ScopeToggle.tsx'
import { pendingFetch, renderWithProviders } from './renderWithProviders.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Any screen reading the context: stands in for a later screen.
function ScopeReader() {
  return <p data-testid="scope">{useScope().scope}</p>
}

function pressed() {
  const group = screen.getByRole('group', { name: 'Scope' })
  return within(group)
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent)
}

describe('ScopeToggle', () => {
  it('offers All, Personal and Strawb with All pressed by default', () => {
    renderWithProviders(<ScopeToggle />)
    const group = screen.getByRole('group', { name: 'Scope' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'Personal', 'Strawb'])
    expect(pressed()).toEqual(['All'])
  })

  it('is a 6px track on an offset, with 6px pills (update 2)', () => {
    renderWithProviders(<ScopeToggle />)
    const group = screen.getByRole('group', { name: 'Scope' })
    for (const cls of ['rounded-pill', 'shadow-pill', 'p-[3px]']) {
      expect(group.classList.contains(cls)).toBe(true)
    }
    expect([...group.classList].filter((c) => c.startsWith('border'))).toEqual(
      [],
    )
    for (const button of within(group).getAllByRole('button')) {
      expect(button.classList.contains('rounded-pill')).toBe(true)
    }
  })

  it('switches the scope every consumer reads', () => {
    renderWithProviders(
      <>
        <ScopeToggle />
        <ScopeReader />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    expect(screen.getByTestId('scope').textContent).toBe('personal')
    expect(pressed()).toEqual(['Personal'])

    fireEvent.click(screen.getByRole('button', { name: 'Strawb' }))
    expect(screen.getByTestId('scope').textContent).toBe('strawb')
    expect(pressed()).toEqual(['Strawb'])

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByTestId('scope').textContent).toBe('all')
  })

  it('keeps the chosen scope when you move to another screen', () => {
    renderWithProviders(
      <Shell>
        <Routes>{screenRoutes}</Routes>
      </Shell>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Strawb' }))
    const tabBar = screen.getByRole('navigation', { name: 'Tab bar' })
    fireEvent.click(within(tabBar).getByRole('link', { name: 'Budgets' }))

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Budgets',
    )
    expect(pressed()).toEqual(['Strawb'])
  })
})

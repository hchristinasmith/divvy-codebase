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

// #390 pins today's markup before the pill group is lifted into a shared
// Shell component: the scope switch must look and behave exactly as before.
// Class lists are compared as exact sorted sets, so an added or dropped
// class fails.
function sortedClasses(el: Element) {
  return [...el.classList].sort()
}

describe('ScopeToggle markup (pinned before the #390 lift)', () => {
  it('renders a div group labelled Scope with its exact class set', () => {
    renderWithProviders(<ScopeToggle />)
    const group = screen.getByRole('group', { name: 'Scope' })
    expect(group.tagName).toBe('DIV')
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Scope')
    expect(sortedClasses(group)).toEqual(
      [
        'bg-blush',
        'flex',
        'gap-1',
        'p-[3px]',
        'rounded-pill',
        'shadow-pill',
      ].sort(),
    )
  })

  it('has the three scope buttons as its only children, in order', () => {
    renderWithProviders(<ScopeToggle />)
    const group = screen.getByRole('group', { name: 'Scope' })
    expect(
      [...group.children].map((c) => `${c.tagName}:${c.textContent}`),
    ).toEqual(['BUTTON:All', 'BUTTON:Personal', 'BUTTON:Strawb'])
  })

  it('gives every button type=button and a boolean aria-pressed', () => {
    renderWithProviders(<ScopeToggle />)
    const group = screen.getByRole('group', { name: 'Scope' })
    const states = [...group.children].map((c) => [
      c.getAttribute('type'),
      c.getAttribute('aria-pressed'),
    ])
    expect(states).toEqual([
      ['button', 'true'],
      ['button', 'false'],
      ['button', 'false'],
    ])
  })

  it('gives the pressed button its exact class set', () => {
    renderWithProviders(<ScopeToggle />)
    const all = screen.getByRole('button', { name: 'All' })
    expect(sortedClasses(all)).toEqual(
      [
        'bg-surface',
        'cursor-pointer',
        'focus-visible:outline-2',
        'focus-visible:outline-pink',
        'font-semibold',
        'px-3.5',
        'py-1.5',
        'rounded-pill',
        'text-body-13',
        'text-deep',
      ].sort(),
    )
  })

  it('gives an unpressed button its exact class set', () => {
    renderWithProviders(<ScopeToggle />)
    for (const name of ['Personal', 'Strawb']) {
      expect(sortedClasses(screen.getByRole('button', { name }))).toEqual(
        [
          'bg-transparent',
          'cursor-pointer',
          'focus-visible:outline-2',
          'focus-visible:outline-pink',
          'font-semibold',
          'px-3.5',
          'py-1.5',
          'rounded-pill',
          'text-body-13',
          'text-rose',
        ].sort(),
      )
    }
  })

  it('moves the pressed and unpressed class sets with the scope', () => {
    renderWithProviders(<ScopeToggle />)
    const group = screen.getByRole('group', { name: 'Scope' })
    const before = [...group.children].map(sortedClasses)
    fireEvent.click(screen.getByRole('button', { name: 'Strawb' }))
    const after = [...group.children].map(sortedClasses)
    // All (was pressed) now wears Personal's unpressed set; Strawb wears
    // All's old pressed set.
    expect(after).toEqual([before[1], before[1], before[0]])
  })
})

describe('ScopeToggle repeat click (pinned before the #390 lift)', () => {
  it('keeps the pressed button pressed and the scope unchanged when clicked again', () => {
    renderWithProviders(
      <>
        <ScopeToggle />
        <ScopeReader />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    expect(screen.getByTestId('scope').textContent).toBe('personal')
    expect(pressed()).toEqual(['Personal'])
  })

  it('keeps All pressed when the default is clicked', () => {
    renderWithProviders(
      <>
        <ScopeToggle />
        <ScopeReader />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByTestId('scope').textContent).toBe('all')
    expect(pressed()).toEqual(['All'])
  })
})

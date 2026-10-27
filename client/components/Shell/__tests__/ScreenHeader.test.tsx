import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import ScreenHeader from '../ScreenHeader.tsx'
import SegmentedControl from '../SegmentedControl.tsx'
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

// #390 pins today's header markup before it gains a controls slot: the scope
// switch and sync pill must stay where and how they are. Class lists are
// exact sorted sets.
describe('ScreenHeader markup (pinned before the #390 controls slot)', () => {
  it('is a header with its exact class set', () => {
    const { container } = renderWithProviders(<ScreenHeader title="Goals" />)
    const header = container.querySelector('header')
    expect(header).not.toBeNull()
    expect([...(header as HTMLElement).classList].sort()).toEqual(
      ['flex', 'flex-wrap', 'gap-4', 'items-end', 'justify-between'].sort(),
    )
  })

  it('has the title block first and the controls group second, nothing else', () => {
    const { container } = renderWithProviders(<ScreenHeader title="Goals" />)
    const header = container.querySelector('header') as HTMLElement
    const title = screen.getByRole('heading', { level: 1 })
    const scope = screen.getByRole('group', { name: 'Scope' })
    expect(header.children).toHaveLength(2)
    expect(header.children[0].contains(title)).toBe(true)
    expect(header.children[1].contains(scope)).toBe(true)
  })

  it('keeps the scope group then the sync pill in the right-hand group, with its exact class set', () => {
    renderWithProviders(<ScreenHeader title="Goals" />)
    const scope = screen.getByRole('group', { name: 'Scope' })
    const right = scope.parentElement as HTMLElement
    expect(right.tagName).toBe('DIV')
    expect([...right.classList].sort()).toEqual(
      ['flex', 'flex-wrap', 'gap-2', 'items-center'].sort(),
    )
    expect(right.children).toHaveLength(2)
    expect(right.children[0]).toBe(scope)
    expect(right.children[1].hasAttribute('data-sync-state')).toBe(true)
  })
})

// A screen's own header control (the Subscriptions screen's Active /
// Cancelled switch) sits in the right-hand group, just left of the scope
// toggle. The pins above render with no slot and must not move.
describe('ScreenHeader controls slot', () => {
  const STATUS = [
    { value: 'active', label: 'Active' },
    { value: 'cancelled', label: 'Cancelled' },
  ] as const

  function withStatus() {
    return renderWithProviders(
      <ScreenHeader
        title="Subscriptions"
        controls={
          <SegmentedControl
            label="Status"
            options={STATUS}
            value="active"
            onChange={() => {}}
          />
        }
      />,
    )
  }

  it('draws the slot first in the right-hand group, then the scope group, then the sync pill', () => {
    withStatus()
    const status = screen.getByRole('group', { name: 'Status' })
    const scope = screen.getByRole('group', { name: 'Scope' })
    const right = scope.parentElement as HTMLElement
    expect(right.children).toHaveLength(3)
    expect(right.children[0]).toBe(status)
    expect(right.children[1]).toBe(scope)
    expect(right.children[2].hasAttribute('data-sync-state')).toBe(true)
  })

  it('lists the slot buttons before the scope buttons', () => {
    withStatus()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Active',
      'Cancelled',
      'All',
      'Personal',
      'Strawb',
    ])
  })

  it('leaves the header and the title block as they are', () => {
    const { container } = withStatus()
    const header = container.querySelector('header') as HTMLElement
    expect(header.children).toHaveLength(2)
    expect(
      header.children[0].contains(screen.getByRole('heading', { level: 1 })),
    ).toBe(true)
    expect(
      header.children[1].contains(screen.getByRole('group', { name: 'Status' })),
    ).toBe(true)
  })
})

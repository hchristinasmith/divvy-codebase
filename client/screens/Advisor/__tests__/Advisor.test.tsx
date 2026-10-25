import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { Routes } from 'react-router'
import Shell from '../../../components/Shell/Shell.tsx'
import {
  pendingFetch,
  renderWithProviders,
} from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { screenRoutes } from '../../routes.tsx'

// The Advisor screen (issue Done-when 3): one card pointing to Claude
// desktop, with no chat input, chips, typing indicator or AI call. Rendered
// inside the shell at its route; every request stays pending.

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderAt(path: string) {
  renderWithProviders(
    <Shell>
      <Routes>{screenRoutes}</Routes>
    </Shell>,
    { path },
  )
  return screen.getByRole('main')
}

function advisorCard(main: HTMLElement): HTMLElement {
  return within(main).getByRole('region', { name: 'Advisor' })
}

const flat = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ')

describe('the Advisor screen', () => {
  it('has one h1, Advisor, and no longer claims to run on your server', () => {
    const main = renderAt('/advisor')
    expect(
      screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent),
    ).toEqual(['Advisor'])
    expect(main.textContent).toContain('Your advisor lives in Claude desktop')
    expect(main.textContent).not.toContain('Private · runs on your server')
  })

  it('renders nothing you can type into', () => {
    const main = renderAt('/advisor')
    expect(
      main.querySelectorAll(
        'input, textarea, select, form, [contenteditable], [role="textbox"]',
      ),
    ).toHaveLength(0)
    expect(within(main).queryAllByRole('textbox')).toHaveLength(0)
  })

  it('has no button in the card: no Send and no suggestion chips', () => {
    const main = renderAt('/advisor')
    expect(within(advisorCard(main)).queryAllByRole('button')).toHaveLength(0)
    expect(advisorCard(main).querySelectorAll('button')).toHaveLength(0)
  })

  it('carries none of the chat design’s words', () => {
    const main = renderAt('/advisor')
    expect(flat(main.textContent)).not.toMatch(
      /send|ask about your money|typing|runs locally|private ·/i,
    )
  })

  it('says what Claude reads goes into your Claude conversation', () => {
    const main = renderAt('/advisor')
    const text = flat(advisorCard(main).textContent)
    expect(text).toContain('Claude conversation')
    expect(text).toContain('can read your Divvy data but cannot change it')
  })

  it('links to the Claude desktop download in a new tab, sending no referrer', () => {
    const main = renderAt('/advisor')
    const link = within(advisorCard(main)).getByRole('link', {
      name: 'Claude desktop download page',
    })
    expect(link.getAttribute('href')).toBe('https://claude.ai/download')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')?.split(/\s+/).sort()).toEqual([
      'noopener',
      'noreferrer',
    ])
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('links to Privacy inside the app, and the link opens it', () => {
    const main = renderAt('/advisor')
    const link = within(advisorCard(main)).getByRole('link', {
      name: 'Privacy',
    })
    expect(link.getAttribute('href')).toBe('/privacy')
    expect(link.getAttribute('target')).toBeNull()
    fireEvent.click(link)
    expect(
      screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent),
    ).toEqual(['Privacy'])
  })

  it('adds no prefetch, preconnect or dns-prefetch hint to the document head', () => {
    const before = document.head.querySelectorAll('link').length
    renderAt('/advisor')
    expect(
      document.head.querySelectorAll(
        'link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="preload"]',
      ),
    ).toHaveLength(0)
    expect(document.head.querySelectorAll('link')).toHaveLength(before)
  })
})

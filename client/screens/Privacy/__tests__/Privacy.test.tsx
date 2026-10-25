import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { Routes } from 'react-router'
import Shell from '../../../components/Shell/Shell.tsx'
import {
  pendingFetch,
  renderWithProviders,
} from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { screenRoutes } from '../../routes.tsx'

// The Privacy screen (issue Done-when 1 and 2), inside the shell at its
// route. Every request stays pending: this file is about the copy, and the
// Server card's states are ServerCard.test.tsx's business.

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPrivacy() {
  renderWithProviders(
    <Shell>
      <Routes>{screenRoutes}</Routes>
    </Shell>,
    { path: '/privacy' },
  )
  return screen.getByRole('main')
}

const flat = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ')

describe('the Privacy screen', () => {
  it('has one h1, Privacy, with its subtitle', () => {
    const main = renderPrivacy()
    expect(
      screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent),
    ).toEqual(['Privacy'])
    expect(main.textContent).toContain('Where your data goes')
  })

  it('heads the hero and each card with an h2, in the design’s order', () => {
    const main = renderPrivacy()
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'Built for one person. There is no Divvy cloud.',
      'Banks',
      'Advisor',
      'Storage',
      'Server',
    ])
    for (const name of ['Banks', 'Advisor', 'Storage', 'Server']) {
      expect(within(main).getByRole('region', { name })).not.toBeNull()
    }
  })

  it.each([
    ['Banks', 'Read-only access'],
    ['Banks', 'never asks your bank to move money'],
    ['Banks', '90 days'],
    ['Advisor', 'Claude desktop'],
    ['Advisor', 'calls no AI service'],
    ['Advisor', 'planned'],
    ['Advisor', 'leaves your server'],
    ['Storage', 'continuously'],
    ['Storage', 'does not show whether a backup has run'],
    ['Storage', 'Your Akahu token is not in it'],
  ])('the %s card says "%s"', (name, phrase) => {
    const main = renderPrivacy()
    const region = within(main).getByRole('region', { name })
    expect(flat(region.textContent)).toContain(phrase)
  })

  it('says there is no Divvy cloud and that the server is tailnet-only by setup', () => {
    const main = renderPrivacy()
    const text = flat(main.textContent)
    expect(text).toContain('no Divvy cloud')
    expect(text).toContain(
      'set up to run on a single server that only your Tailscale network can reach',
    )
  })

  it('makes none of the design’s untrue claims', () => {
    const main = renderPrivacy()
    expect(flat(main.textContent)).not.toMatch(
      /local model|nightly|encrypt|runs on your server|stays inside that box|one machine|runs locally/i,
    )
  })

  it('is no longer the stub', () => {
    const main = renderPrivacy()
    expect(main.textContent).not.toContain(
      'This screen is built in a later step.',
    )
  })
})

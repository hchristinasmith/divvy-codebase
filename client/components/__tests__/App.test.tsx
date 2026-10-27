import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import App from '../App.tsx'
import { screens } from '../../screens/routes.tsx'
import {
  installFetch,
  overviewByScope,
} from '../../screens/Overview/__tests__/fixtures.ts'

// Settings is replaced by a marker so this test checks routing, not page content.
vi.mock('../Settings.tsx', () => ({
  default: () => <p data-testid="page">Settings page</p>,
}))

beforeEach(() => {
  // The sync pill's status request never settles; this test is about routes.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('App routes Settings', () => {
  it('/settings renders Settings inside the shell', () => {
    renderAt('/settings')
    const page = screen.getByTestId('page')
    expect(page.textContent).toBe('Settings page')
    expect(screen.getByRole('main').contains(page)).toBe(true)
    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull()
  })
})

// prd-02 Ruling 8: the w5 sweep deleted the old pages and their routes.
describe('App no longer routes the old pages', () => {
  it.each([
    '/dashboard',
    '/transactions',
    '/targets',
    '/manage-subscriptions',
    '/challenges',
  ])('%s renders no page', (path) => {
    renderAt(path)
    // Markup, not text: the old Dashboard's loading state was a text-less
    // skeleton, so an empty textContent would pass with the page still routed.
    expect(screen.getByRole('main').innerHTML).toBe('')
  })
})

describe('App routes the shell screens', () => {
  it('/ is the Overview now, not the old Dashboard', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Overview',
    )
    expect(screen.queryByTestId('page')).toBeNull()
  })

  it('every screen in the route table is mounted', () => {
    for (const path of [
      '/budgets',
      '/bills',
      '/goals',
      '/habits',
      '/advisor',
      '/sync',
      '/privacy',
    ]) {
      renderAt(path)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      cleanup()
    }
  })

  it('drops the dark-mode toggle from the layout', () => {
    renderAt('/')
    expect(
      screen.queryByRole('button', { name: 'Toggle Dark Mode' }),
    ).toBeNull()
  })
})

// The Spending screen (issue 272) is routed in App.tsx, not in the route
// table, so it has no sidebar or tab bar entry; the handoff shows none.
describe('App routes the Spending screen', () => {
  it('/spending renders the Spending screen inside the shell', () => {
    renderAt('/spending')
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings.map((h) => h.textContent)).toEqual(['Spending'])
    expect(screen.getByRole('main').contains(headings[0])).toBe(true)
  })

  it('adds no sidebar or tab bar entry', () => {
    renderAt('/spending')
    for (const name of ['Primary', 'Tab bar']) {
      const nav = screen.getByRole('navigation', { name })
      expect(within(nav).getAllByRole('link').length, name).toBeGreaterThan(0)
      expect(within(nav).queryByText(/spending/i), name).toBeNull()
      expect(nav.querySelector('a[href="/spending"]'), name).toBeNull()
    }
    expect(screens.map((s) => s.path)).not.toContain('/spending')
  })

  it("the Overview's spending card links to it", async () => {
    installFetch({ overview: overviewByScope() })
    renderAt('/')
    const card = await screen.findByTestId('spending-card')

    fireEvent.click(within(card).getByRole('link', { name: 'Spending by category' }))

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Spending')
    expect(screen.queryByTestId('spending-card')).toBeNull()
  })
})

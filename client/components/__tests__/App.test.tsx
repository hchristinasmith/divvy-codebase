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

// The old pages stay routed until the prd-02 w5 sweep (prd-02 Ruling 8).
// Each is replaced by a marker so this test checks routing, not page content.
vi.mock('../Dashboard/Dashboard.tsx', () => ({
  default: () => <p data-testid="page">Dashboard page</p>,
}))
vi.mock('../Transactions/TransactionsPage.tsx', () => ({
  default: () => <p data-testid="page">Transactions page</p>,
}))
vi.mock('../Targets/targets.tsx', () => ({
  default: () => <p data-testid="page">Targets page</p>,
}))
vi.mock('../ManageSubscriptions/Subscriptions.tsx', () => ({
  default: () => <p data-testid="page">Subscriptions page</p>,
}))
vi.mock('../Challenges/ChallengesDashboard.tsx', () => ({
  default: () => <p data-testid="page">Challenges page</p>,
}))
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

describe('App routes the old pages', () => {
  it.each([
    ['/dashboard', 'Dashboard page'],
    ['/transactions', 'Transactions page'],
    ['/targets', 'Targets page'],
    ['/manage-subscriptions', 'Subscriptions page'],
    ['/challenges', 'Challenges page'],
    ['/settings', 'Settings page'],
  ])('%s renders %s inside the shell', (path, text) => {
    renderAt(path)
    const page = screen.getByTestId('page')
    expect(page.textContent).toBe(text)
    expect(screen.getByRole('main').contains(page)).toBe(true)
    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull()
  })
})

describe('App routes the handoff screens', () => {
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import App from '../App.tsx'

// The old pages stay routed until the prd-02 w5 sweep (prd-02 Ruling 8).
// Each is replaced by a marker so this test checks routing, not page content.
vi.mock('../Dashboard/Dashboard.tsx', () => ({
  default: () => <p data-testid="page">Dashboard page</p>,
}))
vi.mock('../Transactions/TransactionsPage.tsx', () => ({
  default: () => <p data-testid="page">Transactions page</p>,
}))
vi.mock('../Wishlist/WishlistDashboard.tsx', () => ({
  default: () => <p data-testid="page">Wishlist page</p>,
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

afterEach(cleanup)

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
    ['/', 'Dashboard page'],
    ['/transactions', 'Transactions page'],
    ['/wishlist', 'Wishlist page'],
    ['/targets', 'Targets page'],
    ['/manage-subscriptions', 'Subscriptions page'],
    ['/challenges', 'Challenges page'],
    ['/settings', 'Settings page'],
  ])('%s renders %s', (path, text) => {
    renderAt(path)
    expect(screen.getByTestId('page').textContent).toBe(text)
  })
})

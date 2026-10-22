import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { ScopeProvider } from '../../../context/ScopeContext.tsx'
import type { Scope } from '../../../context/ScopeContext.tsx'

// The providers every shell and screen test needs, written once
// (docs/testing.md, Component tests). Not a test file: vitest collects only
// `*.test.ts(x)`.
export function renderWithProviders(
  ui: ReactNode,
  { path = '/', initialScope }: { path?: string; initialScope?: Scope } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ScopeProvider initialScope={initialScope}>{ui}</ScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// A fetch that never settles: the sync pill stays in its loading state, so
// a test that is not about the pill makes no network call.
export function pendingFetch(): Promise<Response> {
  return new Promise<Response>(() => {})
}

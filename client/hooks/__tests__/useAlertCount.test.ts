import { createElement } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { invalidateOverview } from '../../apis/queryKeys.ts'
import { ScopeProvider } from '../../context/ScopeContext.tsx'
import type { Scope } from '../../../shared/contracts.ts'
import { useAlertCount } from '../useAlertCount.ts'
import {
  BILL_SOON,
  installFetch,
  overviewByScope,
  overviewFixture,
} from '../../screens/Overview/__tests__/fixtures.ts'

// The nav badge count (issue 45): the number of open alerts in the
// overview read for the current scope, and zero whenever there is no such
// read to count. Every value is invented.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderCount(initialScope: Scope = 'all') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      // `children` goes as the third argument; the cast only tells
      // createElement's typing, which wants it among the props, so.
      createElement(
        ScopeProvider,
        { initialScope } as ComponentProps<typeof ScopeProvider>,
        children,
      ),
    )
  return { client, ...renderHook(() => useAlertCount(), { wrapper }) }
}

describe('useAlertCount', () => {
  it('is zero while the overview is loading', () => {
    installFetch({})
    const { result } = renderCount()

    expect(result.current).toBe(0)
  })

  it('is zero when the overview read fails', async () => {
    const fx = installFetch({
      overview: () => ({ status: 500, body: { error: 'boom' } }),
    })
    const { result, client } = renderCount()

    await waitFor(() =>
      expect(client.getQueryState(['overview', 'all'])?.status).toBe('error'),
    )
    expect(fx.callsTo('GET', '/api/v1/overview')).toHaveLength(1)
    expect(result.current).toBe(0)
  })

  it.each(['all', 'personal', 'strawb'] as const)(
    'counts the open alerts the %s read returns',
    async (scope) => {
      const fx = installFetch({ overview: overviewByScope() })
      const expected = overviewFixture(scope).alerts.length
      expect(expected).toBeGreaterThan(0)

      const { result } = renderCount(scope)

      await waitFor(() => expect(result.current).toBe(expected))
      expect(
        fx.callsTo('GET', '/api/v1/overview')[0].url.searchParams.get('scope'),
      ).toBe(scope)
    },
  )

  it('drops when an invalidation refetches one fewer alert', async () => {
    const fx = installFetch({ overview: overviewByScope() })
    const { result, client } = renderCount('personal')
    await waitFor(() => expect(result.current).toBe(2))

    fx.handlers.overview = overviewByScope({
      personal: { alerts: [BILL_SOON] },
    })
    await act(() => invalidateOverview(client))

    await waitFor(() => expect(result.current).toBe(1))
  })
})

import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { invalidateOverview, queryKeys } from '../queryKeys.ts'
import type { Scope } from '../../context/ScopeContext.tsx'

const SCOPES: Scope[] = ['all', 'personal', 'strawb']

describe('queryKeys', () => {
  it('covers every domain the screens share', () => {
    expect(Object.keys(queryKeys).sort()).toEqual(
      [
        'overview',
        'budgets',
        'bills',
        'goals',
        'habits',
        'settings',
        'syncStatus',
      ].sort(),
    )
  })

  it('starts each scoped key with its domain prefix', () => {
    for (const domain of [
      queryKeys.overview,
      queryKeys.budgets,
      queryKeys.bills,
    ]) {
      for (const scope of SCOPES) {
        expect(domain.scoped(scope)).toEqual([...domain.all, scope])
      }
    }
  })

  it('gives every domain a distinct prefix', () => {
    const prefixes = Object.values(queryKeys).map((d) => d.all[0])
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })
})

describe('invalidateOverview', () => {
  it('invalidates the overview in every scope and nothing else', async () => {
    const client = new QueryClient()
    for (const scope of SCOPES) {
      client.setQueryData(queryKeys.overview.scoped(scope), { scope })
      client.setQueryData(queryKeys.budgets.scoped(scope), { scope })
    }
    client.setQueryData(queryKeys.settings.all, {})

    await invalidateOverview(client)

    for (const scope of SCOPES) {
      expect(
        client.getQueryState(queryKeys.overview.scoped(scope))?.isInvalidated,
      ).toBe(true)
      expect(
        client.getQueryState(queryKeys.budgets.scoped(scope))?.isInvalidated,
      ).toBe(false)
    }
    expect(client.getQueryState(queryKeys.settings.all)?.isInvalidated).toBe(
      false,
    )
  })
})

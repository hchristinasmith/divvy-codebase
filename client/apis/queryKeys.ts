import type { QueryClient } from '@tanstack/react-query'
import type { Scope } from '../context/ScopeContext.tsx'

// One place for TanStack Query keys, so no two lanes invent their own shapes.
//
// Shape: `[domain]` is the prefix for everything in a domain; scoped domains
// add the scope second, `[domain, scope]`. Anything finer (an id, a month)
// goes after the scope. Invalidating `all` therefore reaches every scope.
//
// Scoped are the domains the handoff's Scope toggle names (overview, budgets,
// bills). The others are unscoped until a screen needs otherwise; changing
// that is an edit to this file only.
export const queryKeys = {
  overview: {
    all: ['overview'] as const,
    scoped: (scope: Scope) => ['overview', scope] as const,
  },
  budgets: {
    all: ['budgets'] as const,
    scoped: (scope: Scope) => ['budgets', scope] as const,
  },
  bills: {
    all: ['bills'] as const,
    scoped: (scope: Scope) => ['bills', scope] as const,
  },
  goals: { all: ['goals'] as const },
  habits: { all: ['habits'] as const },
  settings: { all: ['settings'] as const },
  syncStatus: { all: ['syncStatus'] as const },
}

// Every mutation that can move safe-to-spend (a budget edit, a bill marked
// paid, a settings change) calls this, so the Overview refetches in every
// scope (prd-02 Done-when 3).
export function invalidateOverview(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.overview.all })
}

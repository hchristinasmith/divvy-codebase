import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// The All / Personal / Strawb filter (docs/design/handoff.md "Scope
// toggle"). Every figure on every screen reads it, so it lives here once and
// no screen keeps its own copy.
//
// Defined locally: shared/** belongs to the safe-to-spend lane (#36), and
// #45 reconciles this type with the one there.
export type Scope = 'all' | 'personal' | 'strawb'

// The toggle's options, in the handoff's order.
export const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'personal', label: 'Personal' },
  { value: 'strawb', label: 'Strawb' },
]

interface ScopeValue {
  scope: Scope
  setScope: (next: Scope) => void
}

// No default value: a component outside the provider would otherwise get
// 'all' silently and show unscoped numbers.
const ScopeContext = createContext<ScopeValue | null>(null)

// Memory only: the app opens on All every time, so the safe-to-spend figure
// on load is always the whole picture. Persisting the choice can be added
// inside this provider without changing its API.
export function ScopeProvider({
  children,
  initialScope = 'all',
}: {
  children: ReactNode
  initialScope?: Scope
}) {
  const [scope, setScope] = useState<Scope>(initialScope)
  const value = useMemo(() => ({ scope, setScope }), [scope])
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext)
  if (!value) throw new Error('useScope must be used inside <ScopeProvider>')
  return value
}

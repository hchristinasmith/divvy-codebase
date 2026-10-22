import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ScopeProvider, useScope } from '../ScopeContext.tsx'
import type { Scope } from '../ScopeContext.tsx'

afterEach(cleanup)

let setScopeFromTest: (next: Scope) => void = () => {}

function Consumer() {
  const { scope, setScope } = useScope()
  setScopeFromTest = setScope
  return <p data-testid="scope">{scope}</p>
}

describe('ScopeContext', () => {
  it('defaults to all', () => {
    render(
      <ScopeProvider>
        <Consumer />
      </ScopeProvider>,
    )
    expect(screen.getByTestId('scope').textContent).toBe('all')
  })

  it('honours an initial scope', () => {
    render(
      <ScopeProvider initialScope="strawb">
        <Consumer />
      </ScopeProvider>,
    )
    expect(screen.getByTestId('scope').textContent).toBe('strawb')
  })

  it('setScope changes what every consumer sees', () => {
    render(
      <ScopeProvider>
        <Consumer />
      </ScopeProvider>,
    )
    act(() => setScopeFromTest('personal'))
    expect(screen.getByTestId('scope').textContent).toBe('personal')
  })

  it('refuses to run outside a provider instead of defaulting silently', () => {
    // React logs the thrown render error; keep the test output clean.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Consumer />)).toThrow(
      'useScope must be used inside <ScopeProvider>',
    )
    quiet.mockRestore()
  })
})

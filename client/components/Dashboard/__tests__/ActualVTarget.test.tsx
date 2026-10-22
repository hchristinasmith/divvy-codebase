import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import ActualVTarget from '../ActualVTarget.tsx'

// vitest runs without globals, so Testing Library cannot register its own
// cleanup; unmount explicitly or renders leak into the next test.
afterEach(cleanup)

// The header line of a category's row: the category name and, beside it, the
// amount, the target marker and the trend icon.
function rowFor(category: string): HTMLElement {
  const header = screen.getByText(category).parentElement
  if (!header) throw new Error(`no row for ${category}`)
  return header
}

function trendOf(row: HTMLElement): 'up' | 'down' {
  const cls = row.querySelector('svg')?.getAttribute('class') ?? ''
  if (cls.includes('lucide-trending-up')) return 'up'
  if (cls.includes('lucide-trending-down')) return 'down'
  throw new Error(`no trend icon in row (class="${cls}")`)
}

describe('ActualVTarget', () => {
  const transactions = [
    { category: 'Food', amount: 30 },
    { category: 'Food', amount: 20 },
    { category: 'Fun', amount: 400 },
    { category: 'Untargeted', amount: 999 },
  ]
  const targets = { Food: 100, Fun: 200, Rent: 500 }

  it('renders one row per target, in target order, and none for untargeted spending', () => {
    const { container } = render(
      <ActualVTarget transactions={transactions} targets={targets} />,
    )

    const names = Array.from(
      container.querySelectorAll('span.font-medium'),
      (el) => el.textContent,
    )
    expect(names).toEqual(['Food', 'Fun', 'Rent'])
    expect(screen.queryByText('Untargeted')).toBeNull()
  })

  it('sums every transaction in a category against its target', () => {
    render(<ActualVTarget transactions={transactions} targets={targets} />)

    expect(rowFor('Food').textContent).toContain('$50.00 (50%)')
    expect(trendOf(rowFor('Food'))).toBe('down')
  })

  it('caps the percentage at 150% and marks the category as over', () => {
    render(<ActualVTarget transactions={transactions} targets={targets} />)

    expect(rowFor('Fun').textContent).toContain('$400.00 (150%)')
    expect(trendOf(rowFor('Fun'))).toBe('up')
  })

  it('shows zero for a target with no spending', () => {
    render(<ActualVTarget transactions={transactions} targets={targets} />)

    expect(rowFor('Rent').textContent).toContain('$0.00 (0%)')
    expect(trendOf(rowFor('Rent'))).toBe('down')
  })

  it('treats spending exactly on target as not over', () => {
    render(
      <ActualVTarget
        transactions={[{ category: 'Food', amount: 100 }]}
        targets={{ Food: 100 }}
      />,
    )

    expect(rowFor('Food').textContent).toContain('$100.00 (100%)')
    expect(trendOf(rowFor('Food'))).toBe('down')
  })
})

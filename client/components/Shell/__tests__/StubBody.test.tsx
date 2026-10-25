import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import StubBody from '../StubBody.tsx'

afterEach(cleanup)

describe('StubBody', () => {
  it('is an update 2 card: 12px, an offset, no border', () => {
    render(<StubBody />)
    const card = screen.getByText('This screen is built in a later step.')
    for (const cls of ['rounded-card', 'shadow-card', 'bg-surface']) {
      expect(card.classList.contains(cls)).toBe(true)
    }
    expect([...card.classList].filter((c) => c.startsWith('border'))).toEqual(
      [],
    )
  })
})

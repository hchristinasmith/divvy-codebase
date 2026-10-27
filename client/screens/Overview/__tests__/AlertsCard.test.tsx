import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type { Alert } from '../../../../shared/contracts.ts'
import AlertsCard from '../AlertsCard.tsx'

// The alerts card on its own (prd-02, issue #247). Rendered with the shared
// providers; nothing here is dismissed, so no request is sent. Every value
// is invented.

afterEach(cleanup)

const LEFT_OUT: Alert = {
  id: 'bill_too_many_unpaid:7:2026-10-27',
  kind: 'bill_too_many_unpaid',
  scope: 'strawb',
  subject: 'Backdated Invented',
  amountCents: 4200,
  dueDate: null,
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-alert-id="${id}"]`)
  if (!el) throw new Error(`no alert ${id}`)
  return el
}

describe('#247: a bill left out for too many unpaid occurrences', () => {
  it('says the bill is left out of the totals, with a danger dot and a link to the bills', () => {
    renderWithProviders(<AlertsCard alerts={[LEFT_OUT]} today="2026-10-28" />)

    const li = row(LEFT_OUT.id)
    const text = li.querySelector('span.text-body-14')?.textContent
    expect(text).toBe(
      'Backdated Invented ($42.00) has too many unpaid occurrences and is left out of the totals.',
    )
    const dot = li.querySelector('[data-alert-kind="bill_too_many_unpaid"]')
    expect(dot?.className).toContain('bg-danger')
    const link = li.querySelector('a')
    expect(link?.textContent).toBe('View bills')
    expect(link?.getAttribute('href')).toBe('/bills')
    expect(li.querySelector('button')?.getAttribute('aria-label')).toBe(
      `Dismiss: ${text}`,
    )
  })
})

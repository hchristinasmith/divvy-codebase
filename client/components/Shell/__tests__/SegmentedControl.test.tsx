import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import SegmentedControl from '../SegmentedControl.tsx'

afterEach(cleanup)

// The header's pill group, which the scope switch and the Subscriptions
// screen's Active / Cancelled switch share. Values and labels differ on
// purpose ('a' / 'Alpha'), so a control that handed back the label fails.
const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
] as const

type Letter = (typeof OPTIONS)[number]['value']

function draw(value: Letter = 'a', onChange = vi.fn<[Letter], void>()) {
  render(
    <SegmentedControl
      label="Letters"
      options={OPTIONS}
      value={value}
      onChange={onChange}
    />,
  )
  return { onChange, group: screen.getByRole('group', { name: 'Letters' }) }
}

function sortedClasses(el: Element) {
  return [...el.classList].sort()
}

const PRESSED = [
  'bg-surface',
  'cursor-pointer',
  'font-semibold',
  'px-3.5',
  'py-1.5',
  'rounded-pill',
  'text-body-13',
  'text-deep',
].sort()

const UNPRESSED = [
  'bg-transparent',
  'cursor-pointer',
  'font-semibold',
  'px-3.5',
  'py-1.5',
  'rounded-pill',
  'text-body-13',
  'text-rose',
].sort()

describe('SegmentedControl', () => {
  it('is a div group carrying its label, with the exact track class set', () => {
    const { group } = draw()
    expect(group.tagName).toBe('DIV')
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Letters')
    expect(sortedClasses(group)).toEqual(
      ['bg-blush', 'flex', 'gap-1', 'p-[3px]', 'rounded-pill', 'shadow-pill'].sort(),
    )
  })

  it('has one button per option, in order, labelled by the option label', () => {
    const { group } = draw()
    expect(
      [...group.children].map((c) => `${c.tagName}:${c.textContent}`),
    ).toEqual(['BUTTON:Alpha', 'BUTTON:Beta', 'BUTTON:Gamma'])
  })

  it('presses only the button whose value is the current value', () => {
    const { group } = draw('b')
    expect(
      [...group.children].map((c) => [
        c.getAttribute('type'),
        c.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['button', 'false'],
      ['button', 'true'],
      ['button', 'false'],
    ])
  })

  it('gives the pressed and unpressed buttons their exact class sets', () => {
    const { group } = draw('b')
    expect([...group.children].map(sortedClasses)).toEqual([
      UNPRESSED,
      PRESSED,
      UNPRESSED,
    ])
  })

  it("hands onChange the option's value, not its label", () => {
    const { group, onChange } = draw('a')
    fireEvent.click(within(group).getByRole('button', { name: 'Gamma' }))
    expect(onChange.mock.calls).toEqual([['c']])
  })

  it('leaves the pressed button to the caller: a click alone presses nothing', () => {
    const { group, onChange } = draw('a')
    fireEvent.click(within(group).getByRole('button', { name: 'Beta' }))
    expect(onChange.mock.calls).toEqual([['b']])
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false', 'false'])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { sidebarItems, tabItems } from '../nav.ts'
import NavIcon from '../icons.tsx'
import type { IconName } from '../icons.tsx'

afterEach(cleanup)

describe('nav entries', () => {
  it('give each sidebar entry its own icon', () => {
    expect(sidebarItems.map((i) => [i.label, i.icon])).toEqual([
      ['Overview', 'overview'],
      ['Budgets', 'budgets'],
      ['Bills', 'bills'],
      ['Subscriptions', 'subscriptions'],
      ['Goals', 'goals'],
      ['Habits', 'habits'],
      ['Advisor', 'advisor'],
      ['Sort', 'sort'],
      ['Sync', 'sync'],
      ['Privacy', 'privacy'],
      ['Wishlist', 'wishlist'],
      ['Settings', 'settings'],
    ])
  })

  it('give each tab its screen icon', () => {
    expect(tabItems.map((i) => [i.label, i.icon])).toEqual([
      ['Home', 'overview'],
      ['Budgets', 'budgets'],
      ['Habits', 'habits'],
      ['Goals', 'goals'],
      ['Advisor', 'advisor'],
    ])
  })

  it('carry only path, label, icon and badge', () => {
    for (const item of [...sidebarItems, ...tabItems]) {
      for (const key of Object.keys(item)) {
        expect(['path', 'label', 'icon', 'badge']).toContain(key)
      }
      expect(Object.keys(item)).toEqual(
        expect.arrayContaining(['path', 'label', 'icon']),
      )
    }
  })
})

describe('NavIcon', () => {
  it('draws a different icon for every name', () => {
    const names: IconName[] = [
      'overview',
      'budgets',
      'bills',
      'subscriptions',
      'goals',
      'habits',
      'advisor',
      'sort',
      'sync',
      'privacy',
      'wishlist',
      'settings',
    ]
    const drawn = names.map((name) => {
      const { container } = render(<NavIcon name={name} />)
      const html = container.innerHTML
      cleanup()
      return html
    })
    expect(new Set(drawn).size).toBe(names.length)
  })
})

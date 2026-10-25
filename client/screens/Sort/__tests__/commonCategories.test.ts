// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { categories } from '../../../../data/cats.js'
import { COMMON_CATEGORIES } from '../commonCategories.ts'

// Every quick button names a category the taxonomy holds (prd-04 Ruling 6's
// list, which the apply route checks), so a typo can never become a button
// the server refuses. The screen also hides any the server does not list.
describe('COMMON_CATEGORIES', () => {
  const nzfcc = new Set(Object.values(categories).flat())

  it('names only categories in data/cats.js', () => {
    expect(COMMON_CATEGORIES.filter((name) => !nzfcc.has(name))).toEqual([])
  })

  it('names each category once', () => {
    expect(new Set(COMMON_CATEGORIES).size).toBe(COMMON_CATEGORIES.length)
  })
})

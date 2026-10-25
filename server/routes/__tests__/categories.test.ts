import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import {
  getCategoryGroups,
  isKnownCategory,
  isSelectableCategory,
} from '../../db/categories.ts'

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

// beforeEach can fail before this test's server is listening.
afterEach(async () => {
  await served?.close()
  served = undefined
})

afterAll(closeDb)

describe('GET /api/v1/categories', () => {
  it('lists category groups as { items: [{ name, categories }] }', async () => {
    const res = await api.get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Object.keys(res.body)).toEqual(['items'])

    const items: Record<string, unknown>[] = res.body.items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['categories', 'name'])
      expect(typeof item.name).toBe('string')
      expect(Array.isArray(item.categories)).toBe(true)
      expect((item.categories as unknown[]).length).toBeGreaterThan(0)
      for (const c of item.categories as unknown[]) expect(typeof c).toBe('string')
    }
  })

  it('gives every group and every category a distinct name', async () => {
    const res = await api.get('/api/v1/categories')
    const items: { name: string; categories: string[] }[] = res.body.items
    const groupNames = items.map((g) => g.name)
    const categoryNames = items.flatMap((g) => g.categories)

    expect(new Set(groupNames).size).toBe(groupNames.length)
    expect(new Set(categoryNames).size).toBe(categoryNames.length)
  })

  it('ends with the Divvy group, which holds Drawings (prd-02 Ruling 15)', async () => {
    const res = await api.get('/api/v1/categories')
    const items: { name: string; categories: string[] }[] = res.body.items

    expect(items.at(-1)).toStrictEqual({ name: 'Divvy', categories: ['Drawings'] })
  })
})

// The agents check proposals against data/cats.js alone (server/agents/
// contracts.ts), so an agent can never propose Drawings; Hannah can pick it.
describe('Drawings is selectable, not part of the NZFCC list', () => {
  it('isSelectableCategory accepts Drawings; isKnownCategory and getCategoryGroups do not hold it', () => {
    expect(isSelectableCategory('Drawings')).toBe(true)
    expect(isKnownCategory('Drawings')).toBe(false)
    expect(getCategoryGroups().flatMap((g) => g.categories)).not.toContain('Drawings')
    expect(getCategoryGroups().map((g) => g.name)).not.toContain('Divvy')
    // Every NZFCC name stays selectable.
    for (const name of getCategoryGroups().flatMap((g) => g.categories)) {
      expect(isSelectableCategory(name), name).toBe(true)
    }
    expect(isSelectableCategory('Divvy')).toBe(false)
  })
})

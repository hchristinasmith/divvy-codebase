import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'

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
})

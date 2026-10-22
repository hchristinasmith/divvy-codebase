import request from 'supertest'
import type { Express } from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, freshApp } from '../../test-utils/app.ts'

let app: Express

beforeEach(async () => {
  app = await freshApp()
})

afterAll(closeDb)

describe('GET /api/v1/categories', () => {
  it('lists category groups as { items: [{ name, categories }] }', async () => {
    const res = await request(app).get('/api/v1/categories')

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
    const res = await request(app).get('/api/v1/categories')
    const items: { name: string; categories: string[] }[] = res.body.items
    const groupNames = items.map((g) => g.name)
    const categoryNames = items.flatMap((g) => g.categories)

    expect(new Set(groupNames).size).toBe(groupNames.length)
    expect(new Set(categoryNames).size).toBe(categoryNames.length)
  })
})

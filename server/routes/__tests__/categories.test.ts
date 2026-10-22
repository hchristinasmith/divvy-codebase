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
  it('lists categories as { items: [{ id, name, color }] }', async () => {
    const res = await request(app).get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Object.keys(res.body)).toEqual(['items'])

    const items: Record<string, unknown>[] = res.body.items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['color', 'id', 'name'])
      expect(typeof item.id).toBe('string')
      expect(typeof item.name).toBe('string')
      expect(item.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('gives every category a distinct id', async () => {
    const res = await request(app).get('/api/v1/categories')
    const ids = res.body.items.map((c: { id: string }) => c.id)

    expect(new Set(ids).size).toBe(ids.length)
  })
})

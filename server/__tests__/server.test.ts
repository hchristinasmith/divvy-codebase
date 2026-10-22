import request from 'supertest'
import type { Express } from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, freshApp } from '../test-utils/app.ts'

let app: Express

beforeEach(async () => {
  app = await freshApp()
})

afterAll(closeDb)

// Any response header CORS would add: Access-Control-Allow-Origin and its
// siblings (Allow-Methods, Allow-Headers, Allow-Credentials, ...).
function corsHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((h) =>
    h.toLowerCase().startsWith('access-control-'),
  )
}

const OTHER_ORIGIN = 'http://some-page.tailnet.example'

// The client is served by this same Express process, so the API is
// same-origin only: a page on another origin must not be able to read it (#91).
describe('same-origin only: no CORS headers', () => {
  it('sends no Access-Control-Allow-Origin on a cross-origin API read', async () => {
    const res = await request(app)
      .get('/api/v1/categories')
      .set('Origin', OTHER_ORIGIN)

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(corsHeaders(res.headers)).toEqual([])
  })

  it('answers a cross-origin preflight with no CORS headers', async () => {
    const res = await request(app)
      .options('/api/v1/transactions/1')
      .set('Origin', OTHER_ORIGIN)
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'content-type')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(corsHeaders(res.headers)).toEqual([])
  })
})

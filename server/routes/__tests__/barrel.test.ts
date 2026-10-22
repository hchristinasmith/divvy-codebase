import request from 'supertest'
import type { Express } from 'express'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, freshApp } from '../../test-utils/app.ts'

// The `/api/v1` mount table (prd-02 Sequencing, wave 1). Every path the app
// mounts answers, and the routes that existed before the barrel answer
// exactly as they did.

let app: Express

// The accounts router proxies Akahu over the network. `server.ts` loads
// `dotenv/config`, so a developer's `.env` could make these tests call the
// real API; with the credentials absent the router refuses before any
// request leaves the process.
const AKAHU_ENV = ['AKAHU_USER_TOKEN', 'AKAHU_APP_ID'] as const
let savedEnv: Partial<Record<(typeof AKAHU_ENV)[number], string>> = {}

beforeEach(async () => {
  savedEnv = {}
  for (const name of AKAHU_ENV) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
  app = await freshApp()
})

afterEach(() => {
  for (const name of AKAHU_ENV) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

afterAll(closeDb)

describe('existing routes answer as before', () => {
  it.each(['/api/v1/accounts', '/api/v1/accounts/transactions', '/api/v1/accounts/acc_1/transactions'])(
    'GET %s reaches the accounts router',
    async (path) => {
      const res = await request(app).get(path)

      // The router's own refusal, not Express's 404: the mount reached it.
      expect(res.status).toBe(500)
      expect(res.text).toBe('Missing Akahu credentials')
    },
  )

  it('GET /api/v1/categories lists category groups', async () => {
    const res = await request(app).get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Object.keys(res.body)).toEqual(['items'])
    expect(res.body.items.length).toBeGreaterThan(0)
  })

  it('GET /api/v1/transactions searches transactions', async () => {
    const res = await request(app).get('/api/v1/transactions')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toStrictEqual({ txns: [] })
  })

  it('PATCH /api/v1/transactions/:id reaches the transactions router', async () => {
    const res = await request(app)
      .patch('/api/v1/transactions/999999')
      .send({ category: 'Bakeries' })

    // The body, not just the status: an unrouted PATCH is also a 404.
    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Transaction not found' })
  })

  it('an unknown /api/v1 path is still a 404', async () => {
    const res = await request(app).get('/api/v1/nope')

    expect(res.status).toBe(404)
  })
})

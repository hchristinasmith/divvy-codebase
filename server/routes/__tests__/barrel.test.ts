import type { Express } from 'express'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import routes from '../index.ts'

// The `/api/v1` mount table (prd-02 Sequencing, wave 1). Every path the app
// mounts answers, and the routes that existed before the barrel answer
// exactly as they did.

let app: Express
let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  app = await freshApp()
  served = await serveOnLoopback(app)
  api = served.api
})

// beforeEach can fail before this test's server is listening.
afterEach(async () => {
  await served?.close()
  served = undefined
})

afterAll(closeDb)

describe('existing routes answer as before', () => {
  it.each(['/api/v1/accounts', '/api/v1/accounts/transactions'])(
    'GET %s reaches the accounts router',
    async (path) => {
      const res = await api.get(path)

      // The router's own envelope, not Express's 404: the mount reached it.
      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual({ success: true, items: [] })
    },
  )

  it('GET /api/v1/accounts/acc_1/transactions, the deleted proxy path, is a JSON 404', async () => {
    const res = await api.get('/api/v1/accounts/acc_1/transactions')

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Not found' })
  })

  it('GET /api/v1/categories lists category groups', async () => {
    const res = await api.get('/api/v1/categories')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Object.keys(res.body)).toEqual(['items'])
    expect(res.body.items.length).toBeGreaterThan(0)
  })

  it('GET /api/v1/transactions searches transactions', async () => {
    const res = await api.get('/api/v1/transactions')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toStrictEqual({ txns: [] })
  })

  it('PATCH /api/v1/transactions/:id reaches the transactions router', async () => {
    const res = await api
      .patch('/api/v1/transactions/999999')
      .send({ category: 'Bakeries' })

    // The body, not just the status: an unrouted PATCH is also a 404.
    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Transaction not found' })
  })

  it('GET /api/v1/agents/proposals reaches the agents router', async () => {
    const res = await api.get('/api/v1/agents/proposals')

    // The router's own envelope, not Express's 404: the mount reached it.
    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ items: [] })
  })

  it('an unknown /api/v1 path is still a 404', async () => {
    const res = await api.get('/api/v1/nope')

    expect(res.status).toBe(404)
  })
})

const EXISTING = ['accounts', 'categories', 'transactions', 'sync', 'xero', 'overview', 'settings', 'subscriptions', 'bills', 'agents', 'goals', 'budgets', 'spending', 'habits', 'categorise']

// Express 4 internals: a mounted router is a layer named 'router' whose
// `regexp` matches its mount path. Express 5 renames these; rewrite this
// block, not the assertions, if the dependency moves.
type Layer = { name: string; handle: unknown; regexp: RegExp }
const stackOf = (router: unknown): Layer[] =>
  (router as { stack: Layer[] }).stack

describe('the mount table', () => {
  it('server.ts mounts the barrel once at /api/v1 and no router directly', async () => {
    const appStack = stackOf((app as unknown as { _router: unknown })._router)
    const routers = appStack.filter((layer) => layer.name === 'router')

    expect(routers).toHaveLength(1)
    expect(routers[0].handle).toBe(routes)
    expect(routers[0].regexp.test('/api/v1')).toBe(true)
    expect(routers[0].regexp.test('/api/v2')).toBe(false)
  })

  it('the barrel mounts exactly the existing and placeholder routers', () => {
    const mounted = stackOf(routes)
    const expected = [...EXISTING]

    // Each expected name is matched by one layer, and every layer by one
    // name, so a mount nobody tests here makes this fail.
    for (const name of expected) {
      expect(
        mounted.filter((layer) => layer.regexp.test(`/${name}`)),
        `layers matching /${name}`,
      ).toHaveLength(1)
    }
    for (const layer of mounted) {
      expect(layer.name).toBe('router')
      expect(
        expected.filter((name) => layer.regexp.test(`/${name}`)),
        `names matching ${layer.regexp}`,
      ).toHaveLength(1)
    }
  })
})

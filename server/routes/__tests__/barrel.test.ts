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
  served = await serveOnLoopback(app)
  api = served.api
})

// beforeEach can fail before this test's server is listening.
afterEach(async () => {
  await served?.close()
  served = undefined
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
      const res = await api.get(path)

      // The router's own refusal, not Express's 404: the mount reached it.
      expect(res.status).toBe(500)
      expect(res.text).toBe('Missing Akahu credentials')
    },
  )

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

  it('an unknown /api/v1 path is still a 404', async () => {
    const res = await api.get('/api/v1/nope')

    expect(res.status).toBe(404)
  })
})

const PLACEHOLDERS = ['overview', 'settings', 'budgets', 'bills', 'goals', 'habits']
const EXISTING = ['accounts', 'categories', 'transactions']

describe('placeholder routes', () => {
  it.each(PLACEHOLDERS)('GET /api/v1/%s answers 501 with a JSON error', async (name) => {
    const res = await api.get(`/api/v1/${name}`)

    expect(res.status).toBe(501)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toStrictEqual({ error: `Not implemented: ${name}` })
  })

  it.each(PLACEHOLDERS)(
    '/api/v1/%s answers 501 for any method and sub-path',
    async (name) => {
      for (const res of [
        await api.post(`/api/v1/${name}`).send({}),
        await api.patch(`/api/v1/${name}/1`).send({}),
        await api.delete(`/api/v1/${name}/1`),
        await api.get(`/api/v1/${name}/a/b`),
      ]) {
        expect(res.status).toBe(501)
        expect(res.body).toStrictEqual({ error: `Not implemented: ${name}` })
      }
    },
  )
})

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
    const expected = [...EXISTING, ...PLACEHOLDERS]

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

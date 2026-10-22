import { rmSync } from 'node:fs'
import request from 'supertest'
import type { Express } from 'express'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb, freshApp } from '../test-utils/app.ts'

// A stand-in client build. server.ts serves `public/` beside its own file,
// as dist/server.js does in production; the repo has no build under server/,
// so this file relocates server.ts (and only server.ts) to a temp directory
// holding a small `public/` with an index.html and one asset. The directory
// is made when server.ts first imports node:url, before it reads __dirname.
const build = vi.hoisted(() => ({
  root: '',
  indexHtml: '<!doctype html><title>divvy test build</title>',
  asset: 'console.log("divvy test asset")',
}))

vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>()
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  build.root = fs.mkdtempSync(path.join(os.tmpdir(), 'divvy-server-test-'))
  const publicDir = path.join(build.root, 'public')
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'index.html'), build.indexHtml)
  fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), build.asset)
  const serverFile = path.join(build.root, 'server.ts')

  return {
    ...actual,
    fileURLToPath: (url: string | URL) => {
      const file = actual.fileURLToPath(url)
      return file.endsWith('/server/server.ts') ? serverFile : file
    },
  }
})

let app: Express

beforeEach(async () => {
  app = await freshApp()
})

afterAll(async () => {
  await closeDb()
  if (build.root) rmSync(build.root, { recursive: true, force: true })
})

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

// What a browser sends when it navigates to a page.
const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

// A refresh on any client route must load the app, not 404 (#92).
describe('client routes get index.html', () => {
  it.each(['/targets', '/settings', '/some/route/the/client/may/own'])(
    'GET %s from a browser returns index.html',
    async (path) => {
      const res = await request(app).get(path).set('Accept', BROWSER_ACCEPT)

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/^text\/html/)
      expect(res.text).toBe(build.indexHtml)
    },
  )

  it('treats /apiary as a client route, not as /api', async () => {
    const res = await request(app).get('/apiary').set('Accept', BROWSER_ACCEPT)

    expect(res.status).toBe(200)
    expect(res.text).toBe(build.indexHtml)
  })

  it('still serves a static file as itself', async () => {
    const res = await request(app).get('/assets/app.js')

    expect(res.status).toBe(200)
    expect(res.text).toBe(build.asset)
  })

  it('does not answer a request that does not accept HTML', async () => {
    const res = await request(app)
      .get('/targets')
      .set('Accept', 'application/json')

    expect(res.status).toBe(404)
    expect(res.text).not.toBe(build.indexHtml)
  })

  it('does not answer a non-GET request', async () => {
    const res = await request(app).post('/targets').set('Accept', BROWSER_ACCEPT)

    expect(res.status).toBe(404)
    expect(res.text).not.toBe(build.indexHtml)
  })
})

// An API path nothing answers is a JSON 404, even from a browser (#92).
describe('unknown /api routes 404 as JSON', () => {
  it.each([
    ['get', '/api/v1/nothing'],
    ['get', '/api'],
    ['get', '/api/v1/accounts/acc_abc123/nothing'],
    ['post', '/api/v1/nothing'],
    ['delete', '/api/v1/categories'],
  ] as const)('%s %s is a JSON 404, never index.html', async (method, path) => {
    const res = await request(app)[method](path).set('Accept', BROWSER_ACCEPT)

    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'Not found' })
    expect(Object.keys(res.body)).toEqual(['error'])
  })
})

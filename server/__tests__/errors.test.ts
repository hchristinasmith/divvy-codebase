import { inspect } from 'node:util'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../test-utils/app.ts'

// The /api error handler in server.ts (#177, #185). The barrel is wrapped, not
// replaced: every real router stays mounted, and a stand-in router adds routes
// that fail on purpose, so a route error can be provoked without editing any
// router file.
const SECRET = 'secret detail /Users/someone/divvy'
// Carried in an error field, as body-parser carries the raw request text in
// `err.body`: it must reach neither the response nor the log.
const FIELD_SECRET = 'raw request text in a field'
// Sent as a request header on every request below: it must reach neither the
// response nor the log.
const HEADER_SECRET = 'header secret marker 5a1e0c'
// The message on an upstream AkahuError or XeroClientError (#203).
const UPSTREAM_SECRET = 'upstream refusal marker 7c2d'
// A value bound into a failing Knex insert; Knex puts it in err.message (#204).
const BOUND_VALUE = 'BINDING_VALUE_42'

vi.mock('../routes/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/index.ts')>()
  const { default: express } = await import('express')
  const router = express.Router()
  router.get('/__test/throws', () => {
    throw new Error(SECRET)
  })
  router.get('/__test/next-error', (req, res, next) => {
    next(Object.assign(new Error(SECRET), { body: FIELD_SECRET, status: 418 }))
  })
  router.get('/__test/status-code-404', (req, res, next) => {
    next(Object.assign(new Error(SECRET), { body: FIELD_SECRET, statusCode: 404 }))
  })
  router.get('/__test/status-503', (req, res, next) => {
    next(Object.assign(new Error(SECRET), { body: FIELD_SECRET, status: 503 }))
  })
  router.get('/__test/status-503-code-404', (req, res, next) => {
    next(
      Object.assign(new Error(SECRET), {
        body: FIELD_SECRET,
        status: 503,
        statusCode: 404,
      }),
    )
  })
  router.get('/__test/status-string-code-404', (req, res, next) => {
    next(
      Object.assign(new Error(SECRET), {
        body: FIELD_SECRET,
        status: '418',
        statusCode: 404,
      }),
    )
  })
  router.get('/__test/status-302', (req, res, next) => {
    next(Object.assign(new Error(SECRET), { body: FIELD_SECRET, status: 302 }))
  })
  router.get('/__test/status-404-point-5', (req, res, next) => {
    next(Object.assign(new Error(SECRET), { body: FIELD_SECRET, status: 404.5 }))
  })
  router.get('/__test/status-code-404-point-5', (req, res, next) => {
    next(
      Object.assign(new Error(SECRET), { body: FIELD_SECRET, statusCode: 404.5 }),
    )
  })
  // #203, #204: errors from the real classes and a real failing Knex query.
  // These modules only declare classes and constants on import; nothing reads
  // the environment, opens a socket or calls an API.
  const { AkahuError } = await import('../sync/akahu-client.ts')
  const { XeroClientError } = await import('../xero/client/errors.ts')
  const { default: connection } = await import('../db/connection.ts')
  router.get('/__test/akahu-401', (req, res, next) => {
    next(new AkahuError('unauthorized', UPSTREAM_SECRET, 401))
  })
  router.get('/__test/xero-429', (req, res, next) => {
    next(new XeroClientError('rate_limited', UPSTREAM_SECRET, 429, 30))
  })
  router.get('/__test/knex-insert', async (req, res, next) => {
    try {
      await connection('nonexistent_table').insert({ a: BOUND_VALUE })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })
  router.use(actual.default)
  return { default: router }
})

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
  vi.restoreAllMocks()
})

afterAll(closeDb)

// What Express's default error page and a Node stack trace contain.
const STACK_MARKERS = [
  'at ',
  'node_modules',
  '/Users/',
  'SyntaxError',
  'Error:',
  'server.ts',
  '<pre>',
]

function expectNoLeak(text: string): void {
  for (const marker of STACK_MARKERS) expect(text).not.toContain(marker)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(FIELD_SECRET)
  expect(text).not.toContain(HEADER_SECRET)
}

const MALFORMED = '{"not json'
// Over express.json()'s 100kb default limit.
const OVERSIZE_JSON = JSON.stringify({ pad: 'x'.repeat(101 * 1024) })
// Over express.urlencoded()'s 1000-parameter default limit.
const MANY_PARAMS = Array.from({ length: 1001 }, (_, i) => `k${i}=1`).join('&')

describe('a malformed JSON body on /api is a fixed JSON 400', () => {
  it.each([
    ['patch', '/api/v1/transactions/1'],
    ['post', '/api/v1/categories'],
    ['post', '/api/v1/nothing'],
  ] as const)(
    '%s %s answers { error: "Bad request" } with no stack',
    async (method, path) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await api[method](path)
        .set('Content-Type', 'application/json')
        .send(MALFORMED)

      expect(res.status).toBe(400)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toEqual({ error: 'Bad request' })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      // The raw body travels on the parse error as err.body; a 400 is the
      // client's fault and is not logged at all.
      expect(errorLog).not.toHaveBeenCalled()
    },
  )
})

// A 4xx status answers that status with fixed text and is never logged (#185).
// The 418 comes from a route's own `status`, not from a malformed request; it
// is answered by the same rule.
describe('a client error on /api answers its own status with fixed text, and is not logged', () => {
  it.each([
    [
      'an oversize JSON body',
      413,
      'Payload too large',
      () =>
        api
          .post('/api/v1/nothing')
          .set('Content-Type', 'application/json')
          .set('X-Divvy-Test', HEADER_SECRET)
          .send(OVERSIZE_JSON),
    ],
    [
      'more than 1000 urlencoded parameters',
      413,
      'Payload too large',
      () =>
        api
          .post('/api/v1/nothing')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .set('X-Divvy-Test', HEADER_SECRET)
          .send(MANY_PARAMS),
    ],
    [
      'an unsupported charset',
      415,
      'Unsupported media type',
      () =>
        api
          .post('/api/v1/nothing')
          .set('Content-Type', 'application/json; charset=utf-9')
          .set('X-Divvy-Test', HEADER_SECRET)
          .send('{}'),
    ],
    [
      'an unsupported Content-Encoding',
      415,
      'Unsupported media type',
      () =>
        api
          .post('/api/v1/nothing')
          .set('Content-Type', 'application/json')
          .set('Content-Encoding', 'bogus')
          .set('X-Divvy-Test', HEADER_SECRET)
          .send('{}'),
    ],
    [
      'a percent-encoding that does not decode',
      400,
      'Bad request',
      () =>
        api
          .patch('/api/v1/transactions/%E0%A4%A')
          .set('X-Divvy-Test', HEADER_SECRET),
    ],
    [
      'a route error whose status is 418',
      418,
      'Client error',
      () => api.get('/api/v1/__test/next-error').set('X-Divvy-Test', HEADER_SECRET),
    ],
    [
      'a route error with only a statusCode of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/status-code-404')
          .set('X-Divvy-Test', HEADER_SECRET),
    ],
    [
      'a non-integer status of "418" beside a statusCode of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/status-string-code-404')
          .set('X-Divvy-Test', HEADER_SECRET),
    ],
  ] as const)(
    '%s answers %i with { error: "%s" }',
    async (_what, status, text, send) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await send()

      expect(res.status).toBe(status)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toStrictEqual({ error: text })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      expect(errorLog).not.toHaveBeenCalled()
    },
  )
})

describe('a route error on /api with no client status is a fixed JSON 500', () => {
  it.each([
    ['a synchronous throw', '/api/v1/__test/throws'],
    ['next(err) with a 5xx status', '/api/v1/__test/status-503'],
    // status wins over statusCode, so a 5xx status is not overruled by a 404.
    ['a 5xx status beside a statusCode of 404', '/api/v1/__test/status-503-code-404'],
    // A 3xx is a redirect, not a client error.
    ['next(err) with a 3xx status', '/api/v1/__test/status-302'],
    // A non-integer status is not an HTTP status, and nothing else is read.
    ['next(err) with a non-integer status of 404.5', '/api/v1/__test/status-404-point-5'],
    ['next(err) with a non-integer statusCode of 404.5', '/api/v1/__test/status-code-404-point-5'],
  ])(
    '%s answers { error: "Internal server error" } with no message or stack',
    async (_how, path) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await api.get(path).set('X-Divvy-Test', HEADER_SECRET)

      expect(res.status).toBe(500)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toEqual({ error: 'Internal server error' })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      expect(errorLog).toHaveBeenCalledTimes(1)
      // The stack is logged, never the error object and its fields.
      expect(inspect(errorLog.mock.calls)).not.toContain(FIELD_SECRET)
      // The request header reaches neither the response nor the log.
      expect(inspect(errorLog.mock.calls)).not.toContain(HEADER_SECRET)
    },
  )
})

// Express's default handling is kept off /api, including for /apiary.
describe('a non-/api error is not converted', () => {
  it.each(['/targets', '/apiary'])(
    'a malformed JSON body on POST %s is not a JSON answer',
    async (path) => {
      const res = await api
        .post(path)
        .set('Content-Type', 'application/json')
        .send(MALFORMED)

      expect(res.status).toBe(400)
      expect(res.headers['content-type']).toMatch(/^text\/html/)
    },
  )
})

// PRE-FIX BEHAVIOUR, pinned before #203 changes it. An upstream 4xx carried on
// AkahuError or XeroClientError (an expired token, a revoked app, a rate
// limit) is read as the caller's fault: it answers that status and nothing is
// logged. #203's fix will flip the "not logged" assertion.
describe('#203 pre-fix: an upstream 4xx on AkahuError or XeroClientError answers as a client error and is not logged', () => {
  it.each([
    ['an AkahuError with status 401', '/api/v1/__test/akahu-401', 401],
    ['a XeroClientError with status 429', '/api/v1/__test/xero-429', 429],
  ] as const)(
    '%s answers that status with { error: "Client error" } and no log',
    async (_what, path, status) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await api.get(path).set('X-Divvy-Test', HEADER_SECRET)

      expect(res.status).toBe(status)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toStrictEqual({ error: 'Client error' })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      expect(res.text).not.toContain(UPSTREAM_SECRET)
      expect(errorLog).not.toHaveBeenCalled()
    },
  )
})

// PRE-FIX BEHAVIOUR, pinned before #204 changes it. The 500 log is err.stack,
// whose first line is `name: message`, and Knex puts the SQL and its bound
// values in the message, so a row value reaches the log. #204's fix will flip
// the BOUND_VALUE assertion on the log.
//
// The error is node-sqlite3's, raised from native code, so its stack has no
// JavaScript frames at all: today the logged stack is the message line alone.
// A fix that logs `err.name` plus the frames would log only `Error` here.
describe('#204 pre-fix: a failing Knex query on /api logs its bound values in the 500 stack', () => {
  it('answers a fixed 500 and logs a stack that is only the message line, bound value included', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api
      .get('/api/v1/__test/knex-insert')
      .set('X-Divvy-Test', HEADER_SECRET)

    expect(res.status).toBe(500)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(Object.keys(res.body)).toEqual(['error'])
    expectNoLeak(res.text)
    expect(res.text).not.toContain(BOUND_VALUE)
    expect(errorLog).toHaveBeenCalledTimes(1)
    const [call] = errorLog.mock.calls
    expect(call).toHaveLength(2)
    expect(call[0]).toBe('Unhandled /api error:')
    const stack: unknown = call[1]
    if (typeof stack !== 'string') throw new Error('expected a logged stack')
    // The query's bound value is in the logged message line: the #204 leak.
    expect(stack).toMatch(/^Error: insert into /)
    expect(stack).toContain(BOUND_VALUE)
    // One line, no stack frames.
    expect(stack).not.toContain('\n')
    expect(stack).not.toMatch(/\bat /)
    expect(inspect(errorLog.mock.calls)).not.toContain(HEADER_SECRET)
  })
})

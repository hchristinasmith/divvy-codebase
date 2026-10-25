import { inspect } from 'node:util'
import type { Express } from 'express'
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
// The fixed text of the one line a 4xx not raised by body-parser or the
// router logs (#203).
const UNKNOWN_4XX_LOG = '4xx /api error not raised by body-parser or the router:'
// The message on a route Error carrying a SQLite-shaped `code` (#354).
const CODED_SECRET = 'coded failure marker 3e8a'
const SQLITE_CODE = 'SQLITE_CONSTRAINT'

// The last coded Error a route raised, so a test can read the frames its
// stack holds and pin the whole logged line, not a pattern (#354).
// The Knex route keeps its error too, to pin that it does carry a `code`.
const raised = vi.hoisted(() => ({
  coded: undefined as Error | undefined,
  knex: undefined as unknown,
}))

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
  router.get('/__test/akahu-no-status', (req, res, next) => {
    next(new AkahuError('network', UPSTREAM_SECRET, null))
  })
  // A 400 carrying a given body-parser `type`, for the types a request
  // through supertest cannot provoke.
  router.get('/__test/typed-400/:type', (req, res, next) => {
    next(
      Object.assign(new Error(SECRET), {
        body: FIELD_SECRET,
        status: 400,
        type: req.params.type,
      }),
    )
  })
  router.get('/__test/plain-object-404', (req, res, next) => {
    next({ status: 404, detail: SECRET })
  })
  // A 401 whose `type` cannot be read: deciding whether to log must not
  // throw past the handler, or Express answers an HTML 500 instead.
  router.get('/__test/type-getter-throws-401', (req, res, next) => {
    const err = Object.assign(new Error(SECRET), { status: 401 })
    Object.defineProperty(err, 'type', {
      get() {
        throw new Error(FIELD_SECRET)
      },
    })
    next(err)
  })
  // A 401 whose prototype cannot be read, so neither `instanceof` nor the
  // constructor name can be worked out.
  router.get('/__test/prototype-throws-401', (req, res, next) => {
    next(
      new Proxy(Object.assign(new Error(SECRET), { status: 401 }), {
        getPrototypeOf() {
          throw new Error(FIELD_SECRET)
        },
      }),
    )
  })
  // A 401 that passes the decision but whose prototype's `constructor`
  // cannot be read, so only naming it throws.
  router.get('/__test/constructor-throws-401', (req, res, next) => {
    const proto = new Proxy(Error.prototype, {
      getOwnPropertyDescriptor() {
        throw new Error(FIELD_SECRET)
      },
    })
    next(Object.assign(Object.create(proto) as object, { status: 401 }))
  })
  router.get('/__test/plain-object', (req, res, next) => {
    next({ detail: SECRET })
  })
  // A message line shaped like a stack frame must not pass as one (#204).
  router.get('/__test/multi-line-message', () => {
    throw new Error(`${SECRET}\n    at ${BOUND_VALUE} (/x.ts:1:1)`)
  })
  // The stack is formatted while the message holds SECRET and a frame-shaped
  // line; the message is then replaced by one as long as SECRET, so the stack
  // no longer starts with `name: message`, and cutting the header off by
  // length alone would leave the frame-shaped line behind.
  router.get('/__test/message-changed-after-stack', () => {
    const err = new Error(`${SECRET}\n    at ${BOUND_VALUE} (/x.ts:1:1)`)
    void err.stack
    err.message = 'x'.repeat(SECRET.length)
    throw err
  })
  // A stack replaced by hand, with a line after the header that is no frame.
  router.get('/__test/replaced-stack', () => {
    const err = new Error('replaced')
    err.stack = `Error: replaced\n${SECRET}\n    at nothing (/x.ts:1:1)`
    throw err
  })
  // An error once the response has started, as a Knex error would carry it.
  router.get('/__test/after-headers', (req, res, next) => {
    res.status(200).write('partial')
    next(new Error(`insert into t (a) values ('${BOUND_VALUE}')`))
  })
  // A client status once the response has started is answered no differently.
  router.get('/__test/after-headers-401', (req, res, next) => {
    res.status(200).write('partial')
    next(Object.assign(new Error(SECRET), { status: 401 }))
  })
  // A non-Error once the response has started; turned into a string, it would
  // be SECRET.
  router.get('/__test/after-headers-non-error', (req, res, next) => {
    res.status(200).write('partial')
    next({
      toString() {
        return SECRET
      },
    })
  })
  // A 500 whose stack cannot be read.
  router.get('/__test/stack-getter-throws', () => {
    const err = new Error(SECRET)
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error(FIELD_SECRET)
      },
    })
    throw err
  })
  // A 500 whose name is not a string.
  router.get('/__test/name-not-a-string', () => {
    throw Object.assign(new Error(SECRET), { name: 42 })
  })
  router.get('/__test/null-prototype-404', (req, res, next) => {
    next(Object.assign(Object.create(null) as object, { status: 404 }))
  })
  // A class expression bound to no name has an empty `name`.
  router.get('/__test/anonymous-class-404', (req, res, next) => {
    next(Object.assign(new (class {})(), { status: 404 }))
  })
  // An Error with a SQLite-shaped `code`, as node-sqlite3 sets it, but raised
  // in JavaScript so its stack has frames (#354).
  router.get('/__test/coded-error', (req, res, next) => {
    raised.coded = Object.assign(new Error(CODED_SECRET), { code: SQLITE_CODE })
    next(raised.coded)
  })
  router.get('/__test/after-headers-coded', (req, res, next) => {
    res.status(200).write('partial')
    raised.coded = Object.assign(new Error(CODED_SECRET), { code: SQLITE_CODE })
    next(raised.coded)
  })
  router.get('/__test/knex-insert', async (req, res, next) => {
    try {
      await connection('nonexistent_table').insert({ a: BOUND_VALUE })
      res.status(204).end()
    } catch (err) {
      raised.knex = err
      next(err)
    }
  })
  router.use(actual.default)
  return { default: router }
})

let served: LoopbackApi | undefined
let api: LoopbackApi['api']
let app: Express

beforeEach(async () => {
  raised.coded = undefined
  raised.knex = undefined
  app = await freshApp()
  served = await serveOnLoopback(app)
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

// No message, field or request text reaches the log (#177, #203, #204).
function expectNoLogLeak(calls: unknown[][]): void {
  const logged = inspect(calls)
  for (const secret of [
    SECRET,
    FIELD_SECRET,
    HEADER_SECRET,
    UPSTREAM_SECRET,
    BOUND_VALUE,
    CODED_SECRET,
  ]) {
    expect(logged).not.toContain(secret)
  }
}

// The one line a 500 logs: its prefix and the logged text.
function the500Log(calls: unknown[][]): string {
  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call).toHaveLength(2)
  expect(call[0]).toBe('Unhandled /api error:')
  const text: unknown = call[1]
  if (typeof text !== 'string') throw new Error('expected a logged string')
  return text
}

const MALFORMED = '{"not json'
// Over express.json()'s 100kb default limit.
const OVERSIZE_JSON = JSON.stringify({ pad: 'x'.repeat(101 * 1024) })
// Over express.urlencoded()'s 1000-parameter default limit.
const MANY_PARAMS = Array.from({ length: 1001 }, (_, i) => `k${i}=1`).join('&')
// Past express.urlencoded({ extended: true })'s default nesting depth of 32.
const TOO_DEEP = `a${'[b]'.repeat(33)}=1`

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

// A 4xx status answers that status with fixed text (#185). One that
// body-parser or the router raised about the request is not logged; any other
// logs one fixed line with its status and constructor name, never its message
// or fields (#203). The 418 comes from a route's own `status`, not from a
// malformed request; it answers by the same rule.
describe('a client error on /api answers its own status with fixed text; only one not raised by body-parser or the router is logged', () => {
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
      [],
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
      [],
    ],
    [
      'a urlencoded body nested deeper than the depth limit',
      400,
      'Bad request',
      () =>
        api
          .post('/api/v1/nothing')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .set('X-Divvy-Test', HEADER_SECRET)
          .send(TOO_DEEP),
      [],
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
      [],
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
      [],
    ],
    [
      // body-parser wraps the zlib error in a 400 with no `type`.
      'a gzip body that does not inflate',
      400,
      'Bad request',
      () =>
        api
          .post('/api/v1/nothing')
          .set('Content-Type', 'application/json')
          .set('Content-Encoding', 'gzip')
          .set('X-Divvy-Test', HEADER_SECRET)
          .send(MALFORMED),
      [[UNKNOWN_4XX_LOG, 400, 'Error']],
    ],
    [
      'a percent-encoding that does not decode',
      400,
      'Bad request',
      () =>
        api
          .patch('/api/v1/transactions/%E0%A4%A')
          .set('X-Divvy-Test', HEADER_SECRET),
      [],
    ],
    [
      'a route error whose status is 418',
      418,
      'Client error',
      () => api.get('/api/v1/__test/next-error').set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 418, 'Error']],
    ],
    [
      'a route error with only a statusCode of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/status-code-404')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 404, 'Error']],
    ],
    [
      'a non-integer status of "418" beside a statusCode of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/status-string-code-404')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 404, 'Error']],
    ],
    [
      'a plain object with a status of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/plain-object-404')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 404, 'Object']],
    ],
    [
      'a null-prototype object with a status of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/null-prototype-404')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 404, 'null prototype']],
    ],
    [
      'an instance of an anonymous class with a status of 404',
      404,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/anonymous-class-404')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 404, 'unknown']],
    ],
    // Nothing read from the error names it when reading throws.
    [
      'a 401 whose type getter throws',
      401,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/type-getter-throws-401')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 401, 'unknown']],
    ],
    [
      'a 401 whose prototype cannot be read',
      401,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/prototype-throws-401')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 401, 'unknown']],
    ],
    [
      "a 401 whose prototype's constructor cannot be read",
      401,
      'Client error',
      () =>
        api
          .get('/api/v1/__test/constructor-throws-401')
          .set('X-Divvy-Test', HEADER_SECRET),
      [[UNKNOWN_4XX_LOG, 401, 'unknown']],
    ],
  ] as const)(
    '%s answers %i with { error: "%s" }',
    async (_what, status, text, send, logged) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await send()

      expect(res.status).toBe(status)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toStrictEqual({ error: text })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      // Nothing, or the one fixed line: status and constructor name.
      expect(errorLog.mock.calls).toStrictEqual(logged)
      expectNoLogLeak(errorLog.mock.calls)
    },
  )
})

describe('a route error on /api with no client status is a fixed JSON 500 that logs its name and stack frames only', () => {
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
    '%s answers { error: "Internal server error" } and logs no message',
    async (_how, path) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await api.get(path).set('X-Divvy-Test', HEADER_SECRET)

      expect(res.status).toBe(500)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toStrictEqual({ error: 'Internal server error' })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      // The name and the stack frames are logged, never the message, the
      // error object or its fields (#204). The request header reaches neither
      // the response nor the log.
      const logged = the500Log(errorLog.mock.calls)
      expect(logged).toMatch(/^Error\n {4}at \S/)
      expect(logged.split('\n').slice(1).every((l) => /^ {4}at \S/.test(l))).toBe(true)
      expectNoLogLeak(errorLog.mock.calls)
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

// body-parser and raw-body types that no request above provokes: a client
// that aborts gets no answer to assert on, a short body against its
// Content-Length waits on the socket, and no parser here has a `verify`
// option. The type alone decides; a type they never set is logged.
describe('#203: a 4xx carrying a body-parser type is not logged; any other type is', () => {
  it.each([
    ['request.aborted', []],
    ['request.size.invalid', []],
    ['entity.verify.failed', []],
    ['entity.not.a.body-parser.type', [[UNKNOWN_4XX_LOG, 400, 'Error']]],
  ] as const)('type %s', async (type, logged) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api
      .get(`/api/v1/__test/typed-400/${type}`)
      .set('X-Divvy-Test', HEADER_SECRET)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'Bad request' })
    expect(Object.keys(res.body)).toEqual(['error'])
    expectNoLeak(res.text)
    expect(errorLog.mock.calls).toStrictEqual(logged)
    expectNoLogLeak(errorLog.mock.calls)
  })
})

// An upstream 4xx carried on AkahuError or XeroClientError (an expired token,
// a revoked app, a rate limit) answers that status as before, and now logs one
// fixed line: the status and the constructor name, never the message (#203).
describe('#203: an upstream 4xx on AkahuError or XeroClientError answers its status and logs its status and constructor name only', () => {
  it.each([
    ['an AkahuError with status 401', '/api/v1/__test/akahu-401', 401, 'AkahuError'],
    ['a XeroClientError with status 429', '/api/v1/__test/xero-429', 429, 'XeroClientError'],
  ] as const)(
    '%s answers that status with { error: "Client error" } and logs one fixed line',
    async (_what, path, status, constructorName) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await api.get(path).set('X-Divvy-Test', HEADER_SECRET)

      expect(res.status).toBe(status)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toStrictEqual({ error: 'Client error' })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      expect(res.text).not.toContain(UPSTREAM_SECRET)
      expect(errorLog.mock.calls).toStrictEqual([
        [UNKNOWN_4XX_LOG, status, constructorName],
      ])
      expectNoLogLeak(errorLog.mock.calls)
    },
  )
})

// A 500's log is `err.name` and the stack frames, never the stack's first
// line, which is `name: message` (#204). Knex puts the SQL and its bound values
// in the message. node-sqlite3 raises its error from native code, so it has no
// JavaScript frames and logs as its name alone.
describe('#204: a 500 on /api logs the error name and stack frames, never the message', () => {
  it('a failing Knex query answers a fixed 500 and logs only `Error`, not its bound value', async () => {
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
    expect(the500Log(errorLog.mock.calls)).toBe('Error')
    expectNoLogLeak(errorLog.mock.calls)
  })

  it('a message with a line shaped like a frame logs the real frames and none of the message', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api.get('/api/v1/__test/multi-line-message')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    const logged = the500Log(errorLog.mock.calls)
    expect(logged).toMatch(/^Error\n {4}at \S/)
    // The real frame of the route that threw.
    expect(logged).toContain('errors.test.ts')
    expectNoLogLeak(errorLog.mock.calls)
  })

  it.each([
    ['a stack formatted before the message changed', '/api/v1/__test/message-changed-after-stack'],
    ['a replaced stack with a line that is not a frame', '/api/v1/__test/replaced-stack'],
  ])('%s logs only `Error`', async (_what, path) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api.get(path)

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(the500Log(errorLog.mock.calls)).toBe('Error')
    expectNoLogLeak(errorLog.mock.calls)
  })

  it('an AkahuError with no status logs its own name and its frames', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api.get('/api/v1/__test/akahu-no-status')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(the500Log(errorLog.mock.calls)).toMatch(/^AkahuError\n {4}at \S/)
    expectNoLogLeak(errorLog.mock.calls)
  })

  it('a 500 whose stack getter throws answers the fixed JSON and logs only its name', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api
      .get('/api/v1/__test/stack-getter-throws')
      .set('X-Divvy-Test', HEADER_SECRET)

    expect(res.status).toBe(500)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(Object.keys(res.body)).toEqual(['error'])
    expectNoLeak(res.text)
    expect(the500Log(errorLog.mock.calls)).toBe('Error')
    expectNoLogLeak(errorLog.mock.calls)
  })

  it('a 500 whose name is not a string logs `Error` and its frames', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api
      .get('/api/v1/__test/name-not-a-string')
      .set('X-Divvy-Test', HEADER_SECRET)

    expect(res.status).toBe(500)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(Object.keys(res.body)).toEqual(['error'])
    expectNoLeak(res.text)
    expect(the500Log(errorLog.mock.calls)).toMatch(/^Error\n {4}at \S/)
    expectNoLogLeak(errorLog.mock.calls)
  })

  // Express's default handler logs `err.stack` only outside env `test`, so the
  // app runs as production here: handing the error on would log the bound
  // value.
  it.each([
    [
      'an Error carrying a bound value',
      '/api/v1/__test/after-headers',
      /^Error\n {4}at \S/,
    ],
    [
      'an Error with a status of 401',
      '/api/v1/__test/after-headers-401',
      /^Error\n {4}at \S/,
    ],
    [
      'a value that is not an Error',
      '/api/v1/__test/after-headers-non-error',
      /^object$/,
    ],
  ] as const)(
    '%s after the response started resets the connection and logs no message',
    async (_what, path, logged) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const env: unknown = app.get('env')
      app.set('env', 'production')
      try {
        await expect(
          api.get(path).set('X-Divvy-Test', HEADER_SECRET),
        ).rejects.toMatchObject({ code: 'ECONNRESET' })
        // Express's default handler logs on the next turn.
        await new Promise((resolve) => setImmediate(resolve))
      } finally {
        app.set('env', env)
      }

      expectNoLogLeak(errorLog.mock.calls)
      expect(errorLog.mock.calls).toHaveLength(1)
      const [call] = errorLog.mock.calls
      expect(call).toHaveLength(2)
      expect(call[0]).toBe('Unhandled /api error after the response started:')
      expect(call[1]).toMatch(logged)
    },
  )

  it('a value that is not an Error logs its typeof only', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api.get('/api/v1/__test/plain-object')

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(Object.keys(res.body)).toEqual(['error'])
    expect(the500Log(errorLog.mock.calls)).toBe('object')
    expectNoLogLeak(errorLog.mock.calls)
  })
})

// The frame lines of the coded Error a route raised, read from its own stack:
// its header is `Error: <message>` on one line, and at least one frame follows.
function framesOfCoded(): string[] {
  const err = raised.coded
  if (err === undefined || typeof err.stack !== 'string') {
    throw new Error('expected the route to have raised a coded Error')
  }
  const [header, ...frames] = err.stack.split('\n')
  expect(header).toBe(`Error: ${CODED_SECRET}`)
  expect(frames.length).toBeGreaterThan(0)
  return frames
}

// #354, before the change: what a 500 carrying an `err.code` logs today. The
// whole log is pinned, so a code appearing in it, or anything else changing,
// turns these red. The coded tests are expected to flip once the handler logs
// a constant-shaped `err.code`; the message must stay out either way.
describe('#354 before the change: a 500 carrying err.code logs the name and frames only, not the code', () => {
  it('a failing Knex insert carries code SQLITE_ERROR and logs exactly `Error`, no code and no bound value', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api
      .get('/api/v1/__test/knex-insert')
      .set('X-Divvy-Test', HEADER_SECRET)

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    // The premise #354 rests on: node-sqlite3 sets a constant-shaped code, and
    // the message holds the bound value.
    expect(raised.knex).toBeInstanceOf(Error)
    expect((raised.knex as Error & { code?: unknown }).code).toBe('SQLITE_ERROR')
    expect((raised.knex as Error).message).toContain(BOUND_VALUE)
    expect(errorLog.mock.calls).toStrictEqual([['Unhandled /api error:', 'Error']])
    expectNoLogLeak(errorLog.mock.calls)
  })

  it('today: a route Error with code SQLITE_CONSTRAINT logs `Error` and its frames, without the code', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await api
      .get('/api/v1/__test/coded-error')
      .set('X-Divvy-Test', HEADER_SECRET)

    expect(res.status).toBe(500)
    expect(res.body).toStrictEqual({ error: 'Internal server error' })
    expect(Object.keys(res.body)).toEqual(['error'])
    expectNoLeak(res.text)
    expect(errorLog.mock.calls).toStrictEqual([
      ['Unhandled /api error:', ['Error', ...framesOfCoded()].join('\n')],
    ])
    expectNoLogLeak(errorLog.mock.calls)
  })

  // As in the #204 headers-sent tests above, the app runs as production so
  // Express's default handler would log the stack if the error reached it.
  it('today: the same coded Error after the response started logs `Error` and its frames, without the code', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env: unknown = app.get('env')
    app.set('env', 'production')
    try {
      await expect(
        api
          .get('/api/v1/__test/after-headers-coded')
          .set('X-Divvy-Test', HEADER_SECRET),
      ).rejects.toMatchObject({ code: 'ECONNRESET' })
      // Express's default handler logs on the next turn.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      app.set('env', env)
    }

    expect(errorLog.mock.calls).toStrictEqual([
      [
        'Unhandled /api error after the response started:',
        ['Error', ...framesOfCoded()].join('\n'),
      ],
    ])
    expectNoLogLeak(errorLog.mock.calls)
  })
})

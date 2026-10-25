import { inspect } from 'node:util'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../test-utils/app.ts'

// The /api error handler in server.ts (#177). The barrel is wrapped, not
// replaced: every real router stays mounted, and a stand-in router adds two
// routes that fail on purpose, so a route error can be provoked without
// editing any router file.
const SECRET = 'secret detail /Users/someone/divvy'
// Carried in an error field, as body-parser carries the raw request text in
// `err.body`: it must reach neither the response nor the log.
const FIELD_SECRET = 'raw request text in a field'

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
}

const MALFORMED = '{"not json'

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

describe('a route error on /api is a fixed JSON 500', () => {
  it.each([
    ['a synchronous throw', '/api/v1/__test/throws'],
    ['next(err)', '/api/v1/__test/next-error'],
  ])(
    '%s answers { error: "Internal server error" } with no message or stack',
    async (_how, path) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await api.get(path)

      expect(res.status).toBe(500)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toEqual({ error: 'Internal server error' })
      expect(Object.keys(res.body)).toEqual(['error'])
      expectNoLeak(res.text)
      expect(errorLog).toHaveBeenCalledTimes(1)
      // The stack is logged, never the error object and its fields.
      expect(inspect(errorLog.mock.calls)).not.toContain(FIELD_SECRET)
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

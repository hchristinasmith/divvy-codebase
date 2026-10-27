import { join } from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import * as Path from 'node:path'
import * as URL from 'node:url'
import 'dotenv/config'

import routes from './routes/index.ts'

const __filename = URL.fileURLToPath(import.meta.url)
const __dirname = Path.dirname(__filename)

const server = express()

server.use(express.urlencoded({ extended: true }))
server.use(express.json())
const publicDir = join(__dirname, './public')
server.use(express.static(publicDir))

server.use('/api/v1', routes)

// An /api path no router answered is a JSON 404, whatever the request
// accepts: it must never fall through to the client's index.html (#92).
server.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Single-page-app fallback (#92). The client owns its routes (/targets,
// /settings, ...), so a GET for a page that is not a static file gets
// index.html and react-router takes it from there; without this a refresh on
// any route but / is a 404 in production. Requests that do not accept HTML
// fall through to Express's 404. Without a client build (dev, tests) there is
// no index.html, and the request falls through to the same 404.
server.get('*', (req, res, next) => {
  if (!req.accepts('html')) return next()
  res.sendFile(join(publicDir, 'index.html'), (err) => {
    if (err && !res.headersSent) next()
  })
})

// An error on an /api path is fixed-text JSON (#177). express.json() throws
// on a malformed body before any router runs, and Express's default handler
// answers with an HTML page carrying the stack and absolute paths outside
// production. The response never carries the error's message, stack or
// fields. Other paths keep Express's default handling.
//
// An error whose `status` is a 4xx integer, or which has no integer `status`
// and a 4xx integer `statusCode`, answers that status with a fixed text
// (#185). Anything else, including a 5xx status, is a 500 with the fixed text.
//
// What is logged, never the error object, its message or its fields (a
// body-parser error holds the raw request text in `err.body`; a Knex error's
// message holds the SQL and its bound values, #204):
// - A 4xx carrying a `type` that body-parser or raw-body sets on the request
//   itself (a malformed or oversize body, an unsupported charset or
//   Content-Encoding), or the router's URIError for a bad percent-encoded
//   path: nothing. It is the client's fault.
// - Any other 4xx, such as an upstream 401 or 429 carried on an AkahuError or
//   XeroClientError (#203): one fixed line with the status and the
//   constructor name, or `unknown` if reading the error to tell whether
//   body-parser or the router raised it, or to name it, throws; the answer is
//   the same either way. An expired token or a rate limit is not the caller's
//   mistake and must leave a trace. A gzip or deflate body that does not
//   inflate is body-parser's 400 with no `type`, so it logs this line too.
// - A 500 from an Error: `err.name`, or `Error` if it cannot be read or is not
//   a string, and the stack frames, without the stack's first line, which is
//   `name: message`. When the stack does not start with that line, or a line
//   after it is not a frame, no frames are logged.
//   A message shortened after its stack was formatted is not caught: any
//   frame-shaped lines it lost are logged as frames. An error raised from
//   native code (node-sqlite3, under Knex) has no frames, so it would log as
//   its name alone; its `err.code` (`SQLITE_CONSTRAINT`) says what failed
//   (#354). So when `err.code` is a short string of capital letters, digits
//   and underscores that starts with a letter (`CONSTANT_CODE` below), it
//   follows the name on the same line, after a space, and the frames follow
//   as before. Any other `code`, or one that cannot be read (a getter or Proxy
//   trap that throws), adds nothing; the answer is the same either way.
// - A 500 from anything that is not an Error: its `typeof`.
// - An error after the response started: the same as a 500, on its own line,
//   whatever its status; the socket is destroyed.
//
// What a read of the error throws (a getter, or a Proxy trap) never reaches the
// response or the log. Each read that decides or names the error falls back to
// a fixed value (#363): a status that cannot be read is no client status, so
// the error is a 500; a name that cannot be read is `Error`; an
// `instanceof Error` that throws means the error cannot be shown to be one, so
// it logs its `typeof`, as any non-Error does.
const CLIENT_ERROR_TEXT: Partial<Record<number, string>> = {
  400: 'Bad request',
  413: 'Payload too large',
  415: 'Unsupported media type',
}

// The `type` body-parser 1.20 and raw-body 2.5 set on every 4xx error they
// raise about a request. Read from their source; their 5xx types are not here
// because a 5xx never reaches the 4xx branch.
const REQUEST_ERROR_TYPES: ReadonlySet<string> = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'parameters.too.many',
  'querystring.parse.rangeError',
  'request.aborted',
  'request.size.invalid',
])

/**
 * The 4xx status an error carries, or undefined for anything else. A status
 * that cannot be read (a getter or Proxy trap that throws) is no client status,
 * so the error is answered as a 500 (#363).
 */
function clientStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  let status: unknown
  try {
    status =
      'status' in err && Number.isInteger(err.status)
        ? err.status
        : 'statusCode' in err
          ? err.statusCode
          : undefined
  } catch {
    return undefined
  }
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 499
    ? status
    : undefined
}

/**
 * Whether a 4xx error is body-parser's or the router's verdict on the request.
 * Express's router turns a path parameter that does not percent-decode into a
 * URIError with status 400.
 */
function isRequestError(err: object): boolean {
  if (err instanceof URIError) return true
  return (
    'type' in err &&
    typeof err.type === 'string' &&
    REQUEST_ERROR_TYPES.has(err.type)
  )
}

/** The name of the class an object was made by, read from its prototype. */
function constructorName(err: object): string {
  const proto: unknown = Object.getPrototypeOf(err)
  if (typeof proto !== 'object' || proto === null) return 'null prototype'
  const ctor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')
    ?.value
  return typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'unknown'
}

/**
 * Whether err is an Error. Reading its prototype may run a Proxy trap that
 * throws; an error that cannot be shown to be one is not treated as one (#363).
 */
function isError(err: unknown): err is Error {
  try {
    return err instanceof Error
  } catch {
    return false
  }
}

const FRAME = /^ {4}at \S/

// A constant-shaped error code, such as node-sqlite3's `SQLITE_CONSTRAINT` or
// Node's `ECONNRESET`: never a message, so never a bound value (#354). `$`
// without the `m` flag matches only at the end of the string.
const CONSTANT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * `err.code` if it is constant-shaped, or undefined. Reading it may run a
 * getter or a Proxy trap; one that throws gives undefined (#354).
 */
function constantCode(err: Error): string | undefined {
  let code: unknown
  try {
    code = 'code' in err ? err.code : undefined
  } catch {
    return undefined
  }
  return typeof code === 'string' && CONSTANT_CODE.test(code) ? code : undefined
}

/**
 * `err.name`, its constant-shaped `err.code` if any (#354), and the stack
 * frames, never the message (#204). V8 writes the stack as a header, which is
 * `Error.prototype.toString` of the error (`name: message`, and the message
 * can span lines), then one line per frame. The header is cut off by its exact
 * text, not by counting lines, so a message that contains a line shaped like a
 * frame goes with it. If the stack does not start with that header (it was
 * formatted before the message changed, or it was replaced), or anything after
 * it is not a frame line, the frames are dropped and only the name, and the
 * code if there is one, are logged. A message cut down to a prefix of itself
 * after formatting still matches, and its lost lines that look like frames
 * pass as frames.
 */
function nameAndFrames(err: Error): string {
  const code = constantCode(err)
  // A name that cannot be read, or is not a string, is `Error` (#363).
  let name: unknown
  try {
    name = err.name
  } catch {
    name = undefined
  }
  // The first line logged: the name, then the code if there is one.
  const head =
    (typeof name === 'string' ? name : 'Error') +
    (code === undefined ? '' : ` ${code}`)
  let stack: unknown
  let header: string
  try {
    stack = err.stack
    header = Error.prototype.toString.call(err)
  } catch {
    return head
  }
  if (typeof stack !== 'string' || !stack.startsWith(`${header}\n`)) {
    return head
  }
  const frames = stack.slice(header.length + 1).split('\n')
  return frames.every((line) => FRAME.test(line))
    ? [head, ...frames].join('\n')
    : head
}

server.use(
  '/api',
  // Express tells an error handler from a route by its four parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: unknown, req: Request, res: Response, next: NextFunction) => {
    // A response already under way cannot be answered. Express's default
    // handler would destroy the socket, as here, but would also log
    // `err.stack`, message included, outside tests.
    if (res.headersSent) {
      console.error(
        'Unhandled /api error after the response started:',
        isError(err) ? nameAndFrames(err) : typeof err,
      )
      req.socket.destroy()
      return
    }
    const client = clientStatus(err)
    if (client !== undefined) {
      // clientStatus is only defined for a non-null object. Deciding and
      // naming read the error (a getter, a Proxy trap) and may throw; the
      // answer must not change, so a throw logs the line with a fixed name.
      let name: string | undefined
      try {
        name =
          typeof err === 'object' && err !== null && !isRequestError(err)
            ? constructorName(err)
            : undefined
      } catch {
        name = 'unknown'
      }
      if (name !== undefined) {
        console.error(
          '4xx /api error not raised by body-parser or the router:',
          client,
          name,
        )
      }
      res
        .status(client)
        .json({ error: CLIENT_ERROR_TEXT[client] ?? 'Client error' })
      return
    }
    console.error(
      'Unhandled /api error:',
      isError(err) ? nameAndFrames(err) : typeof err,
    )
    res.status(500).json({ error: 'Internal server error' })
  },
)

export default server

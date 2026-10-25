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
// fields; a body-parser error holds the raw request text in `err.body`, so
// only the stack of a 500 is logged, never the error object. Other paths
// keep Express's default handling.
//
// An error whose integer `status` (else `statusCode`, as Express's
// finalhandler reads them) is 4xx is the client's fault (#185): it answers
// that status with a fixed text, and nothing is logged. That covers a
// malformed body (400), an oversize body (413), an unsupported charset or
// Content-Encoding (415) and a bad percent-encoded path (400). Anything else,
// including a 5xx status, is a 500 with the fixed text, and only its stack is
// logged.
const CLIENT_ERROR_TEXT: Partial<Record<number, string>> = {
  400: 'Bad request',
  413: 'Payload too large',
  415: 'Unsupported media type',
}

/** The 4xx status an error carries, or undefined for anything else. */
function clientStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const status =
    'status' in err && Number.isInteger(err.status)
      ? err.status
      : 'statusCode' in err
        ? err.statusCode
        : undefined
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 499
    ? status
    : undefined
}

server.use(
  '/api',
  (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    const client = clientStatus(err)
    if (client !== undefined) {
      res
        .status(client)
        .json({ error: CLIENT_ERROR_TEXT[client] ?? 'Client error' })
      return
    }
    console.error(
      'Unhandled /api error:',
      err instanceof Error ? err.stack : typeof err,
    )
    res.status(500).json({ error: 'Internal server error' })
  },
)

export default server

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
server.use(
  '/api',
  (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    const type =
      typeof err === 'object' && err !== null && 'type' in err
        ? err.type
        : undefined
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Bad request' })
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

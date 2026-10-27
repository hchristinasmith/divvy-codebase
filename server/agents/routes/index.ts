import express from 'express'

import { fromThisSite } from '../../http.ts'
import insights from './insights.ts'
import proposals from './proposals.ts'
import run from './run.ts'

// /api/v1/agents (prd-04 w2, #51): the background agents' inbox over HTTP,
// mounted by server/routes/index.ts. The routes read the inbox and decide
// what is in it, and POST /run starts an agent run through the agent
// scheduler (#58). Nothing here calls a model (Ruling 7).
//
//   GET  /proposals?status=        list category proposals
//   POST /proposals/:id/accept     accept one; writes the category as its origin
//   POST /proposals/:id/reject     reject one
//   GET  /insights?scope=&kind=    list insights not dismissed
//   POST /insights/:id/dismiss     dismiss one
//   POST /run                      run the category or insights agent now
//
// There is no server-side auth (D4): the app is reachable only over the
// tailnet. So that a page on another site cannot decide a proposal or
// dismiss an insight from Hannah's browser, every request that is not a GET
// or HEAD passes the same check as POST /api/v1/sync/run first, here once
// for every router below, so a write route added later is covered without
// remembering to.

const router = express.Router()

router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !fromThisSite(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
})

router.use('/proposals', proposals)
router.use('/insights', insights)
router.use('/run', run)

export default router

import express from 'express'

import accounts from './accounts.ts'
import bills from './bills.ts'
import budgets from './budgets.ts'
import categorise from './categorise.ts'
import categories from './categories.ts'
import goals from './goals.ts'
import habits from './habits.ts'
import overview from './overview.ts'
import settings from './settings.ts'
import spending from './spending.ts'
import subscriptions from './subscriptions.ts'
import sync from './sync.ts'
import transactions from './transactions.ts'
import xero from '../xero/routes/read.ts'
import agents from '../agents/routes/index.ts'

// The /api/v1 route barrel (prd-02 Sequencing, wave 1). `server.ts` mounts
// this router once at /api/v1; every API router is mounted here, at a path
// relative to that prefix. A route that is not built yet has a placeholder
// file answering 501, so the lane that builds it edits only its own file.
//
// No catch-all: an unknown /api/v1 path falls through to Express's 404.
const router = express.Router()

router.use('/accounts', accounts)
router.use('/categories', categories)
router.use('/transactions', transactions)
router.use('/sync', sync)
router.use('/xero', xero)

router.use('/overview', overview)
router.use('/settings', settings)
router.use('/budgets', budgets)
router.use('/bills', bills)
router.use('/goals', goals)
router.use('/habits', habits)
router.use('/subscriptions', subscriptions)
router.use('/spending', spending)
router.use('/categorise', categorise)
router.use('/agents', agents)

export default router

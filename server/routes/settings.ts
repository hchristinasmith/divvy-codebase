import express from 'express'

const router = express.Router()

// Placeholder (prd-02 Sequencing, wave 1): mounted at /api/v1/settings by
// ./index.ts. The lane that builds this route replaces everything between
// the router and the export; it never edits ./index.ts or ../server.ts.
// Every method and sub-path answers 501 until then.
router.use((_req, res) => {
  res.status(501).json({ error: 'Not implemented: settings' })
})

export default router

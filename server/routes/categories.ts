import express from 'express'
import type { CategoriesResponse } from '../../models/categories.ts'
import { getCategoryGroups } from '../db/categories.ts'

const router = express.Router()

// GET /api/v1/categories
router.get('/', (req, res) => {
  const body: CategoriesResponse = { items: getCategoryGroups() }
  res.json(body)
})

export default router

import express from 'express'
import type { CategoriesResponse } from '../../models/categories.ts'
import { getSelectableCategoryGroups } from '../db/categories.ts'

const router = express.Router()

// GET /api/v1/categories: what Hannah can pick, data/cats.js and then
// Divvy's own group holding Drawings (prd-02 Ruling 15).
router.get('/', (req, res) => {
  const body: CategoriesResponse = { items: getSelectableCategoryGroups() }
  res.json(body)
})

export default router

import express from 'express'
import * as db from '../db/transactions.ts'
import { isKnownCategory } from '../db/categories.ts'
import type { UpdateTransactionCategoryResponse } from '../../models/transactions.ts'

const router = express.Router()

// GET /api/v1/transactions?description=
router.get('/', async (req, res) => {
  const { description } = req.query
  try {
    const txns = await db.searchTxns(description as string)
    res.json({ txns })
  } catch (error) {
    console.error(error)
    res.status(500).send("Couldn't search products")
  }
})

// PATCH /api/v1/transactions/:id  body: UpdateTransactionCategory
// The one category-edit route (M1 #9). Sets the user's category; never
// Akahu's (prd-01 Ruling 4).
router.patch('/:id', async (req, res) => {
  // Digits only: Number() would also accept '1e3', '0x10' and ' 7'.
  const id = Number(req.params.id)
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const category: unknown = req.body?.category
  if (typeof category !== 'string' || !isKnownCategory(category)) {
    return res
      .status(400)
      .json({ error: 'category must be one of GET /api/v1/categories' })
  }

  try {
    const transaction = await db.setUserCategory(id, category)
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' })
    }
    const body: UpdateTransactionCategoryResponse = { transaction }
    res.json(body)
  } catch (error) {
    console.error('Error setting transaction category:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

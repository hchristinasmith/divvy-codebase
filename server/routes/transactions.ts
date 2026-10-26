import express from 'express'
import * as db from '../db/transactions.ts'
import { isSelectableCategory } from '../db/categories.ts'
import { applyDrawings, loadDrawingIds } from '../db/drawings.ts'
import type { UpdateTransactionCategoryResponse } from '../../models/transactions.ts'
import { errorClass } from '../error-class.ts'

const router = express.Router()

// GET /api/v1/transactions?description=
// Each row shows its effective category: a half of a drawing is Drawings,
// set by `rule`, unless Hannah categorised it by hand (prd-02 Ruling 15).
// Nothing is written. Rows carry the explicit column list (#212), Akahu rows
// only. A repeated or nested ?description= is refused before anything is read.
router.get('/', async (req, res) => {
  const { description } = req.query
  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a single string' })
  }
  try {
    const rows = await db.searchTxns(description)
    const txns = applyDrawings(rows, await loadDrawingIds())
    res.json({ txns })
  } catch (error) {
    console.error('Error searching transactions:', errorClass(error))
    res.status(500).send("Couldn't search transactions")
  }
})

// PATCH /api/v1/transactions/:id  body: UpdateTransactionCategory
// The one category-edit route (M1 #9). Sets the user's category; never
// Akahu's, and records the change in `category_corrections` (prd-01
// Ruling 4). The category is one GET /api/v1/categories lists, Drawings
// included (prd-02 Ruling 15). A pending row is refused with 409 (#129):
// sync replaces pending rows on every run (prd-01 Ruling 1), which would
// delete the correction with it, so a category can only be changed once the
// row has settled.
router.patch('/:id', async (req, res) => {
  // Digits only: Number() would also accept '1e3', '0x10' and ' 7'.
  const id = Number(req.params.id)
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const category: unknown = req.body?.category
  if (typeof category !== 'string' || !isSelectableCategory(category)) {
    return res
      .status(400)
      .json({ error: 'category must be one of GET /api/v1/categories' })
  }

  try {
    const transaction = await db.setUserCategory(id, category)
    if (transaction === undefined) {
      return res.status(404).json({ error: 'Transaction not found' })
    }
    if (transaction === 'pending') {
      return res.status(409).json({
        error:
          'Transaction is still pending; its category can be changed once it settles',
      })
    }
    const body: UpdateTransactionCategoryResponse = { transaction }
    res.json(body)
  } catch (error) {
    console.error('Error setting transaction category:', errorClass(error))
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

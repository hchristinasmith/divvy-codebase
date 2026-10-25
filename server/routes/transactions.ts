import express from 'express'
import * as db from '../db/transactions.ts'
import { isKnownCategory } from '../db/categories.ts'
import type { UpdateTransactionCategoryResponse } from '../../models/transactions.ts'

const router = express.Router()

// What a 500 logs: the error's class only, as routes/accounts.ts does. Never
// the error, its message or its stack: knex puts the SQL and its bound values
// into the message, the stack repeats it, and a search string is one of them.
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

// GET /api/v1/transactions?description=
router.get('/', async (req, res) => {
  const { description } = req.query
  try {
    const txns = await db.searchTxns(description as string)
    res.json({ txns })
  } catch (error) {
    console.error('Error searching transactions:', errorClass(error))
    res.status(500).send("Couldn't search transactions")
  }
})

// PATCH /api/v1/transactions/:id  body: UpdateTransactionCategory
// The one category-edit route (M1 #9). Sets the user's category; never
// Akahu's, and records the change in `category_corrections` (prd-01
// Ruling 4). A pending row is refused with 409 (#129): sync replaces pending
// rows on every run (prd-01 Ruling 1), which would delete the correction
// with it, so a category can only be changed once the row has settled.
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

import express from 'express'
import request from 'superagent'
const router = express.Router()

// GET 'https://api.akahu.io/v1'

router.get('/', async (req, res) => {
  try {
    // Make sure environment variables exist
    const token = process.env.AKAHU_USER_TOKEN
    const appId = process.env.AKAHU_APP_ID
    
    if (!token || !appId) {
      throw new Error('Missing Akahu credentials')
    }
    
    const response = await request
      .get('https://api.akahu.io/v1/accounts')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Akahu-Id', appId)

    res.json(response.body)
  } catch (err) {
    if (err instanceof Error) {
      res.status(500).send((err as Error).message)
    } else {
      res.status(500).send('Something went wrong')
    }
  }
})

// Get all transactions (not filtered by account)
router.get('/transactions', async (req, res) => {
  try {
    // Make sure environment variables exist
    const token = process.env.AKAHU_USER_TOKEN
    const appId = process.env.AKAHU_APP_ID
    
    if (!token || !appId) {
      throw new Error('Missing Akahu credentials')
    }
    
    const response = await request
      .get('https://api.akahu.io/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Akahu-Id', appId)

    res.json(response.body)
  } catch (err) {
    if (err instanceof Error) {
      res.status(500).send((err as Error).message)
    } else {
      res.status(500).send('Something went wrong')
    }
  }
})

// Akahu account ids are `acc_` followed by letters and digits. Anything else
// is refused before a request leaves the server: Express has already decoded
// the segment, so `..%2F..%2Fusers` arrives here as `../../users`, and
// forwarding it would send the user token to whichever Akahu endpoint the
// path resolves to (#90).
const AKAHU_ACCOUNT_ID = /^acc_[A-Za-z0-9]+$/

router.get('/:accountId/transactions', async (req, res) => {
  const { accountId } = req.params
  if (!AKAHU_ACCOUNT_ID.test(accountId)) {
    return res
      .status(400)
      .json({ error: 'accountId must be an Akahu account id (acc_…)' })
  }

  try {
    // Make sure environment variables exist
    const token = process.env.AKAHU_USER_TOKEN
    const appId = process.env.AKAHU_APP_ID
    
    if (!token || !appId) {
      throw new Error('Missing Akahu credentials')
    }
    
    const response = await request
      .get(
        `https://api.akahu.io/v1/accounts/${encodeURIComponent(accountId)}/transactions`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('X-Akahu-Id', appId)

    res.json(response.body)
  } catch (err) {
    if (err instanceof Error) {
      res.status(500).send((err as Error).message)
    } else {
      res.status(500).send('Something went wrong')
    }
  }
})

export default router

import express from 'express'

import {
  PROPOSAL_STATUSES,
  parseProposedCategory,
  type CategoryProposal,
  type ProposalStatus,
} from '../contracts.ts'
import { getProposal, listProposals, setStatus } from '../db/proposals.ts'
import connection from '../../db/connection.ts'
import {
  getTransactionCategory,
  setUserCategory,
} from '../../db/transactions.ts'
import type { TransactionRow } from '../../../models/transactions.ts'

// /api/v1/agents/proposals (prd-04 Rulings 2 and 7, #51), mounted by
// ./index.ts, which also refuses a cross-site POST before it reaches here.
//
// Accepting a proposal is the one place an agent's output reaches money
// state, and it does so only through `setUserCategory` with source `rule`
// (decision 3cb449c6 on #51): the category, `category_source = 'rule'` and a
// `rule` correction. Ruling 7: no model is called, so `claude` never occurs.
// Everything accept does runs in one database transaction, decision first:
// a refusal at any later step throws `AcceptRefused`, which rolls back the
// decision with it, so a refused proposal is still pending.
//
// A proposal is stale, and refused, once the transaction's category is no
// longer the one it was proposed against, or once the user has set the
// category by hand, even to that same value (decision 70b41742 on #51): a
// hand-set category is never overwritten by a rule.
//
// Rejecting needs no other write: a rejected row is what stops the
// (transaction, category) pair from being proposed again (#31).
//
// Errors are `{ error: string }` with fixed text, never a row value: a
// proposal's reason and a transaction's description carry merchant text.
// A 500 logs only the error's class.

// A refusal inside accept's transaction; throwing it rolls the transaction
// back.
class AcceptRefused extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly text: string,
  ) {
    super(text)
  }
}

interface ListProposalsResponse {
  items: CategoryProposal[]
}

interface AcceptProposalResponse {
  proposal: CategoryProposal
  transaction: TransactionRow
}

interface RejectProposalResponse {
  proposal: CategoryProposal
}

/**
 * A plain positive integer id, or null. Digits only, as PATCH
 * /api/v1/transactions/:id: Number() would also accept '1e3', '0x10' and ' 7'.
 */
function parseId(raw: string): number | null {
  const id = Number(raw)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null
}

/** One known status; absent is `pending`; anything else, or repeated, null. */
function parseStatus(raw: unknown): ProposalStatus | null {
  if (raw === undefined) return 'pending'
  return typeof raw === 'string' &&
    (PROPOSAL_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProposalStatus)
    : null
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}

const router = express.Router()

// GET /api/v1/agents/proposals?status=pending|accepted|rejected
router.get('/', async (req, res) => {
  const status = parseStatus(req.query.status)
  if (status === null) {
    res
      .status(400)
      .json({ error: 'status must be pending, accepted or rejected' })
    return
  }
  try {
    const body: ListProposalsResponse = { items: await listProposals({ status }) }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('agents: could not list proposals', errorClass(err))
    res.status(500).json({ error: 'Could not list proposals' })
  }
})

// POST /api/v1/agents/proposals/:id/accept
router.post('/:id/accept', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id must be a positive integer' })
    return
  }
  try {
    // Only `trx` inside: the pool holds one connection, so a query on
    // `connection` here would wait for this transaction forever.
    const body: AcceptProposalResponse = await connection.transaction(
      async (trx) => {
        // 1. The decision first: true only if this call moved it out of
        //    pending, so a decided proposal is never decided again.
        if (!(await setStatus(id, 'accepted', trx))) {
          throw (await getProposal(id, trx)) === undefined
            ? new AcceptRefused(404, 'Proposal not found')
            : new AcceptRefused(409, 'Proposal already decided')
        }
        // 2. The proposal as now stored, status `accepted`.
        const proposal = await getProposal(id, trx)
        if (proposal === undefined) {
          throw new AcceptRefused(404, 'Proposal not found')
        }
        // 3. data/cats.js can change after a proposal is stored (Ruling 6).
        const proposed = parseProposedCategory(proposal.proposed_category)
        if (proposed === null) {
          throw new AcceptRefused(
            409,
            'Proposed category is no longer in the category list',
          )
        }

        // 4. The transaction as it is now.
        const tx = await getTransactionCategory(proposal.transaction_id, trx)
        if (tx === undefined) {
          throw new AcceptRefused(404, 'Transaction not found')
        }
        // 5. Stale: the category moved, or the user set it by hand. One text
        //    for both; the client recovers the same way.
        if (
          tx.category_source === 'user' ||
          (tx.category ?? null) !== (proposal.current_category ?? null)
        ) {
          throw new AcceptRefused(
            409,
            'Transaction category has changed since this was proposed',
          )
        }

        // 6. The category, `rule` in both columns, and a correction.
        const transaction = await setUserCategory(
          proposal.transaction_id,
          proposed,
          trx,
          'rule',
        )
        if (transaction === undefined) {
          throw new AcceptRefused(404, 'Transaction not found')
        }
        if (transaction === 'pending') {
          throw new AcceptRefused(
            409,
            'Transaction is still pending; its category can be changed once it settles',
          )
        }
        return { proposal, transaction }
      },
    )
    res.json(body)
  } catch (err) {
    if (err instanceof AcceptRefused) {
      res.status(err.status).json({ error: err.text })
      return
    }
    // eslint-disable-next-line no-console
    console.error('agents: could not accept proposal', errorClass(err))
    res.status(500).json({ error: 'Could not accept proposal' })
  }
})

// POST /api/v1/agents/proposals/:id/reject
//
// No stale check: rejecting a proposal whose transaction has moved on is how
// it is cleared, and it still stops the pair being proposed again.
router.post('/:id/reject', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id must be a positive integer' })
    return
  }
  try {
    const decided = await setStatus(id, 'rejected')
    const proposal = await getProposal(id)
    if (proposal === undefined) {
      res.status(404).json({ error: 'Proposal not found' })
      return
    }
    if (!decided) {
      res.status(409).json({ error: 'Proposal already decided' })
      return
    }
    const body: RejectProposalResponse = { proposal }
    res.json(body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('agents: could not reject proposal', errorClass(err))
    res.status(500).json({ error: 'Could not reject proposal' })
  }
})

export default router

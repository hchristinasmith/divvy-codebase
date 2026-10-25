// The category agent's inbox (prd-04 Rulings 2, 6 and 7; #31): writes and
// reads `category_proposals`, and no other table.
//
// A proposal is inserted once per (transaction, proposed category) and never
// replaced or deleted here. A `rejected` row is what stops the pair being
// proposed again (Done-when 3, dated note 3), so a second insert of the pair
// is a no-op in every status, enforced by the table's unique index rather
// than a read before the write.
//
// Accepting a proposal is the accept route's job: it calls `setStatus` inside
// its own transaction, requires `true`, and then writes the category, its
// source and a correction in that same transaction (Ruling 2). Nothing here
// touches the transaction the proposal is about.
//
// A refused input throws an error naming the field, never its value: a
// reason carries merchant text. So does a refused write: knex puts the SQL,
// bound values and all, in its error message, and `scrubbed` rethrows it as
// SQLite's own words alone. A reason past its length cap is a refused input
// too, as a title or body_md is in insights.ts.
import {
  PROPOSAL_ORIGINS,
  parseProposedCategory,
  type CategoryProposal,
  type ProposalOrigin,
  type ProposalStatus,
} from '../contracts.ts'
import connection from '../../db/connection.ts'
import { scrubbed } from './scrubbed.ts'

export interface NewProposal {
  transaction_id: number
  current_category: string | null
  proposed_category: string
  confidence: number
  reason: string
  origin: ProposalOrigin
}

export type InsertProposalResult =
  | { inserted: true; id: number }
  | { inserted: false; reason: 'unknown_category' | 'duplicate' }

// Length cap, counted in code points, not UTF-16 units: a non-BMP character
// is one code point and two units.
const REASON_MAX_LENGTH = 2_000

function atMostLength(value: string, field: string, max: number): void {
  if (Array.from(value).length > max) {
    throw new Error(`${field} must be at most ${max} characters`)
  }
}

/**
 * Stores a `pending` proposal. A proposed category outside data/cats.js is
 * discarded, not stored and not thrown (Ruling 6). A pair already stored, in
 * any status, is `duplicate` and changes nothing. A `transaction_id` with no
 * transaction fails the foreign key and throws.
 */
export async function insertProposal(
  proposal: NewProposal,
  now: Date = new Date(),
  db = connection,
): Promise<InsertProposalResult> {
  const proposed = parseProposedCategory(proposal.proposed_category)
  if (proposed === null) return { inserted: false, reason: 'unknown_category' }

  if (!Number.isSafeInteger(proposal.transaction_id) || proposal.transaction_id <= 0) {
    throw new Error('transaction_id must be a positive integer')
  }
  const { confidence } = proposal
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be a number from 0 to 1')
  }
  if (typeof proposal.reason !== 'string' || proposal.reason.trim() === '') {
    throw new Error('reason must not be blank')
  }
  atMostLength(proposal.reason, 'reason', REASON_MAX_LENGTH)
  if (!(PROPOSAL_ORIGINS as readonly unknown[]).includes(proposal.origin)) {
    throw new Error('origin is not a known proposal origin')
  }

  const row: Omit<CategoryProposal, 'id'> = {
    transaction_id: proposal.transaction_id,
    current_category: proposal.current_category,
    proposed_category: proposed,
    confidence,
    reason: proposal.reason,
    origin: proposal.origin,
    status: 'pending',
    created_at: now.toISOString(),
  }
  const ids: { id: number }[] = await scrubbed(
    'insertProposal',
    db('category_proposals')
      .insert(row)
      .onConflict(['transaction_id', 'proposed_category'])
      .ignore()
      .returning('id'),
  )
  if (ids.length === 0) return { inserted: false, reason: 'duplicate' }
  return { inserted: true, id: ids[0].id }
}

export async function getProposal(
  id: number,
  db = connection,
): Promise<CategoryProposal | undefined> {
  return db('category_proposals').where({ id }).first()
}

export interface ProposalFilter {
  status?: ProposalStatus
  transactionId?: number
}

/**
 * Proposals, newest first. Not filtered by the current taxonomy: a stored
 * proposal was valid when written.
 */
export async function listProposals(
  filter: ProposalFilter = {},
  db = connection,
): Promise<CategoryProposal[]> {
  const query = db('category_proposals')
  if (filter.status !== undefined) query.where({ status: filter.status })
  if (filter.transactionId !== undefined) {
    query.where({ transaction_id: filter.transactionId })
  }
  return query.orderBy([
    { column: 'created_at', order: 'desc' },
    { column: 'id', order: 'desc' },
  ])
}

/**
 * Decides a pending proposal. True when this call moved it out of
 * `pending`; false when there is no such proposal or it was already decided,
 * so a decision is never overwritten. Pass the caller's transaction as `db`
 * to make the decision part of it.
 */
export async function setStatus(
  id: number,
  status: Exclude<ProposalStatus, 'pending'>,
  db = connection,
): Promise<boolean> {
  if (status !== 'accepted' && status !== 'rejected') {
    throw new Error('status must be accepted or rejected')
  }
  const updated = await scrubbed(
    'setStatus',
    db('category_proposals')
      .where({ id, status: 'pending' satisfies ProposalStatus })
      .update({ status }),
  )
  return updated > 0
}

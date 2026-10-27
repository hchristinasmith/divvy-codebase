import type { CreateBudgetRequest, RowScope } from '../../../shared/contracts.ts'
import { parseDollarsField } from '../Settings/fields.ts'

// The Budgets screen's input edge (issue 53): the − / + step on a card, and
// the Add budget form. What is typed stays text until Save; the limit
// becomes integer cents only through the Settings parser, by exact string
// arithmetic, never by multiplying a float. The server checks every field
// again and its message is shown when it refuses.
//
// The step is the only arithmetic on cents in this screen, in `stepLimit`,
// which the money tripwire (./__tests__/noMoneyArithmetic.test.ts) allows
// by name.

/** What − and + move a limit by: $10 (docs/design/handoff.md Screen 2). */
export const LIMIT_STEP_CENTS = 1000

/** The lowest limit − steps down to: the prototype's floor of $10. */
export const LIMIT_FLOOR_CENTS = 1000

/** The new absolute limit after one step; down never goes under the floor. */
export function stepLimit(limitCents: number, direction: 'down' | 'up'): number {
  if (direction === 'up') return limitCents + LIMIT_STEP_CENTS
  return Math.max(LIMIT_FLOOR_CENTS, limitCents - LIMIT_STEP_CENTS)
}

/** − is offered only while a step down would lower the limit. */
export function canStepDown(limitCents: number): boolean {
  return limitCents > LIMIT_FLOOR_CENTS
}

export interface Draft {
  category: string
  limit: string
  note: string
  scope: RowScope
}

export type DraftErrors = Partial<Record<'category' | 'limit', string>>

export function emptyDraft(scope: RowScope): Draft {
  return { category: '', limit: '', note: '', scope }
}

/**
 * The checks worth making before a round trip: a category and a limit in
 * dollars (0 is allowed, as on the server). A known category, a duplicate
 * and the note's length are the server's to refuse. A blank note is not
 * sent.
 */
export function checkDraft(draft: Draft): CreateBudgetRequest | { errors: DraftErrors } {
  const errors: DraftErrors = {}
  if (draft.category === '') errors.category = 'Choose a category'
  const limit = parseDollarsField(draft.limit)
  if ('error' in limit) errors.limit = limit.error
  if ('error' in limit || errors.category !== undefined) return { errors }
  const body: CreateBudgetRequest = {
    scope: draft.scope,
    category: draft.category,
    limitCents: limit.value,
  }
  const note = draft.note.trim()
  if (note !== '') body.note = note
  return body
}

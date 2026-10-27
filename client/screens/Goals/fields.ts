import { formatCents } from '../../../shared/money.ts'
import type { CreateGoalRequest } from '../../../shared/contracts.ts'
import { parseDollarsField } from '../Settings/fields.ts'

// The new-goal form's input edge (issue 56). What is typed stays text until
// Save; the target becomes integer cents only through the Settings parser,
// by exact string arithmetic, never by multiplying a float. The server
// checks every field again (server/db/goals.ts) and its message is shown
// when it refuses.

// Copies of `MAX_NAME_LENGTH`, `MAX_GOAL_CENTS`, `TARGET_DATE_MIN` and
// `TARGET_DATE_MAX` in server/db/goals.ts, which is another lane's file;
// change together.
const MAX_NAME_LENGTH = 255
const MAX_GOAL_CENTS = 1_000_000_000
const TARGET_DATE_MIN = '2000-01-01'
const TARGET_DATE_MAX = '2099-12-31'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface Draft {
  name: string
  /** Dollars as typed, like "1500.50". */
  target: string
  /** `YYYY-MM-DD` from the date input, or empty for no by-date. */
  targetDate: string
}

export type DraftErrors = Partial<Record<keyof Draft, string>>

export function emptyDraft(): Draft {
  return { name: '', target: '', targetDate: '' }
}

/**
 * The POST body, or the message to show beside each field that is wrong.
 * The name is trimmed. An empty by-date is null, and the key is always
 * sent. A typed date is sent as typed: ISO dates compare correctly as
 * strings, so the range check needs no `Date`.
 */
export function checkDraft(
  draft: Draft,
): { request: CreateGoalRequest } | { errors: DraftErrors } {
  const errors: DraftErrors = {}

  const name = draft.name.trim()
  if (name === '') errors.name = 'Required'
  else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `At most ${MAX_NAME_LENGTH} characters`
  }

  const target = parseDollarsField(draft.target)
  if ('error' in target) errors.target = target.error
  else if (target.value < 1) errors.target = 'Must be more than 0'
  else if (target.value > MAX_GOAL_CENTS) {
    errors.target = `At most ${formatCents(MAX_GOAL_CENTS)}`
  }

  const typed = draft.targetDate.trim()
  if (typed !== '') {
    if (!ISO_DATE.test(typed)) errors.targetDate = 'Enter a date, like 2027-03-15'
    else if (typed < TARGET_DATE_MIN || typed > TARGET_DATE_MAX) {
      errors.targetDate = 'Pick a date from 2000 to 2099'
    }
  }

  if ('error' in target || Object.keys(errors).length > 0) return { errors }
  return {
    request: {
      name,
      targetCents: target.value,
      targetDate: typed === '' ? null : typed,
    },
  }
}

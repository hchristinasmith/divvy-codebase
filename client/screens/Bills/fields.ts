import type {
  BillResponse,
  CreateBillRequest,
  RowScope,
  UpdateBillRequest,
} from '../../../shared/contracts.ts'
import type { BillRepeat } from '../../../models/planning.ts'
import { centsToDollarsField, parseDollarsField } from '../Settings/fields.ts'

// The bill form's input edge (issue 54). What is typed stays text until
// Save; the amount becomes integer cents only through the Settings parser,
// by exact string arithmetic, never by multiplying a float. The server
// checks every field again and its message is shown when it refuses.

export interface Draft {
  name: string
  amount: string
  firstDueDate: string
  repeat: BillRepeat
  scope: RowScope
  /** An account id, or one of the two choices below. */
  account: string
}

/** On add: no account. On edit: keep the bill's current account. */
export const ACCOUNT_DEFAULT = ''
/** On edit only: take the bill's account off it. */
export const ACCOUNT_DETACH = 'none'

export type DraftErrors = Partial<Record<'name' | 'amount' | 'firstDueDate', string>>

export interface ParsedDraft {
  name: string
  amountCents: number
  firstDueDate: string
}

export function emptyDraft(scope: RowScope): Draft {
  return {
    name: '',
    amount: '',
    firstDueDate: '',
    repeat: 'none',
    scope,
    account: ACCOUNT_DEFAULT,
  }
}

/**
 * The edit form's starting point. The response has no account id, only its
 * name, so the account starts as "keep current".
 */
export function draftFromBill(bill: BillResponse): Draft {
  return {
    name: bill.name,
    amount: centsToDollarsField(bill.amountCents),
    firstDueDate: bill.firstDueDate,
    repeat: bill.repeat,
    scope: bill.scope,
    account: ACCOUNT_DEFAULT,
  }
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.amount === b.amount &&
    a.firstDueDate === b.firstDueDate &&
    a.repeat === b.repeat &&
    a.scope === b.scope &&
    a.account === b.account
  )
}

/**
 * The checks worth making before a round trip: a name, an amount of at least
 * a cent, a date. Length and date range are the server's to refuse.
 */
export function checkDraft(draft: Draft): ParsedDraft | { errors: DraftErrors } {
  const errors: DraftErrors = {}
  const name = draft.name.trim()
  if (name === '') errors.name = 'Required'
  const amount = parseDollarsField(draft.amount)
  if ('error' in amount) errors.amount = amount.error
  else if (amount.value < 1) errors.amount = 'Must be more than 0'
  if (draft.firstDueDate === '') errors.firstDueDate = 'Required'
  if ('error' in amount || Object.keys(errors).length > 0) return { errors }
  return { name, amountCents: amount.value, firstDueDate: draft.firstDueDate }
}

/** POST body. `accountId` is sent only when an account was chosen. */
export function createRequest(parsed: ParsedDraft, draft: Draft): CreateBillRequest {
  const body: CreateBillRequest = {
    scope: draft.scope,
    name: parsed.name,
    amountCents: parsed.amountCents,
    firstDueDate: parsed.firstDueDate,
    repeat: draft.repeat,
  }
  if (draft.account !== ACCOUNT_DEFAULT && draft.account !== ACCOUNT_DETACH) {
    body.accountId = draft.account
  }
  return body
}

/**
 * PATCH body: only what differs from the bill. Sending an unchanged first due
 * date or repeat would be refused once the bill has payments, so they go
 * only when changed. The scope is never sent: the form cannot change it.
 */
export function billPatch(
  bill: BillResponse,
  parsed: ParsedDraft,
  draft: Draft,
): UpdateBillRequest {
  const patch: UpdateBillRequest = {}
  if (parsed.name !== bill.name) patch.name = parsed.name
  if (parsed.amountCents !== bill.amountCents) patch.amountCents = parsed.amountCents
  if (parsed.firstDueDate !== bill.firstDueDate) patch.firstDueDate = parsed.firstDueDate
  if (draft.repeat !== bill.repeat) patch.repeat = draft.repeat
  if (draft.account === ACCOUNT_DETACH) patch.accountId = null
  else if (draft.account !== ACCOUNT_DEFAULT) patch.accountId = draft.account
  return patch
}

// Row types for the prd-02 planning schema (#39): `budgets`, `bills`,
// `bill_payments`, `goals`, `goal_contributions`, `account_settings` and
// `alert_dismissals`. Each interface has one field per column of its table;
// server/db/migrations/20261025120000_prd02_budgets_bills_goals_roles_dismissals.js
// is the source of truth and server/db/__tests__/prd02-tables.test.ts pins
// the two together.
//
// These are column shapes in snake_case. The API shapes are the camelCase
// ones in shared/contracts.ts; each route's data module maps between them.
//
// Money is integer cents (M1 #8). Instants are `IsoTimestamp`; calendar
// dates are `IsoDate` (`YYYY-MM-DD`), checked by the database.
import type { AccountRole, IsoDate } from '../shared/contracts.ts'
import type { AccountScope, IsoTimestamp } from './sync.ts'

// How a bill repeats (#35 option C). Every occurrence is computed from
// `first_due_date`, never from the previous occurrence: weekly is anchor +
// 7n days; monthly keeps the anchor's day of month, clamped to the end of a
// shorter month; yearly keeps the anchor's month and day, with 29 February
// on 28 February in a year that is not a leap year. `none` is a one-off.
export type BillRepeat = 'none' | 'weekly' | 'monthly' | 'yearly'

// A row of `budgets`: one limit per category per scope (prd-02 Ruling 6).
export interface Budget {
  id: number
  scope: AccountScope
  category: string
  // A weekly amount (prd-02 Ruling 9). Zero or more.
  limit_cents: number
  note: string | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

// A row of `bills`. The bill's current occurrence is the earliest one with
// no `bill_payments` row; a one-off is done once its payment exists.
export interface Bill {
  id: number
  scope: AccountScope
  name: string
  // Above zero.
  amount_cents: number
  repeat: BillRepeat
  // The anchor every occurrence is computed from.
  first_due_date: IsoDate
  // The account it is paid from; null when none is set or the account was
  // deleted.
  account_id: number | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

// A row of `bill_payments`: "Mark paid" for one occurrence. At most one per
// bill and `due_date`; deleting the bill deletes its payments. The database
// does not check that `due_date` lies on the bill's schedule; the bills
// route must.
export interface BillPayment {
  id: number
  bill_id: number
  // The occurrence this payment pays.
  due_date: IsoDate
  // What was paid, as a snapshot; above zero.
  amount_cents: number
  paid_at: IsoTimestamp
}

// A row of `goals`. There is no saved amount here: it is the sum of the
// goal's contributions (prd-02 Ruling 5).
export interface Goal {
  id: number
  name: string
  // Above zero.
  target_cents: number
  target_date: IsoDate | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

// A row of `goal_contributions`: a record, not a transfer (prd-02 Ruling 5).
// Deleting the goal deletes its contributions.
export interface GoalContribution {
  id: number
  goal_id: number
  // Above zero.
  amount_cents: number
  contributed_at: IsoTimestamp
}

// A row of `account_settings`: an account's role. At most one per account;
// no row means no role. Deleting the account deletes it.
export interface AccountSetting {
  id: number
  account_id: number
  role: AccountRole
  updated_at: IsoTimestamp
}

// A row of `alert_dismissals`: an alert's stable id, dismissed once.
export interface AlertDismissal {
  alert_id: string
  dismissed_at: IsoTimestamp
}

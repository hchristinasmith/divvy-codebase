import { BAR_TRACK, CARD, FOCUS } from '../Overview/styles.ts'
import type { BudgetTone } from './format.ts'

// Class lists only the Budgets screen uses, from the App.css theme tokens
// and the Budgets prototype (docs/design/Divvy.dc.html, the Budgets
// section; update 2 surfaces per docs/design/CHANGES-2.md §1 and prd-02
// Ruling 13). Card, bar track, error, muted and secondary-button classes
// come from the Overview's styles; the form's fields and buttons from the
// Bills styles.
//
// The − / + buttons are squared to 6px (`rounded-pill`), per CHANGES-2 §1,
// where the prototype's are 8px. Long names and notes wrap anywhere, so
// nothing scrolls sideways on a phone.

export const SECTION = 'flex flex-col gap-4.5'

export const GRID = 'grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4.5'

export const BUDGET_CARD = `${CARD} flex min-w-0 flex-col gap-3 p-5.5`

export const NAME_ROW = 'flex items-baseline justify-between gap-3'
export const NAME = 'min-w-0 text-body-15 font-semibold text-ink [overflow-wrap:anywhere]'

const STATUS_SHAPE = 'shrink-0 text-body-12 font-semibold'
const STATUS_TONES: Record<BudgetTone, string> = {
  left: 'text-ok',
  near: 'text-warn',
  over: 'text-danger',
}

export function statusClass(tone: BudgetTone): string {
  return `${STATUS_SHAPE} ${STATUS_TONES[tone]}`
}

export const SPENT_ROW = 'flex flex-wrap items-baseline gap-1.5'
export const SPENT = 'font-display text-display-34 font-medium leading-none text-ink'
export const OF_LIMIT = 'text-body-13 text-ink-muted'

export const BAR = `${BAR_TRACK} bg-blush`

const FILL_TONES: Record<BudgetTone, string> = {
  left: 'bg-pink',
  near: 'bg-warn',
  over: 'bg-danger',
}

export function fillClass(tone: BudgetTone): string {
  return `h-full rounded-pill ${FILL_TONES[tone]}`
}

export const FOOT_ROW = 'flex items-center justify-between gap-3'
export const NOTE = 'm-0 min-w-0 text-body-12 text-ink-muted [overflow-wrap:anywhere]'
export const STEP_ROW = 'flex shrink-0 gap-1.5'

export const STEP_BUTTON = `flex size-7 cursor-pointer items-center justify-center rounded-pill border-0 bg-blush text-body-14 text-rose shadow-pill hover:bg-blush-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// The card's own "Delete" and its confirm line.
export const CONFIRM_ROW = 'flex flex-wrap items-center gap-3 border-t border-divider pt-3'
export const CONFIRM_TEXT = 'm-0 text-body-13 text-ink'

export const EMPTY_CARD = `${CARD} flex flex-col items-start gap-2 p-6`
export const EMPTY_TITLE = 'm-0 text-body-15 font-semibold text-ink'

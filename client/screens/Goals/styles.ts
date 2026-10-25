import { BAR_TRACK, CARD, FOCUS } from '../Overview/styles.ts'

// Class lists only the Goals screen uses, from the App.css theme tokens and
// the Goals prototype (docs/design/Divvy.dc.html, the Goals section; update
// 2 surfaces per docs/design/CHANGES-2.md §1 and prd-02 Ruling 13). Card,
// bar, error, muted and secondary-button classes are imported from the
// Overview's styles; field labels, hints and errors from the Settings
// styles.
//
// Buttons are squared to 6px (`rounded-pill`), per CHANGES-2 §1, where the
// prototype's goal buttons are 12px. Long names wrap anywhere and every row
// may shrink, so nothing scrolls sideways on a phone.

export const SECTION = 'flex flex-col gap-4.5'

export const GRID = 'grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4.5'

export const GOAL_CARD = `${CARD} flex min-w-0 flex-col gap-3.5 p-6`

export const NAME_ROW = 'flex items-baseline justify-between gap-3'
export const NAME = 'min-w-0 text-body-15 font-semibold text-ink [overflow-wrap:anywhere]'
export const BY_DATE = 'shrink-0 text-body-12 text-ink-muted'

export const SAVED_ROW = 'flex flex-wrap items-baseline gap-2'
export const SAVED = 'font-display text-display-40 font-medium leading-none text-ink'
export const OF_TARGET = 'text-body-13 text-ink-muted'

export const BAR = `${BAR_TRACK} bg-blush`

export const PACE = 'm-0 text-body-13 text-ink-muted'

export const STEP_ROW = 'flex gap-2'

const STEP_SHAPE = `flex-1 cursor-pointer rounded-pill p-2.5 text-body-13 font-semibold shadow-pill disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// +$50 is blush, +$200 solid pink, as in the prototype.
export const SMALL_STEP = `${STEP_SHAPE} bg-blush text-rose hover:bg-blush-hover`
export const LARGE_STEP = `${STEP_SHAPE} bg-pink text-surface hover:bg-pink-hover`

// The dashed "New goal" card. The prototype's dash is the theme's offset
// colour, which has no colour token; blush-hover is the nearest one.
export const NEW_GOAL_CARD = `flex min-h-50 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-blush-hover bg-transparent p-6 text-ink-muted hover:border-pink hover:bg-blush ${FOCUS}`
export const NEW_GOAL_TITLE = 'font-display text-display-28 font-medium text-ink'
export const NEW_GOAL_HINT = 'text-body-13'

export const NOTE =
  'm-0 rounded-summary bg-surface px-5 py-4 text-body-14 leading-[1.45] text-ink-muted shadow-tile'
export const NOTE_STRONG = 'text-ink'

// The form's fields: no border, on the small offset (CHANGES-2 §1). Focus
// is the outline.
const FIELD_SHAPE =
  'w-full min-w-0 rounded-tile border-0 bg-canvas px-3.5 py-2.5 text-body-14 text-ink shadow-pill disabled:cursor-not-allowed disabled:opacity-50'

// DM Mono is for numbers: the typed target and the date.
export const NUMBER_INPUT = `${FIELD_SHAPE} font-mono ${FOCUS}`

// Words: the name.
export const TEXT_INPUT = `${FIELD_SHAPE} font-sans ${FOCUS}`

export const FORM = 'flex min-w-0 flex-col gap-4'
export const FORM_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4'
export const BUTTON_ROW = 'flex flex-wrap items-center gap-3'

// Solid pink: Save. The Overview's secondary button's size, so Save and
// Cancel sit level.
export const PRIMARY_BUTTON = `cursor-pointer rounded-pill bg-pink px-4 py-2 text-body-13 font-semibold text-surface shadow-pill hover:bg-pink-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

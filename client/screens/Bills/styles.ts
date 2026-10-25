import { FOCUS } from '../Overview/styles.ts'
import type { RowTone } from './format.ts'

// Class lists only the Bills screen uses, from the App.css theme tokens and
// the Bills prototype (docs/design/Divvy.dc.html, the Bills section; update 2
// surfaces per docs/design/CHANGES-2.md §1 and prd-02 Ruling 13). Card,
// error, muted and secondary-button classes are imported from the
// Overview's styles; field classes from the Settings styles.
//
// Rows sit in a size container (the list's `ul`). From `@lg` (32rem wide)
// a row is the prototype's four columns. Narrower, as on a phone, the date
// tile spans two lines: name and amount on the first, the pill under the
// name on the second, so nothing scrolls sideways.

export const SECTION = 'flex flex-col gap-4.5'

export const TILE_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4.5'

const TILE_SHAPE = 'flex flex-col gap-1 rounded-summary p-5 shadow-tile'
export const TILE = `${TILE_SHAPE} bg-surface`
export const BLUSH_TILE = `${TILE_SHAPE} bg-blush`
export const TILE_LABEL = 'text-body-12 text-ink-muted'
export const BLUSH_TILE_LABEL = 'text-body-12 text-rose'
export const TILE_VALUE = 'font-display text-display-34 font-medium leading-none text-ink'
export const TILE_CAPTION = 'm-0 text-body-12 text-ink-muted'

export const LIST = '@container m-0 list-none p-0'

export const ROW =
  'grid grid-cols-[56px_1fr_auto] items-center gap-x-3 gap-y-2 border-b border-divider py-3.5 @lg:grid-cols-[56px_1fr_auto_auto] @lg:gap-x-4 @lg:gap-y-0'

// The row an edit form has replaced.
export const EDIT_ROW = 'border-b border-divider py-4'

const DATE_TILE_SHAPE =
  'row-span-2 flex h-13 w-14 flex-col items-center justify-center rounded-tile @lg:row-span-1'

const TONES: Record<RowTone, string> = {
  next: 'bg-pink text-surface',
  later: 'bg-blush text-rose',
  paid: 'bg-canvas text-ink-muted',
}

export function dateTile(tone: RowTone): string {
  return `${DATE_TILE_SHAPE} ${TONES[tone]}`
}

export const DATE_DAY = 'font-display text-display-22 font-medium leading-none'
export const DATE_MONTH = 'text-[10px] font-semibold uppercase tracking-[0.06em]'

export const NAME_COLUMN = 'flex min-w-0 flex-col gap-0.5'
export const NAME = 'text-body-15 text-ink [overflow-wrap:anywhere]'
export const META_LINE = 'flex flex-wrap items-baseline gap-x-2'
export const META = 'text-body-12 text-ink-muted'
export const AMOUNT = 'whitespace-nowrap font-mono text-body-15 text-ink'

// The row's pill: the prototype's button, carrying the small offset. On a
// narrow row it sits on the second line, under the name.
const PILL = `cursor-pointer whitespace-nowrap rounded-pill px-3.5 py-[7px] text-body-12 font-semibold shadow-pill col-span-2 col-start-2 justify-self-start @lg:col-auto @lg:justify-self-auto ${FOCUS}`
export const MARK_PAID_PILL = `${PILL} bg-blush text-rose hover:bg-blush-hover disabled:cursor-not-allowed disabled:opacity-50`
// Not dimmed again when disabled: the paid row is already at .55.
export const PAID_PILL = `${PILL} cursor-default bg-surface text-ink-muted`

export const EDIT_LINK = `cursor-pointer bg-transparent p-0 text-body-12 font-semibold text-deep hover:text-rose hover:underline ${FOCUS}`

const BUTTON_SHAPE =
  'cursor-pointer rounded-pill px-4 py-2.5 text-body-14 font-semibold text-surface shadow-pill disabled:cursor-not-allowed disabled:opacity-50'

// Solid pink: Add bill and Save.
export const PRIMARY_BUTTON = `${BUTTON_SHAPE} bg-pink hover:bg-pink-hover ${FOCUS}`

// The confirmed delete.
export const DANGER_BUTTON = `${BUTTON_SHAPE} bg-danger ${FOCUS}`

// "Delete bill": a text button, so it does not compete with Save.
export const TEXT_BUTTON = `cursor-pointer bg-transparent p-0 text-body-13 font-semibold text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

export const FORM_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4'
export const BUTTON_ROW = 'flex flex-wrap items-center gap-3'

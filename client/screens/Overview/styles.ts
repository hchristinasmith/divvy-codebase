// Class lists the Overview repeats, from the App.css theme tokens and the
// update 2 surfaces (docs/design/CHANGES-2.md §1, prd-02 Ruling 13): cards
// have no border and sit on the theme's hard offset; pills, buttons and bars
// are squared to 6px. Focus is an outline, never a ring.

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-pink'

// A white card's surface, and the blush one Strawb's figures sit on. Layout
// (flex or grid, gap, padding) is the card's own.
export const CARD = 'rounded-card bg-surface shadow-card'
export const BLUSH_CARD = 'rounded-card bg-blush shadow-card'

// A card's title: 15px semibold, as the prototype's Alerts and Recent
// activity headings.
export const CARD_TITLE = 'm-0 text-body-15 font-semibold'

// The small uppercase label over a figure ("Safe to spend", "Personal").
export const EYEBROW = 'm-0 text-body-12 font-semibold uppercase tracking-eyebrow'

// A 10px bar track; the fill inside it is `BAR_FILL` at an inline width.
export const BAR_TRACK = 'h-2.5 overflow-hidden rounded-pill'
export const BAR_FILL = 'h-full rounded-pill bg-pink'

export const MUTED = 'm-0 text-body-14 text-ink-muted'

export const ERROR = 'm-0 text-body-13 text-danger'

// The blush pill track the scope toggle uses, for the activity sub-filter.
export const PILL_TRACK = 'flex gap-1 rounded-pill bg-blush p-[3px] shadow-pill'

export function pill(active: boolean): string {
  return `cursor-pointer rounded-pill px-3.5 py-1.5 text-body-13 font-medium ${FOCUS} ${
    active ? 'bg-surface text-deep' : 'bg-transparent text-rose'
  }`
}

// Blush: a lesser action such as "Try again".
export const SECONDARY_BUTTON = `cursor-pointer rounded-pill bg-blush px-4 py-2 text-body-13 font-semibold text-rose hover:bg-blush-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// The inline category picker on an activity row: small, so the meta line
// stays one line where it can.
export const SELECT = `max-w-48 rounded-pill bg-canvas px-1.5 py-0.5 font-sans text-body-12 text-ink disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`

// A link as an action: the alert's "See budget" and the More row. The size
// is the caller's.
export const LINK = `font-semibold text-deep hover:text-rose hover:underline ${FOCUS}`

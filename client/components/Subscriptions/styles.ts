// Class lists the Subscriptions screen repeats. A copy of the ones it uses
// from client/screens/Overview/styles.ts, which is another screen's file:
// App.css theme tokens and the update 2 surfaces (docs/design/CHANGES-2.md
// §1, prd-02 Ruling 13). Cards have no border and sit on the theme's hard
// offset; pills and buttons are squared to 6px. Focus is an outline, never
// a ring.

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-pink'

// A white card's surface. Layout (flex or grid, gap, padding) is the
// card's own.
export const CARD = 'rounded-card bg-surface shadow-card'

// A card's title: 15px semibold.
export const CARD_TITLE = 'm-0 text-body-15 font-semibold text-ink'

export const MUTED = 'm-0 text-body-14 text-ink-muted'

export const ERROR = 'm-0 text-body-13 text-danger'

// A pill button's size and states, the design's row button (padding 7px
// 14px, 12px semibold, no wrap). The colours are the caller's.
export const PILL_BUTTON = `cursor-pointer whitespace-nowrap rounded-pill px-3.5 py-[7px] text-body-12 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// Blush: a lesser action such as "Cancel", "Try again", "No" or "Undo".
export const SECONDARY_BUTTON = `${PILL_BUTTON} bg-blush text-rose hover:bg-blush-hover`

// Pink: the answer that adds something, "Yes". Pink buttons carry the
// theme's small offset.
export const PRIMARY_BUTTON = `${PILL_BUTTON} bg-pink text-surface shadow-pill hover:bg-pink-hover`

// A link as an action. The size is the caller's.
export const LINK = `font-semibold text-deep hover:text-rose hover:underline ${FOCUS}`

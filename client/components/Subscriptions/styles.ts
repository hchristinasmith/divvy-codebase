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

// Blush: a lesser action such as "Try again", "No" or "Undo".
export const SECONDARY_BUTTON = `cursor-pointer rounded-pill bg-blush px-4 py-2 text-body-13 font-semibold text-rose hover:bg-blush-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// Pink: the answer that adds something, "Yes".
export const PRIMARY_BUTTON = `cursor-pointer rounded-pill bg-pink px-4 py-2 text-body-13 font-semibold text-surface hover:bg-pink-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// A link as an action. The size is the caller's.
export const LINK = `font-semibold text-deep hover:text-rose hover:underline ${FOCUS}`

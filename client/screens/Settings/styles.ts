// Class lists the settings panel repeats, from the App.css theme tokens
// (docs/design/handoff.md "Design tokens"). The design has no settings
// screen; these follow the card, label and pill shapes the other screens
// use. Focus is an outline, never a ring.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-pink'

// A field's border turns pink on focus too (the handoff's "focus border
// pink"), beside the outline.
const FIELD_FOCUS = `${FOCUS} focus-visible:border-pink`

const FIELD_SHAPE =
  'rounded-tile border border-line bg-canvas px-3.5 py-2.5 text-body-14 text-ink disabled:cursor-not-allowed disabled:opacity-50'

export const CARD = 'rounded-card border border-line bg-surface p-6'

export const HEADING = 'm-0 font-display text-display-22 font-medium text-ink'

export const LABEL = 'text-body-13 font-semibold text-ink'

export const HINT = 'm-0 text-body-12 text-ink-muted'

export const ERROR = 'm-0 text-body-13 text-danger'

export const FIELD_ERROR = 'm-0 text-body-12 text-danger'

// DM Mono is for numbers: the typed amounts and rate.
export const INPUT = `${FIELD_SHAPE} font-mono ${FIELD_FOCUS}`

// Words, not numbers: the payday, currency and role choices.
export const SELECT = `${FIELD_SHAPE} font-sans ${FIELD_FOCUS}`

const BUTTON_SHAPE =
  'cursor-pointer rounded-pill px-4 py-2.5 text-body-14 font-semibold disabled:cursor-not-allowed disabled:opacity-50'

// Solid pink: Save, the one primary action. Carries the theme's small
// offset, as the other pink buttons do (client/components/Subscriptions/styles.ts).
export const PRIMARY_BUTTON = `${BUTTON_SHAPE} bg-pink text-surface shadow-pill hover:bg-pink-hover ${FOCUS}`

// Blush: a lesser action such as "Try again".
export const SECONDARY_BUTTON = `${BUTTON_SHAPE} bg-blush text-rose hover:bg-blush-hover ${FOCUS}`

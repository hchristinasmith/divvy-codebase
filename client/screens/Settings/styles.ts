// Class lists the settings panel repeats, from the App.css theme tokens
// (docs/design/handoff.md "Design tokens"). The design has no settings
// screen; these follow the card, label and pill shapes the other screens
// use. Focus is an outline, never a ring.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-pink'

export const CARD = 'rounded-card border border-line bg-surface p-6'

export const HEADING = 'm-0 font-display text-display-22 font-medium text-ink'

export const LABEL = 'text-body-13 font-semibold text-ink'

export const HINT = 'm-0 text-body-12 text-ink-muted'

export const ERROR = 'm-0 text-body-13 text-danger'

export const FIELD_ERROR = 'm-0 text-body-12 text-danger'

export const INPUT = `rounded-tile border border-line bg-canvas px-3.5 py-2.5 font-mono text-body-14 text-ink ${FOCUS}`

export const PRIMARY_BUTTON = `cursor-pointer rounded-button bg-pink px-4 py-2.5 text-body-14 font-semibold text-surface hover:bg-pink-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

export const SCOPE_TAG =
  'rounded-tag bg-blush px-2 py-0.5 text-body-12 text-rose'

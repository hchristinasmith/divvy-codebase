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
  'cursor-pointer rounded-button px-4 py-2.5 text-body-14 font-semibold disabled:cursor-not-allowed disabled:opacity-50'

// Solid pink: Save, the one primary action.
export const PRIMARY_BUTTON = `${BUTTON_SHAPE} bg-pink text-surface hover:bg-pink-hover ${FOCUS}`

// Blush: a lesser action such as "Try again".
export const SECONDARY_BUTTON = `${BUTTON_SHAPE} bg-blush text-rose hover:bg-blush-hover ${FOCUS}`

// The Personal / Business switch on each account row: ScopeToggle's shapes
// at row size (handoff "Scope toggle"). The track is blush; the pressed
// option is white with deep-rose text, the others transparent rose text.
export const SCOPE_TRACK =
  'inline-flex gap-1 rounded-pill bg-blush p-[3px] shadow-pill'

const SCOPE_OPTION_SHAPE =
  'cursor-pointer rounded-pill px-3 py-1 text-body-13 font-semibold disabled:cursor-not-allowed disabled:opacity-50'

export function scopeOption(pressed: boolean): string {
  const colours = pressed ? 'bg-surface text-deep' : 'bg-transparent text-rose'
  return `${SCOPE_OPTION_SHAPE} ${colours} ${FOCUS}`
}

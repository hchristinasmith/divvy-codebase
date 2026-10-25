// Class lists the Sync screen repeats. A copy of the ones it uses from
// client/screens/Overview/styles.ts and client/components/Subscriptions/
// styles.ts, which are other issues' files: App.css theme tokens and the
// update 2 surfaces (docs/design/CHANGES-2.md §1, prd-02 Ruling 13). Cards
// have no border and sit on the theme's hard offset; pills and buttons are
// squared to 6px. Focus is an outline, never a ring.

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-pink'

// A white card's surface. Layout (flex or grid, gap, padding) is the
// card's own.
export const CARD = 'rounded-card bg-surface shadow-card'

export const MUTED = 'm-0 text-body-14 text-ink-muted'

export const ERROR = 'm-0 text-body-13 text-danger'

// Blush: a lesser action such as "Try again".
export const SECONDARY_BUTTON = `cursor-pointer rounded-pill bg-blush px-4 py-2 text-body-13 font-semibold text-rose hover:bg-blush-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// Pink: the prototype's "Sync now" (padding 10px 18px, 13px semibold, the
// spinner 8px before the label). Pink buttons carry the theme's small
// offset.
export const PRIMARY_BUTTON = `flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-pill bg-pink px-4.5 py-2.5 text-body-13 font-semibold text-surface shadow-pill enabled:hover:bg-pink-hover disabled:cursor-wait ${FOCUS} focus-visible:outline-offset-2`

// The prototype's 12px ring: a faint white track with a white leading edge,
// one turn every 0.8 s, still when the system asks for reduced motion.
export const SPINNER =
  'inline-block h-3 w-3 rounded-full border-2 border-surface/40 border-t-surface animate-[spin_0.8s_linear_infinite] motion-reduce:animate-none'

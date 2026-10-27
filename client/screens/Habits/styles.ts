import { BLUSH_CARD, CARD, EYEBROW, FOCUS } from '../Overview/styles.ts'
import type { Verdict } from '../../../shared/contracts.ts'

// Class lists only the Habits screen uses, from the App.css theme tokens and
// the Habits prototype (docs/design/Divvy.dc.html, the Habits section;
// update 2 surfaces per docs/design/CHANGES-2.md §1 and prd-02 Ruling 13).
// Card, eyebrow, error, muted and secondary-button classes are imported
// from the Overview's styles.
//
// The theme has no 48px or 20px display size, so those sizes are arbitrary
// values, as the prototype gives them. Each grid column may shrink below
// its prototype minimum, so nothing scrolls sideways on a phone.

export const SECTION = 'flex flex-col gap-4.5'

export const TOP_GRID =
  'grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-4.5'
export const BOTTOM_GRID =
  'grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4.5'
export const SIDE_COLUMN = 'flex min-w-0 flex-col gap-4.5'

// Runway: a white card, the eyebrow in deep pink, Outfit 48px.
export const RUNWAY_CARD = `${CARD} flex min-w-0 flex-col gap-1.5 p-6`
export const RUNWAY_EYEBROW = `${EYEBROW} text-deep`
export const RUNWAY_VALUE =
  'm-0 font-display text-[48px] font-medium leading-none tracking-hero text-ink'
export const RUNWAY_NOTE = 'm-0 text-body-14 leading-[1.45] text-ink-muted'

// Streaks: blush, rose text, rows divided by the blush hover colour.
export const STREAKS_CARD = `${BLUSH_CARD} flex min-w-0 flex-col gap-2.5 p-6 text-rose`
export const STREAKS_EYEBROW = EYEBROW
export const STREAK_LIST = 'm-0 flex list-none flex-col gap-2.5 p-0'
export const STREAK_ROW =
  'flex items-baseline justify-between gap-2.5 border-t border-blush-hover py-1.5'
export const STREAK_LABEL = 'text-body-14'
export const STREAK_VALUE =
  'whitespace-nowrap font-display text-[20px] font-semibold text-ink'
export const STREAKS_EMPTY = 'm-0 text-body-14 leading-[1.45]'

// Worth it? and Patterns: white cards with a 15px title and a 13px sub.
export const LIST_CARD = `${CARD} flex min-w-0 flex-col gap-2.5 p-6`
export const TITLE_ROW = 'flex flex-wrap items-baseline justify-between gap-2.5'
export const TITLE = 'm-0 text-body-15 font-semibold text-ink'
export const SUMMARY = 'text-body-12 text-ink-muted'
export const SUB = 'm-0 text-body-13 leading-[1.45] text-ink-muted'
export const EMPTY = 'm-0 border-t border-divider pt-2.5 text-body-14 text-ink-muted'

export const VERDICT_LIST = 'm-0 list-none p-0'
export const VERDICT_ROW =
  'grid grid-cols-[1fr_auto] items-center gap-3 border-t border-divider py-2.5'
export const MERCHANT_COLUMN = 'flex min-w-0 flex-col'
export const MERCHANT = 'truncate text-body-14 text-ink'
export const META = 'text-body-12 text-ink-muted'
export const PILL_ROW = 'flex gap-1.5'

const PILL_SHAPE = `cursor-pointer whitespace-nowrap rounded-pill border-0 px-3 py-1.5 text-body-12 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

// Selected: Worth it green, Not really red, white text. Unselected: blush.
const SELECTED: Record<Verdict, string> = {
  worth_it: 'bg-ok text-surface',
  not_really: 'bg-danger text-surface',
}

export function verdictPill(verdict: Verdict, selected: boolean): string {
  return `${PILL_SHAPE} ${selected ? SELECTED[verdict] : 'bg-blush text-rose hover:bg-blush-hover'}`
}

// Weekly truth report: blush, rose text, 22px by 24px. Not a button: it
// sends nothing and opens nothing, so it has no hover.
export const TRUTH_CARD = `${BLUSH_CARD} flex min-w-0 flex-col gap-1.5 px-6 py-5.5 text-rose`
export const TRUTH_EYEBROW = EYEBROW
export const TRUTH_TITLE =
  'm-0 font-display text-[20px] font-medium leading-[1.2] text-ink'
export const TRUTH_NOTE = 'm-0 text-body-13 leading-[1.45]'

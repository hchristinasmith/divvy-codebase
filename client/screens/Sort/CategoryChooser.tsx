import { useState } from 'react'
import type { CategoryGroup } from '../../../models/categories.ts'
import { FOCUS, MUTED, SECONDARY_BUTTON } from '../Overview/styles.ts'
import { PRIMARY_BUTTON } from '../../components/Subscriptions/styles.ts'
import { COMMON_CATEGORIES } from './commonCategories.ts'

// How a card picks its category: one tap on a common category, or More…
// for the full list in a native select (pattern: the Overview's
// CategoryPicker) and an explicit Apply. Choosing in the select never
// writes on its own: a bulk write needs a deliberate tap. Only names GET
// /api/v1/categories lists are offered, which are the names the apply
// route accepts. Every control is at least 48px tall for a thumb.

// The full-width form of the Overview's inline SELECT, at thumb height.
const SELECT = `min-h-12 w-full min-w-0 rounded-pill bg-canvas px-3 font-sans text-body-14 text-ink disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`

const CHOICE = `${SECONDARY_BUTTON} min-h-12 max-w-full whitespace-normal text-left`

export default function CategoryChooser({
  merchant,
  groups,
  disabled,
  onChoose,
}: {
  merchant: string
  groups: CategoryGroup[] | undefined
  disabled: boolean
  onChoose: (category: string) => void
}) {
  const [more, setMore] = useState(false)
  const [picked, setPicked] = useState('')

  if (groups === undefined) {
    return <p className={MUTED}>Loading categories…</p>
  }

  const offered = new Set(groups.flatMap((g) => g.categories))
  const common = COMMON_CATEGORIES.filter((name) => offered.has(name))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="group"
        aria-label="Common categories"
        className="flex min-w-0 flex-wrap gap-2"
      >
        {common.map((name) => (
          <button
            key={name}
            type="button"
            className={CHOICE}
            disabled={disabled}
            onClick={() => onChoose(name)}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          className={CHOICE}
          aria-expanded={more}
          disabled={disabled}
          onClick={() => setMore((open) => !open)}
        >
          More…
        </button>
      </div>
      {more && (
        <div className="flex min-w-0 flex-col gap-2">
          <select
            aria-label={`Category for ${merchant}`}
            value={picked}
            disabled={disabled}
            onChange={(event) => setPicked(event.target.value)}
            className={SELECT}
          >
            <option value="" disabled>
              Choose a category
            </option>
            {groups.map((group) => (
              <optgroup key={group.name} label={group.name}>
                {group.categories.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            className={`${PRIMARY_BUTTON} min-h-12 self-start`}
            disabled={disabled || picked === ''}
            onClick={() => onChoose(picked)}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  )
}

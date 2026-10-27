import type { CategoryGroup } from '../../../models/categories.ts'
import { SELECT } from './styles.ts'

// The inline category picker on an activity row. A native select, so it works
// with a keyboard and a screen reader as it is. It only offers the names GET
// /api/v1/categories lists, which are the names the update route accepts.
//
// It never shows a category the row does not have: with none it shows
// "Uncategorised"; with one that is not in the list it shows that name as
// an extra option rather than falling back to the first.
export default function CategoryPicker({
  label,
  value,
  groups,
  disabled,
  onChange,
}: {
  label: string
  value: string | null
  groups: CategoryGroup[]
  disabled: boolean
  onChange: (category: string) => void
}) {
  const listed =
    value !== null && groups.some((g) => g.categories.includes(value))
  return (
    <select
      aria-label={`Category for ${label}`}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={SELECT}
    >
      {value === null && (
        <option value="" disabled>
          Uncategorised
        </option>
      )}
      {value !== null && !listed && <option value={value}>{value}</option>}
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
  )
}

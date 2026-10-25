import { formatCents } from '../../../shared/money.ts'
import type { ActivityRow, CategorySource, IsoDate } from '../../../shared/contracts.ts'
import type { CategoryGroup } from '../../../models/categories.ts'
import CategoryPicker from './CategoryPicker.tsx'
import { formatDay } from './format.ts'
import { ERROR } from './styles.ts'

// One recent-activity row (docs/design/handoff.md Screen 1): a P or B tag
// tile, the description, a meta line, and the signed amount.
//
// The meta line carries the effective category and who set it, on every row
// (prd-01 Ruling 4). A category the user chose is marked with a blush chip,
// the subtle marker prd-02 asks for. A pending row cannot be recategorised:
// sync replaces pending rows, so the server refuses the edit (409) and the
// picker is disabled instead of inviting it.

const SOURCE_LABELS: Record<CategorySource, string> = {
  akahu: 'Akahu',
  user: 'You',
  rule: 'Rule',
  claude: 'Claude',
}

const TAGS = {
  personal: { letter: 'P', className: 'bg-canvas text-ink-muted' },
  strawb: { letter: 'B', className: 'bg-pink-hover text-surface' },
} as const

export default function ActivityRowItem({
  row,
  groups,
  saving,
  error,
  today,
  onCategory,
}: {
  row: ActivityRow
  /** The category list, or undefined while it is unavailable (read-only). */
  groups: CategoryGroup[] | undefined
  saving: boolean
  /** The server's message for this row's last failed edit. */
  error: string | null
  /** The server's NZ date today, so the row's date shows its year only when it is not this year. */
  today: IsoDate
  onCategory: (category: string) => void
}) {
  const tag = TAGS[row.scope]
  const pending = row.status === 'pending'
  return (
    <li
      data-activity-id={row.id}
      data-scope={row.scope}
      className="flex flex-col gap-1 border-t border-divider py-3"
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3.5">
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 items-center justify-center rounded-tag-lg font-mono text-body-11 font-semibold ${tag.className}`}
        >
          {tag.letter}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body-14 text-ink">
            {row.description}
          </span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-body-12 text-ink-muted">
            {groups === undefined ? (
              <span data-testid="category-text">
                {row.category ?? 'Uncategorised'}
              </span>
            ) : (
              <CategoryPicker
                label={row.description}
                value={row.category}
                groups={groups}
                disabled={pending || saving}
                onChange={(category) => {
                  if (!pending) onCategory(category)
                }}
              />
            )}
            <span
              data-category-source={row.categorySource}
              className={
                row.categorySource === 'user'
                  ? 'rounded-pill bg-blush px-1.5 font-semibold text-rose'
                  : ''
              }
            >
              {SOURCE_LABELS[row.categorySource]}
            </span>
            <span>·</span>
            <span>{row.accountName}</span>
            <span>·</span>
            <span>{formatDay(row.date, today)}</span>
            {pending && (
              <span className="rounded-pill bg-canvas px-1.5 font-semibold">
                Pending
              </span>
            )}
            {saving && <span>Saving…</span>}
          </span>
        </div>
        <span
          className={`font-mono text-body-14 ${row.amountCents > 0 ? 'text-ok' : 'text-ink'}`}
        >
          {formatCents(row.amountCents)}
        </span>
      </div>
      {error !== null && (
        <p role="alert" className={`${ERROR} pl-[50px]`}>
          {error}
        </p>
      )}
    </li>
  )
}

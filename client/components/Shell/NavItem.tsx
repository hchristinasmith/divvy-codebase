import { NavLink } from 'react-router'
import clsx from 'clsx'
import NavIcon from './icons.tsx'
import type { IconName } from './icons.tsx'

// One sidebar link (docs/design/handoff.md "Interactions"): active is a white
// row with deep-rose text and a solid pink icon tile; inactive a blush tile.
export default function NavItem({
  to,
  label,
  icon,
  badge = 0,
}: {
  to: string
  label: string
  icon: IconName
  badge?: number
}) {
  return (
    <NavLink
      // react-router matches a link to "/" exactly, so Overview is not
      // active on every screen.
      to={to}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 rounded-button px-2.5 py-2 text-left text-body-14 font-medium hover:bg-blush',
          isActive ? 'bg-surface text-deep' : 'text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-tag',
              isActive ? 'bg-pink text-white' : 'bg-blush text-rose',
            )}
          >
            <NavIcon name={icon} />
          </span>
          <span className="flex-1">{label}</span>
          {badge > 0 && (
            <span
              className="font-mono text-body-11 text-pink"
              data-testid="nav-badge"
            >
              {badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

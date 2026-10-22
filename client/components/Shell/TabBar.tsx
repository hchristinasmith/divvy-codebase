import { NavLink } from 'react-router'
import clsx from 'clsx'
import NavIcon from './icons.tsx'
import { tabItems } from './nav.ts'

// The phone tab bar under 720px (docs/design/handoff.md "Global layout";
// prd-02 Done-when 7): fixed, white, a top border, every tap target at least
// 44px tall.
export default function TabBar() {
  return (
    <nav
      aria-label="Tab bar"
      className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shell:hidden"
    >
      {tabItems.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) =>
            clsx(
              'flex min-h-[44px] flex-1 flex-col items-center gap-1 rounded-button px-1 py-1.5 text-body-11 font-semibold',
              isActive ? 'text-deep' : 'text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <span
                className={clsx(
                  'flex h-[22px] w-[30px] items-center justify-center rounded-tag',
                  isActive ? 'bg-pink text-white' : 'bg-blush text-rose',
                )}
              >
                <NavIcon name={item.icon} />
              </span>
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

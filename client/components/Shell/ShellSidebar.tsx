import NavItem from './NavItem.tsx'
import { sidebarItems } from './nav.ts'
import { useAlertCount } from '../../hooks/useAlertCount.ts'

// The 224px desktop sidebar (docs/design/handoff.md "Global layout"); gone
// under 720px, where the tab bar takes over. Named to stay clear of the old
// components/Sidebar.tsx, which the w5 sweep deletes.
export default function ShellSidebar() {
  const alertCount = useAlertCount()
  return (
    <aside className="sticky top-0 hidden h-screen w-56 flex-none flex-col gap-7 border-r border-line px-4 py-7 shell:flex">
      <div className="flex flex-col gap-px px-2">
        <span className="font-display text-display-22 font-semibold leading-none tracking-wordmark">
          DIVVY
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-tagline text-deep">
          Hold the reins
        </span>
      </div>
      <nav aria-label="Primary" className="flex flex-col gap-0.5">
        {sidebarItems.map((item) => (
          <NavItem
            key={item.path}
            to={item.path}
            label={item.label}
            icon={item.icon}
            badge={item.badge === 'alerts' ? alertCount : 0}
          />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1.5 rounded-tile bg-blush p-3.5">
        <div className="flex items-center gap-2 text-body-12 font-semibold text-rose">
          <span className="h-2 w-2 rounded-full bg-ok" />
          Self-hosted
        </div>
        {/* The handoff adds "Nothing leaves it.", which is untrue once the
            advisor reads data through Claude (D3), so it is left out. */}
        <div className="text-body-12 leading-[1.4] text-rose">
          Running on your server.
        </div>
      </div>
    </aside>
  )
}

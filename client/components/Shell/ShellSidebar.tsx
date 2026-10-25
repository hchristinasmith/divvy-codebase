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
      {/* The update 2 wordmark (prd-02 Ruling 13): two lines spread to the
          same 104px, letter by letter and word by word. Spread like that a
          screen reader would spell it out, so it is one image named in
          words. */}
      <div className="flex items-center px-2">
        <div
          role="img"
          aria-label="Divvy, hold the reins"
          className="flex w-[104px] flex-col gap-0.5 text-deep"
        >
          <span className="flex justify-between font-display text-display-22 font-semibold leading-none">
            <span>D</span>
            <span>I</span>
            <span>V</span>
            <span>V</span>
            <span>Y</span>
          </span>
          <span className="flex justify-between whitespace-nowrap text-[10px] font-semibold uppercase tracking-tagline">
            <span>Hold</span>
            <span>the</span>
            <span>reins</span>
          </span>
        </div>
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
      <div className="mt-auto flex flex-col gap-1.5 rounded-tile bg-blush p-3.5 shadow-tile">
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

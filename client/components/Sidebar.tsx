import { NavLink } from 'react-router'
import {
  TrendingUpIcon,
  TargetIcon,
  TrophyIcon,
  SettingsIcon,
  Wand,
  ArrowRightLeft,
  CalendarSearch,
  Menu,
} from 'lucide-react'
import clsx from 'clsx'

const menuItems = [
  {
    title: 'Dashboard',
    url: '/',
    icon: TrendingUpIcon,
    description: 'See how your money flows',
  },
  {
    title: 'Transactions',
    url: '/transactions',
    icon: ArrowRightLeft,
    description: 'View & Manage Transactions',
  },
  {
    title: 'Wishlist',
    url: '/wishlist',
    icon: Wand,
    description: 'Keep tabs on what you want next',
  },
  {
    title: 'Targets',
    url: '/targets',
    icon: TargetIcon,
    description: 'Set and track your goals',
  },
  {
    title: 'Manage Subscripitons',
    url: '/manage-subscriptions',
    icon: CalendarSearch,
    description: 'Manage your subscriptions',
  },
  {
    title: 'Challenges',
    url: '/challenges',
    icon: TrophyIcon,
    description: 'Make money habits stick',
  },
  {
    title: 'Settings',
    url: '/settings',
    icon: SettingsIcon,
    description: 'App preferences',
  },
]

export default function Sidebar({
  isOpen,
  onClose,
  onToggle,
}: {
  isOpen: boolean
  onClose: () => void
  onToggle: () => void
}) {
  return (
    <>
      {/* Sidebar panel */}
      <div className="shadow-md">
        <div
          className={clsx(
            'fixed top-0 left-0 h-full w-[260px] p-6 bg-sidebar text-sidebar-foreground z-40',
            'transition-transform duration-300 ease-in-out transform rounded-r-2xl flex flex-col',
            isOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="mb-10">
            <h2 className="text-2xl font-bold text-sidebar-primary">Divvy</h2>
            <p className="text-sm text-muted-foreground">Manage yah moneys</p>
          </div>

          <nav className="space-y-5">
            {menuItems.map(({ title, url, icon: Icon, description }) => (
              <NavLink
                key={title}
                to={url}
                title={description}
                onClick={onClose}
                className={({ isActive }) =>
                  clsx(
                    'flex items-start gap-3 rounded-lg px-3 py-2 transition-colors group',
                    isActive
                      ? 'bg-accent text-accent-foreground shadow-sm'
                      : 'hover:bg-muted hover:text-foreground text-foreground',
                  )
                }
              >
                <Icon className="w-5 h-5 mt-1 opacity-80 group-hover:opacity-100" />
                <div className="flex flex-col">
                  <span className="font-medium text-sm">{title}</span>
                  <span className="text-xs text-muted-foreground leading-tight">
                    {description}
                  </span>
                </div>
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Toggle Button */}
        <button
          onClick={onToggle}
          aria-label="Toggle sidebar"
          className={clsx(
            'fixed top-4 left-0 z-50 h-10 w-10 text-primary-background',
            'rounded-r-xl  flex items-center justify-center transition-all duration-300',
            isOpen ? 'ml-[250px]' : 'ml-0',
          )}
        >
          <Menu size={20} />
        </button>
      </div>
    </>
  )
}

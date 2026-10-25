import { Link } from 'react-router'
import { LINK } from './styles.ts'

// The phone's way to the screens the tab bar leaves out (prd-02 Ruling 14):
// a footer row under the Overview, hidden at desktop width, where the
// sidebar lists them all.
const LINKS = [
  { to: '/bills', label: 'Bills' },
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/sync', label: 'Sync' },
  { to: '/privacy', label: 'Privacy' },
] as const

export default function MoreLinks() {
  return (
    <nav
      aria-label="More"
      className="flex flex-wrap gap-x-5 gap-y-2 px-1 shell:hidden"
    >
      {LINKS.map(({ to, label }) => (
        <Link key={to} to={to} className={`${LINK} text-body-14`}>
          {label}
        </Link>
      ))}
    </nav>
  )
}

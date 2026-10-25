import clsx from 'clsx'
import { SCOPES, useScope } from '../../context/ScopeContext.tsx'

// All / Personal / Strawb (docs/design/handoff.md "Scope toggle"): a blush
// pill track; the active pill is white with deep-rose text. Update 2
// (prd-02 Ruling 13) squares the pills to 6px and sets the track on an
// offset instead of a border.
export default function ScopeToggle() {
  const { scope, setScope } = useScope()
  return (
    <div
      role="group"
      aria-label="Scope"
      className="flex gap-1 rounded-pill bg-blush p-[3px] shadow-pill"
    >
      {SCOPES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={scope === value}
          onClick={() => setScope(value)}
          className={clsx(
            'cursor-pointer rounded-pill px-3.5 py-1.5 text-body-13 font-semibold',
            scope === value
              ? 'bg-surface text-deep'
              : 'bg-transparent text-rose',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

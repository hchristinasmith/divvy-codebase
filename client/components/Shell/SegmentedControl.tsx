import clsx from 'clsx'

// The header's pill group (docs/design/handoff.md "Global layout", the scope
// toggle): a blush pill track; the pressed pill is white with deep-rose
// text. Update 2 (prd-02 Ruling 13) squares the pills to 6px and sets the
// track on an offset instead of a border. The scope switch and any screen's
// own header control (passed through ScreenHeader's `controls`) share it, so
// they cannot drift apart. `onChange` receives the option's value, never its
// label.
export default function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex gap-1 rounded-pill bg-blush p-[3px] shadow-pill"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={clsx(
            'cursor-pointer rounded-pill px-3.5 py-1.5 text-body-13 font-semibold',
            value === option.value
              ? 'bg-surface text-deep'
              : 'bg-transparent text-rose',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

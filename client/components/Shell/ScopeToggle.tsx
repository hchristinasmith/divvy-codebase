import { SCOPES, useScope } from '../../context/ScopeContext.tsx'
import SegmentedControl from './SegmentedControl.tsx'

// All / Personal / Strawb (docs/design/handoff.md "Scope toggle"): the
// global scope, drawn as the header's pill group (./SegmentedControl.tsx).
export default function ScopeToggle() {
  const { scope, setScope } = useScope()
  return (
    <SegmentedControl
      label="Scope"
      options={SCOPES}
      value={scope}
      onChange={setScope}
    />
  )
}

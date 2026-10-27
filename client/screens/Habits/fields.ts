import type { Verdict } from '../../../shared/contracts.ts'

// What a tap on a verdict pill sends (handoff.md Screen 5, "Tap again to
// clear"): the pill's verdict when it is not the row's verdict, and null,
// which clears it, when it is. The row keeps the server's verdict until the
// write and the refetch after it land; nothing is set on screen first.

export function nextVerdict(current: Verdict | null, tapped: Verdict): Verdict | null {
  return current === tapped ? null : tapped
}

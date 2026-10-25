import { useQuery } from '@tanstack/react-query'
import { overviewQuery } from '../apis/overview.ts'
import { useScope } from '../context/ScopeContext.tsx'

// The number of open alerts, shown as the badge on the Overview nav item
// (docs/design/handoff.md "Interactions": nav badge count = open alerts).
//
// It reads the same query the Overview screen does, under the same key, so
// the badge and the list are one cache entry and cannot disagree: a dismissal
// refetches both at once. Loading or failed reads count as zero, which hides
// the badge rather than showing a number the server did not send.
export function useAlertCount(): number {
  const { scope } = useScope()
  const { data } = useQuery(overviewQuery(scope))
  return data?.alerts.length ?? 0
}

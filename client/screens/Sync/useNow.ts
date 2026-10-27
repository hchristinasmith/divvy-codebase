import { useEffect, useState } from 'react'

// The screen's clock, ticking once a minute so "4 min ago" keeps moving
// between status reads. The same tick the header pill keeps inline in
// client/hooks/useSyncPill.ts, which is outside this issue's fence.
const MINUTE = 60_000

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(id)
  }, [])
  return now
}

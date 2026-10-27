import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { invalidateHabits, setVerdict } from '../../apis/habits.ts'
import type { Verdict, VerdictRow } from '../../../shared/contracts.ts'
import { nextVerdict } from './fields.ts'

// The Habits screen's one write: Hannah's verdict on a spend. It refetches
// the habits in every scope and nothing else; a verdict moves no money, so
// it never invalidates the Overview.
//
// The invalidation is returned from `onSuccess`, so a write stays pending
// until the refetched list lands. Nothing changes on screen before then (no
// optimistic update): the pill shown is always the server's verdict, so it
// is what a reload shows.

const VERDICT_WRITES = ['habits', 'write'] as const

/** True while a verdict write, or the refetch after it, is in flight. */
export function useVerdictWritePending(): boolean {
  return useIsMutating({ mutationKey: VERDICT_WRITES }) > 0
}

export interface TapVerdict {
  /** A tap on `tapped` for `row`: sets it, or clears it if already set. */
  tap: (row: VerdictRow, tapped: Verdict) => void
  /** The server's message for the last failed write, until the next one. */
  error: string | null
}

function sendVerdict(write: {
  transactionId: string
  verdict: Verdict | null
}): Promise<VerdictRow> {
  return setVerdict(write.transactionId, write.verdict)
}

export function useTapVerdict(): TapVerdict {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: VERDICT_WRITES,
    mutationFn: sendVerdict,
    onSuccess: () => invalidateHabits(client),
    // A refusal (the spend is gone, or no longer a settled outflow) means
    // the list on screen is out of date, so it is read again.
    onError: () => {
      void invalidateHabits(client)
    },
  })
  const { mutate } = write
  return {
    // The pills disable on the next render, so a second tap in that gap
    // would still send. The mutation cache knows at once.
    tap: (row, tapped) => {
      if (client.isMutating({ mutationKey: VERDICT_WRITES }) > 0) return
      mutate({
        transactionId: row.transactionId,
        verdict: nextVerdict(row.verdict, tapped),
      })
    },
    error: write.error?.message ?? null,
  }
}

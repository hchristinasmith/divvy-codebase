import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  applyGroup,
  invalidateAfterApply,
  type ApplyGroupBody,
} from '../../apis/categorise.ts'

// The Sort screen's one write: a category for a whole merchant group
// (prd-02 Ruling 17). One mutation key, so one pending flag disables every
// control on the card and a second tap in the gap before the next render is
// dropped.
//
// The invalidation is not awaited: the queue on screen is a snapshot that a
// refetch never reshuffles, so nothing visible waits on it, and the next card
// is ready as soon as the server has answered.

const APPLY_KEY = ['categorise', 'apply'] as const

export interface ApplyGroup {
  /** Sends the write; `onDone` gets how many rows changed. */
  apply: (body: ApplyGroupBody, onDone: (changed: number) => void) => void
  isPending: boolean
  error: string | null
  reset: () => void
}

export function useApplyGroup(): ApplyGroup {
  const client = useQueryClient()
  const pending = useIsMutating({ mutationKey: APPLY_KEY }) > 0
  const write = useMutation({
    mutationKey: APPLY_KEY,
    mutationFn: applyGroup,
    onSuccess: () => {
      void invalidateAfterApply(client)
    },
  })
  const { mutate, reset } = write
  return {
    // The buttons disable on the next render, so a second tap in that gap
    // would still send. The mutation cache knows at once.
    apply: (body, onDone) => {
      if (client.isMutating({ mutationKey: APPLY_KEY }) > 0) return
      mutate(body, { onSuccess: (result) => onDone(result.changed) })
    },
    isPending: pending,
    error: write.error?.message ?? null,
    reset,
  }
}

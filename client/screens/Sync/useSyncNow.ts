import {
  useMutation,
  useMutationState,
  useQueryClient,
} from '@tanstack/react-query'
import { queryKeys } from '../../apis/queryKeys.ts'
import { startSync } from '../../apis/sync.ts'

// "Sync now": one POST to prd-01's trigger, then a re-read of everything
// under the sync-status prefix (the screen's status and accounts, and the
// header pill). Nothing on screen changes until that read lands: no
// optimistic "just now". The rows move only when the server reports a new
// last success.
const SYNC_NOW_KEY = ['syncNow'] as const

interface SyncNow {
  press: () => void
  isPending: boolean
  error: string | null
}

export function useSyncNow(): SyncNow {
  const client = useQueryClient()
  const { mutate } = useMutation({
    mutationKey: SYNC_NOW_KEY,
    mutationFn: () => startSync(),
    // Returned, so the press stays pending until the re-read lands and the
    // status says whether a sync is running.
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.syncStatus.all }),
  })
  // The latest press as the mutation cache holds it, not as this hook's
  // own observer saw it: a press made before the screen was left and
  // opened again still shows busy, and its failure still shows.
  const latest = useMutationState({
    filters: { mutationKey: SYNC_NOW_KEY },
    select: (mutation) => mutation.state,
  }).at(-1)

  return {
    // The mutation cache knows at once that a press is in flight; the
    // button's disabled state only after the next render. Asking the cache
    // keeps a fast double press to one POST.
    press: () => {
      if (client.isMutating({ mutationKey: SYNC_NOW_KEY }) > 0) return
      mutate()
    },
    isPending: latest?.status === 'pending',
    error: latest?.status === 'error' ? (latest.error?.message ?? null) : null,
  }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invalidateOverview, queryKeys } from '../../apis/queryKeys.ts'
import { call } from '../../apis/http.ts'
// Type only: erased from the client bundle.
import type { ListedProposal } from '../../../server/agents/contracts.ts'

// The category agent's inbox as the Overview's suggestions pill reads it
// (prd-04 Ruling 2, #62): the pending proposals, and the accept and reject
// routes from #51. Only the user's tap here changes a category.
//
// Fetch goes through `call` in client/apis/http.ts, as every API module's
// does: a refused request rejects with the server's own `{ error }` text, its
// status when it sent none, or that it could not be reached.
//
// The key lives here because client/apis/queryKeys.ts is not this issue's to
// edit; move it there when a second screen reads proposals.
const PENDING_PROPOSALS_KEY = ['proposals', 'pending'] as const

/** GET /api/v1/agents/proposals, whose status defaults to pending. */
interface ListProposalsResponse {
  items: ListedProposal[]
}

export type ProposalDecision = 'accept' | 'reject'

/** The proposals still waiting for the user's tap. */
export function usePendingProposals() {
  return useQuery({
    queryKey: PENDING_PROPOSALS_KEY,
    queryFn: async () =>
      (await call<ListProposalsResponse>('/agents/proposals')).items,
  })
}

/**
 * Accepts or rejects one proposal. On success the proposal leaves the cached
 * list; an accept also refetches the Overview (its rows and safe-to-spend)
 * and every budget, since the transaction's category moved. A failure leaves
 * the list as it was.
 */
export function useProposalDecision() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: ProposalDecision }) =>
      call<unknown>(`/agents/proposals/${id}/${decision}`, { method: 'POST' }),
    // Not awaited: the row has already left the list, so nothing waits on
    // the refetch.
    onSuccess: (_body, { id, decision }) => {
      client.setQueryData<ListedProposal[]>(PENDING_PROPOSALS_KEY, (items) =>
        items?.filter((p) => p.id !== id),
      )
      if (decision === 'accept') {
        void invalidateOverview(client)
        void client.invalidateQueries({ queryKey: queryKeys.budgets.all })
      }
    },
  })
}

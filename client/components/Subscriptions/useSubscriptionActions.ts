import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  cancelSubscription,
  invalidateSubscriptions,
  markSubscription,
  uncancelSubscription,
  type SubscriptionTarget,
} from '../../apis/subscriptions.ts'
import type {
  SubscriptionAnswer,
  SubscriptionMarkResponse,
} from '../../../shared/contracts.ts'

// Every write the Subscriptions screen sends, through one mutation, so one
// pending flag disables every action button and one error line shows what
// the server refused. A write changes nothing on screen until the refetched
// list arrives (no optimistic update): the list is always the server's.
// Marks cannot move safe-to-spend, so the overview is not invalidated.

type Action =
  | { kind: 'mark'; target: SubscriptionTarget; answer: SubscriptionAnswer | null }
  | { kind: 'cancel'; target: SubscriptionTarget }
  | { kind: 'uncancel'; target: SubscriptionTarget }

function run(action: Action): Promise<SubscriptionMarkResponse> {
  switch (action.kind) {
    case 'mark':
      return markSubscription(action.target, action.answer)
    case 'cancel':
      return cancelSubscription(action.target)
    case 'uncancel':
      return uncancelSubscription(action.target)
  }
}

export interface SubscriptionActions {
  mark: (target: SubscriptionTarget, answer: SubscriptionAnswer | null) => void
  cancel: (target: SubscriptionTarget) => void
  uncancel: (target: SubscriptionTarget) => void
  isPending: boolean
  error: string | null
}

export function useSubscriptionActions(): SubscriptionActions {
  const client = useQueryClient()
  const write = useMutation({
    mutationFn: run,
    // Returned, so the write stays pending until the refetch lands.
    onSuccess: () => invalidateSubscriptions(client),
  })
  const { mutate } = write

  return {
    mark: (target, answer) => mutate({ kind: 'mark', target, answer }),
    cancel: (target) => mutate({ kind: 'cancel', target }),
    uncancel: (target) => mutate({ kind: 'uncancel', target }),
    isPending: write.isPending,
    error: write.error?.message ?? null,
  }
}

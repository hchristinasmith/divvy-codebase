import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { addContribution, createGoal, invalidateGoals } from '../../apis/goals.ts'
import type {
  AddGoalContributionResponse,
  CreateGoalRequest,
  GoalResponse,
} from '../../../shared/contracts.ts'

// The Goals screen's writes: a contribution from +$50 or +$200, and a new
// goal. Each refetches the goals list and nothing else. A contribution is a
// record of a transfer Hannah makes herself, not a transfer, and creating a
// goal moves no money, so neither ever invalidates the Overview (prd-02
// Ruling 5): its hero stays as it was.
//
// The invalidation is returned from `onSuccess`, so a write stays pending
// until the refetched list lands. Nothing changes on screen before then (no
// optimistic update): the saved figure is always the server's.

// Shared by both mutations, so `useGoalWritePending` sees either.
const GOAL_WRITES = ['goals', 'write'] as const

// What the buttons record, in integer cents. The server holds no button
// amounts; the request carries them.
export const STEP_SMALL_CENTS = 5000
export const STEP_LARGE_CENTS = 20000

/** True while any goal write, or the refetch after it, is in flight. */
export function useGoalWritePending(): boolean {
  return useIsMutating({ mutationKey: GOAL_WRITES }) > 0
}

export interface Contribute {
  contribute: (id: string, amountCents: number) => void
  error: string | null
}

function sendContribution(write: {
  id: string
  amountCents: number
}): Promise<AddGoalContributionResponse> {
  return addContribution(write.id, write.amountCents)
}

export function useContribute(): Contribute {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: GOAL_WRITES,
    mutationFn: sendContribution,
    onSuccess: () => invalidateGoals(client),
    // A refusal (the goal is gone) means the list on screen is out of date,
    // so it is read again.
    onError: () => {
      void invalidateGoals(client)
    },
  })
  const { mutate } = write
  return {
    // The buttons disable on the next render, so a second click in that gap
    // would still land and record twice. The mutation cache knows at once.
    contribute: (id, amountCents) => {
      if (client.isMutating({ mutationKey: GOAL_WRITES }) > 0) return
      mutate({ id, amountCents })
    },
    error: write.error?.message ?? null,
  }
}

export interface CreateGoal {
  /** Sends the goal; `onDone` runs once the refetch after it has landed. */
  run: (body: CreateGoalRequest, onDone: (goal: GoalResponse) => void) => void
  isPending: boolean
  error: string | null
  reset: () => void
}

export function useCreateGoal(): CreateGoal {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: GOAL_WRITES,
    mutationFn: createGoal,
    onSuccess: () => invalidateGoals(client),
  })
  const { mutate, reset } = write
  return {
    // The same guard as `contribute`: Save disables on the next render, so
    // a second click in that gap would create a second goal.
    run: (body, onDone) => {
      if (client.isMutating({ mutationKey: GOAL_WRITES }) > 0) return
      mutate(body, { onSuccess: onDone })
    },
    isPending: write.isPending,
    error: write.error?.message ?? null,
    reset,
  }
}

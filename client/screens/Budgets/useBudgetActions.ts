import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createBudget,
  invalidateBudgets,
  removeBudget,
  updateBudget,
} from '../../apis/budgets.ts'
import { queryKeys } from '../../apis/queryKeys.ts'
import type { CreateBudgetRequest } from '../../../shared/contracts.ts'

// The Budgets screen's writes: a − / + step on a limit, a new budget, and a
// delete. Each refetches the budgets and the overview in every scope
// (`invalidateBudgets`), because a limit moves the remaining budget that
// safe-to-spend subtracts (prd-02 Done-when 3). The invalidation is
// returned from `onSuccess`, so the write stays pending until the refetched
// list lands. Nothing changes on screen before then (no optimistic update):
// the limit shown is always the server's.

// Shared by every mutation, so `useBudgetWritePending` sees any of them.
const BUDGET_WRITES = ['budgets', 'write'] as const

/** True while any budget write, or the refetch after it, is in flight. */
export function useBudgetWritePending(): boolean {
  return useIsMutating({ mutationKey: BUDGET_WRITES }) > 0
}

export interface StepLimit {
  /** Sends `limitCents` as the budget's new absolute limit. */
  step: (id: string, limitCents: number) => void
  error: string | null
}

function sendLimit(write: { id: string; limitCents: number }) {
  return updateBudget(write.id, { limitCents: write.limitCents })
}

export function useStepLimit(): StepLimit {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: BUDGET_WRITES,
    mutationFn: sendLimit,
    onSuccess: () => invalidateBudgets(client),
    // A refusal (the budget is gone) means the list on screen is out of
    // date, so it is read again. A refused step moved nothing, so the
    // overview is left alone.
    onError: () => {
      void client.invalidateQueries({ queryKey: queryKeys.budgets.all })
    },
  })
  const { mutate } = write
  return {
    // The buttons disable on the next render, and the step is computed from
    // the limit on screen, so a second click in that gap would send the
    // same limit again. The mutation cache knows at once.
    step: (id, limitCents) => {
      if (client.isMutating({ mutationKey: BUDGET_WRITES }) > 0) return
      mutate({ id, limitCents })
    },
    error: write.error?.message ?? null,
  }
}

export type BudgetWrite =
  | { kind: 'create'; body: CreateBudgetRequest }
  | { kind: 'delete'; id: string }

function send(write: BudgetWrite): Promise<unknown> {
  switch (write.kind) {
    case 'create':
      return createBudget(write.body)
    case 'delete':
      return removeBudget(write.id)
  }
}

export interface BudgetFormWrite {
  /** Sends the write; `onDone` runs once the refetch after it has landed. */
  run: (write: BudgetWrite, onDone: () => void) => void
  isPending: boolean
  error: string | null
  reset: () => void
}

export function useBudgetWrite(): BudgetFormWrite {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: BUDGET_WRITES,
    mutationFn: send,
    onSuccess: () => invalidateBudgets(client),
  })
  const { mutate, reset } = write
  return {
    // Save and Delete disable on the next render, so a second click in that
    // gap would send twice.
    run: (action, onDone) => {
      if (client.isMutating({ mutationKey: BUDGET_WRITES }) > 0) return
      mutate(action, { onSuccess: onDone })
    },
    isPending: write.isPending,
    error: write.error?.message ?? null,
    reset,
  }
}

import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createBill,
  invalidateBills,
  markBillPaid,
  removeBill,
  updateBill,
} from '../../apis/bills.ts'
import { queryKeys } from '../../apis/queryKeys.ts'
import type {
  CreateBillRequest,
  UpdateBillRequest,
} from '../../../shared/contracts.ts'

// The Bills screen's writes. Each one refetches the bills and the overview
// in every scope (`invalidateBills`), and the invalidation is returned from
// `onSuccess`, so the write stays pending until the refetched list lands.
// Nothing changes on screen before then (no optimistic update), and every
// Mark paid pill stays disabled: a second click on a repeating bill would
// otherwise pay its next occurrence too.

// Shared by both mutations, so `useBillWritePending` sees either.
const BILL_WRITES = ['bills', 'write'] as const

/** True while any bill write, or the refetch after it, is in flight. */
export function useBillWritePending(): boolean {
  return useIsMutating({ mutationKey: BILL_WRITES }) > 0
}

export interface PayBill {
  pay: (id: string) => void
  error: string | null
}

export function usePayBill(): PayBill {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: BILL_WRITES,
    mutationFn: markBillPaid,
    onSuccess: () => invalidateBills(client),
    // A refusal ("already paid", not found) means the list on screen is
    // out of date, so it is read again. A refused payment moved nothing, so
    // the overview is left alone.
    onError: () => {
      void client.invalidateQueries({ queryKey: queryKeys.bills.all })
    },
  })
  const { mutate } = write
  return {
    pay: (id) => mutate(id),
    error: write.error?.message ?? null,
  }
}

export type BillWrite =
  | { kind: 'create'; body: CreateBillRequest }
  | { kind: 'update'; id: string; patch: UpdateBillRequest }
  | { kind: 'delete'; id: string }

function send(write: BillWrite): Promise<unknown> {
  switch (write.kind) {
    case 'create':
      return createBill(write.body)
    case 'update':
      return updateBill(write.id, write.patch)
    case 'delete':
      return removeBill(write.id)
  }
}

export interface BillFormWrite {
  /** Sends the write; `onDone` runs once the refetch after it has landed. */
  run: (write: BillWrite, onDone: () => void) => void
  isPending: boolean
  error: string | null
  reset: () => void
}

export function useBillWrite(): BillFormWrite {
  const client = useQueryClient()
  const write = useMutation({
    mutationKey: BILL_WRITES,
    mutationFn: send,
    onSuccess: () => invalidateBills(client),
  })
  const { mutate, reset } = write
  return {
    run: (action, onDone) => mutate(action, { onSuccess: onDone }),
    isPending: write.isPending,
    error: write.error?.message ?? null,
    reset,
  }
}

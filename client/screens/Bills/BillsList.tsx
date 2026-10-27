import type { BillResponse } from '../../../shared/contracts.ts'
import { CARD, MUTED } from '../Overview/styles.ts'
import BillRow from './BillRow.tsx'
import { LIST } from './styles.ts'

// The bills in the order the route sent them: unpaid first, then by due
// date. Nothing is sorted here.
export default function BillsList({
  items,
  editingId,
  busy,
  onPay,
  onEdit,
  onClose,
}: {
  items: BillResponse[]
  editingId: string | null
  busy: boolean
  onPay: (id: string) => void
  onEdit: (id: string) => void
  onClose: () => void
}) {
  return (
    <section aria-label="Bills" className={`${CARD} px-6 py-2`}>
      {items.length === 0 ? (
        <p className={`${MUTED} py-4`}>
          No bills yet. Use Add bill to add the first one.
        </p>
      ) : (
        <ul className={LIST}>
          {items.map((bill, index) => (
            <BillRow
              key={bill.id}
              bill={bill}
              index={index}
              editing={bill.id === editingId}
              busy={busy}
              onPay={onPay}
              onEdit={onEdit}
              onClose={onClose}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

import { formatCents } from '../../../shared/money.ts'
import type { BillResponse } from '../../../shared/contracts.ts'
import BillForm from './BillForm.tsx'
import { dateTileParts, metaLine, rowTone } from './format.ts'
import {
  AMOUNT,
  EDIT_LINK,
  EDIT_ROW,
  MARK_PAID_PILL,
  META,
  META_LINE,
  NAME,
  NAME_COLUMN,
  PAID_PILL,
  ROW,
  DATE_DAY,
  DATE_MONTH,
  dateTile,
} from './styles.ts'

// One bill: its due date, name, meta line, amount and the Mark paid pill.
// Only a one-off is ever paid (issue 35): a repeating bill marked paid comes
// back unpaid on its next due date, so the dimmed, struck-through row and
// the Paid pill are a one-off's. A paid one-off has nothing left to edit.
export default function BillRow({
  bill,
  index,
  editing,
  busy,
  onPay,
  onEdit,
  onClose,
}: {
  bill: BillResponse
  index: number
  editing: boolean
  busy: boolean
  onPay: (id: string) => void
  onEdit: (id: string) => void
  onClose: () => void
}) {
  if (editing) {
    return (
      <li data-bill-id={bill.id} className={EDIT_ROW}>
        <BillForm mode={{ kind: 'edit', bill }} onClose={onClose} />
      </li>
    )
  }

  const { day, month } = dateTileParts(bill.dueDate)
  return (
    <li
      data-bill-id={bill.id}
      className={bill.paid ? `${ROW} opacity-55` : ROW}
    >
      <div data-testid="bill-date" className={dateTile(rowTone(bill, index))}>
        <span className={DATE_DAY}>{day}</span>
        <span className={DATE_MONTH}>{month}</span>
      </div>
      <div className={NAME_COLUMN}>
        <span
          data-testid="bill-name"
          className={bill.paid ? `${NAME} line-through` : NAME}
        >
          {bill.name}
        </span>
        <div className={META_LINE}>
          <span data-testid="bill-meta" className={META}>
            {metaLine(bill)}
          </span>
          {!bill.paid && (
            <button
              type="button"
              className={EDIT_LINK}
              aria-label={`Edit ${bill.name}`}
              onClick={() => onEdit(bill.id)}
            >
              Edit
            </button>
          )}
        </div>
      </div>
      <span data-testid="bill-amount" className={AMOUNT}>
        {formatCents(bill.amountCents)}
      </span>
      {bill.paid ? (
        <button type="button" className={PAID_PILL} disabled>
          Paid
        </button>
      ) : (
        <button
          type="button"
          className={MARK_PAID_PILL}
          aria-label={`Mark ${bill.name} paid`}
          disabled={busy}
          onClick={() => onPay(bill.id)}
        >
          Mark paid
        </button>
      )}
    </li>
  )
}

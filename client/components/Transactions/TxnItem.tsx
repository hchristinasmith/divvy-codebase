import { useState } from 'react'
import type { Transaction } from '../../../models/transactions'
import { TableCell, TableRow } from '@/components/ui/table'
import { Pencil } from 'lucide-react'
import { formatCents } from '../../../shared/money.ts'
import { Button } from '@/components/ui/button'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateTransactionCategory } from '../../apis/apiClient.ts'
import { categories } from '../../../data/cats.js'

// Each category name sits under exactly one group in data/cats.js, so the
// group is a function of the name. It is derived here, never read from
// Akahu's group or the legacy category_group_name (akahu-pending-semantics §4).
const groupByCategory = new Map<string, string>(
  Object.entries(categories).flatMap(([group, names]) =>
    names.map((name): [string, string] => [name, group]),
  ),
)

interface Props {
  transaction: Transaction
}

export default function TxnItems({ transaction }: Props) {
  const [formData, setFormData] = useState({
    description: transaction.description,
    category: transaction.category ?? '',
  })
  const group = transaction.category
    ? groupByCategory.get(transaction.category)
    : undefined
  const [editing, setEditing] = useState(false)

  const queryClient = useQueryClient()

  // Sends the effective category name, the only thing PATCH
  // /api/v1/transactions/:id accepts. TransactionsPage does not mount this row.
  const editTxnMutation = useMutation({
    mutationFn: (category: string) =>
      updateTransactionCategory(transaction.id, category),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['txns'] })
    },
  })

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { id, value } = e.target
    setFormData({ ...formData, [id]: value })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    editTxnMutation.mutate(formData.category)
  }

  return (
    <TableRow>
      <TableCell>{transaction.date}</TableCell>
      <TableCell>
        {editing ? (
          <input
            id="description"
            value={formData.description}
            onChange={handleChange}
            className="border rounded px-2 py-1 w-full"
          />
        ) : (
          transaction.description
        )}
      </TableCell>
      <TableCell className="text-right font-semibold">
        {formatCents(transaction.amount_cents)}
      </TableCell>
      <TableCell>
        {transaction.category && (
          <>
            <div>{transaction.category}</div>
            {group && (
              <div className="text-xs text-muted-foreground">{group}</div>
            )}
          </>
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSubmit}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

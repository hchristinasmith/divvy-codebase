import type { AkahuTransaction } from '../../../models/akahu'

export function transactionsByCategory(transactions: AkahuTransaction[]) {
  return transactions.reduce<Record<string, AkahuTransaction[]>>((groups, tx) => {
    const category = tx.category?.name || 'Unknown'
    if (!groups[category]) {
      groups[category] = []
    }
    groups[category].push(tx)
    return groups
  }, {})
}

export function transactionAnalysis(transactions: AkahuTransaction[]) {
  const totalAmount = transactions.reduce((sum, tx) => sum + tx.amount, 0)
  const avgAmount = transactions.length ? totalAmount / transactions.length : 0
  return {
    totalAmount,
    avgAmount,
    count: transactions.length,
  }
}

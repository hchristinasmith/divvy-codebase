import type { AkahuTransaction } from '../../../models/akahu'

interface TransactionsProps {
  transactions: AkahuTransaction[]
}

export default function Transactions({ transactions }: TransactionsProps) {
  // Get the 5 most recent transactions
  const recentTransactions = [...transactions]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5);

  // Format date to be more readable
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-NZ', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  // Determine if transaction is income or expense
  const getTransactionType = (amount: number) => {
    return amount >= 0 ? 'income' : 'expense';
  };

  return (
    <div>
      <h3>Recent Transactions</h3>
      <div className="transaction-list">
        {recentTransactions.map((tx) => {
          const transactionType = getTransactionType(tx.amount);
          return (
            <div key={tx._id} className={`transaction-card ${transactionType}`}>
              <div className="transaction-info">
                <span className="transaction-title">{tx.description}</span>
                <span className="transaction-date">{formatDate(tx.date.toString())}</span>
                <span className="transaction-category">{tx.category?.name || 'Uncategorized'}</span>
                {tx.pending && <span className="text-ink-muted text-body-12"> Pending</span>}
              </div>
              <div className="transaction-amount">
                {tx.amount >= 0 ? '+' : ''}{tx.amount.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  )
}

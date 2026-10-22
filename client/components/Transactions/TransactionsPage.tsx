import {
  Table,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import LayoutWrapper from '../LayoutWrapper'
import CategoryDropdown from './CategoryDropDown.tsx'
import SearchTxns from './SearchTxns.tsx'
// import TxnItem from './TxnItem.tsx'

// const sampleTransactions = [
//   {
//     id: 'trans_1',
//     date: '2025-06-05',
//     description: 'PT140728 PILATES WIT 7416 QUEENSTOWN 448131051256',
//     amount: -70,
//     category_group_name: 'Health & Fitness',
//   },
//   {
//     id: 'trans_2',
//     date: '2025-06-04',
//     description: 'Coffee Shop',
//     amount: -5,
//     category_group_name: 'Food & Drink',
//   },
//   {
//     id: 'trans_3',
//     date: '2025-06-03',
//     description: 'Salary',
//     amount: 3000,
//     category_group_name: 'Income',
//   },
// ]
export default function Transactions() {
  return (
    <LayoutWrapper>
      <div className="p-6">
        <h2 className="mb-4 text-2xl font-semibold">Transactions</h2>
        <SearchTxns />
        <CategoryDropdown />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          {/* <TableBody>
            {sampleTransactions.map((txn) => (
              <TxnItem key={txn.id} transaction={txn} />
            ))}
          </TableBody> */}
        </Table>
      </div>
    </LayoutWrapper>
  )
}

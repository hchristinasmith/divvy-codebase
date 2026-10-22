import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { ChartPie } from 'lucide-react'
import type { AkahuTransaction } from '../../../models/akahu.ts'

interface SpendingBreakdownProps {
  transactions: AkahuTransaction[]
}

type CategorySummary = {
  name: string
  amount: number
  color: string
  percentage: number
}

function generateColor(index: number) {
  const colors = [
    '#6366F1', // Indigo-500
    '#34D399', // Emerald-400
    '#FBBF24', // Amber-400
    '#F87171', // Red-400
    '#60A5FA', // Blue-400
    '#A78BFA', // Violet-400
    '#67E8F9', // Cyan-300
    '#FB923C', // Orange-400
  ]
  return colors[index % colors.length]
}

function SpendingBreakdown({ transactions }: SpendingBreakdownProps) {
  const expenseTransactions = transactions.filter((tx) => tx.amount < 0)

  const categoryTotalsMap: Record<string, number> = {}
  expenseTransactions.forEach((tx) => {
    const name =
      tx.category?.groups?.personal_finance?.name ||
      tx.category?.name ||
      'Uncategorized'

    categoryTotalsMap[name] =
      (categoryTotalsMap[name] || 0) + Math.abs(tx.amount)
  })

  const totalExpenses = Object.values(categoryTotalsMap).reduce(
    (a, b) => a + b,
    0,
  )

  const categories: CategorySummary[] = Object.entries(categoryTotalsMap).map(
    ([name, amount], i) => ({
      name,
      amount,
      percentage: totalExpenses ? (amount / totalExpenses) * 100 : 0,
      color: generateColor(i),
    }),
  )

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl font-semibold flex items-center gap-2">
          <ChartPie size={20} />
          Spending Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="summary-container max-w-4xl mx-auto p-2 sm:p-4">
          {/* Spending Breakdown */}
          <div className="breakdown-card bg-white rounded shadow p-6 border-0 shadow-none bg-transparent">
            <div className="relative h-8 flex rounded overflow-hidden cursor-pointer select-none">
              {categories.map((cat, i) => (
                <div
                  key={cat.name}
                  style={{
                    width: `${cat.percentage}%`,
                    backgroundColor: cat.color,
                  }}
                  className="transition-all duration-300 hover:opacity-80"
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  aria-label={`${cat.name}: ${cat.percentage.toFixed(
                    1,
                  )}% ($${cat.amount.toFixed(2)})`}
                >
                  {hoveredIndex === i && (
                    <div className="absolute -top-10 left-1/2 transform -translate-x-1/2 bg-gray-900 text-white text-xs rounded py-1 px-2 whitespace-nowrap pointer-events-none z-10 shadow-lg">
                      {cat.name}: {cat.percentage.toFixed(1)}% ($
                      {cat.amount.toFixed(2)})
                    </div>
                  )}
                </div>
              ))}
              {categories.length === 0 && (
                <div className="text-center w-full text-gray-500 flex items-center justify-center italic">
                  No expense data to display.
                </div>
              )}
            </div>

            {/* Legend */}
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {categories.map((cat) => (
                <div key={cat.name} className="flex items-center gap-3">
                  <div
                    className="w-5 h-5 rounded"
                    style={{ backgroundColor: cat.color }}
                  ></div>
                  <div className="flex flex-col">
                    <span className="font-semibold">{cat.name}</span>
                    <span className="text-sm text-gray-600">
                      {cat.percentage.toFixed(1)}% (${cat.amount.toFixed(2)})
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default SpendingBreakdown

'use client'

import { Eye, X } from 'lucide-react'

export interface SaleTransaction {
  docId: string
  id: string
  customer: string
  items: Array<{
    name: string
    quantity: number
    price: number
    categoryId: string
    status: string
  }>
  totalAmount: number
  status: 'completed' | 'voided'
  createdAt: Date | null
}

interface SalesTableProps {
  transactions: SaleTransaction[]
  loading?: boolean
  voidingId?: string | null
  onView: (transaction: SaleTransaction) => void
  onVoid: (transaction: SaleTransaction) => Promise<void> | void
  showVoidAction?: boolean
}

const formatDate = (date: Date | null) => {
  if (!date) return 'N/A'
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const formatAmount = (amount: number) => {
  return amount.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export default function SalesTable({
  transactions,
  loading = false,
  voidingId,
  onView,
  onVoid,
  showVoidAction = false,
}: SalesTableProps) {
  if (loading) {
    return <p className="text-sm text-slate-500">Loading transactions...</p>
  }

  if (transactions.length === 0) {
    return <p className="text-sm text-slate-500">No transactions found.</p>
  }

  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Item Name</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Date & Time</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Transaction ID</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Customer</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Amount</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Status</th>
            <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Actions</th>
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-200">
          {transactions.map((transaction) => {
            const isVoided = transaction.status === 'voided'

            return (
              <tr key={transaction.docId} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm text-slate-700">
                  {transaction.items.length > 0 ? transaction.items.map((item) => item.name).join(', ') : '-'}
                </td>
                <td className="px-4 py-3 text-sm text-slate-700">{formatDate(transaction.createdAt)}</td>
                <td className="px-4 py-3 text-sm font-medium text-slate-900">{transaction.id}</td>
                <td className="px-4 py-3 text-sm text-slate-700">{transaction.customer}</td>
                <td className="px-4 py-3 text-sm font-semibold text-slate-900">{formatAmount(transaction.totalAmount)}</td>
                <td className="px-4 py-3 text-sm">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                      isVoided
                        ? 'bg-red-100 text-red-600'
                        : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {isVoided ? 'Voided' : 'Completed'}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => onView(transaction)}
                      title="View transaction"
                      className="text-slate-700 transition hover:text-slate-900"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    {showVoidAction && (
                      <button
                        onClick={() => onVoid(transaction)}
                        title="Void transaction"
                        disabled={isVoided || voidingId === transaction.docId}
                        className="text-red-600 transition hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

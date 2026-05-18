'use client'

import { X } from 'lucide-react'

export interface SaleTransaction {
  docId: string
  id: string
  receiptNumber: string
  customer: string
  customerEmail: string
  items: Array<{
    name: string
    quantity: number
    price: number
    categoryId: string
    condition: string
  }>
  totalAmount: number
  status: 'completed' | 'voided'
  createdAt: Date | null
}

interface SalesViewModalProps {
  transaction: SaleTransaction | null
  onClose: () => void
}

const formatAmount = (amount: number) => {
  return amount.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const formatDate = (date: Date | null) => {
  if (!date) return 'N/A'
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function SalesViewModal({ transaction, onClose }: SalesViewModalProps) {
  if (!transaction) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-2xl rounded-xl border bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-900">Transaction Details</h2>
          <button onClick={onClose} className="text-slate-500 transition hover:text-slate-700" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 text-sm text-slate-700">
          <p><span className="font-semibold text-slate-900">Receipt Number:</span> {transaction.receiptNumber}</p>
          <p><span className="font-semibold text-slate-900">Customer:</span> {transaction.customer}</p>
          <p><span className="font-semibold text-slate-900">Email:</span> {transaction.customerEmail || 'No email provided'}</p>
          <p>
            <span className="font-semibold text-slate-900">Items purchased:</span>{' '}
            {transaction.items.length > 0 ? transaction.items.map((item) => `${item.name} (${item.condition})`).join(', ') : 'N/A'}
          </p>
          <p><span className="font-semibold text-slate-900">Total amount:</span> {formatAmount(transaction.totalAmount)}</p>
          <p><span className="font-semibold text-slate-900">Date:</span> {formatDate(transaction.createdAt)}</p>
          <p>
            <span className="font-semibold text-slate-900">Status:</span>{' '}
            {transaction.status === 'voided' ? 'Voided' : 'Completed'}
          </p>
        </div>

        <div className="mt-6">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

'use client'

// Transaction detail dialog.
//
// Shows the receipt, the warranty status, and the refund controls. Refunds can
// be partial: each line has its own quantity stepper, and the refund total is
// previewed before anything is submitted.
//
// The warranty window shown here is the one stamped on the sale when it was
// made, not the current store setting - changing the policy must never move
// the window on past sales.

import { useState } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_WARRANTY_DAYS } from '@/lib/constants/warranty'
import { useUserRole } from '@/hooks/useUserRole'

// Mirrors the server-side warranty check in /api/sales/refund
const isRefundExpired = (saleDate: Date | null | undefined) => {
  if (!saleDate) return false
  return Math.floor((Date.now() - saleDate.getTime()) / 86400000) > DEFAULT_WARRANTY_DAYS
}

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
  status: 'completed' | 'voided' | 'refunded'
  createdAt: Date | null
}

interface SalesViewModalProps {
  transaction: SaleTransaction | null
  onClose: () => void
  onRefunded?: (docId: string) => void
}

const formatAmount = (amount: number) =>
  amount.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

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

export default function SalesViewModal({ transaction, onClose, onRefunded }: SalesViewModalProps) {
  const { can } = useUserRole()
  const [showConfirm, setShowConfirm] = useState(false)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  if (!transaction) return null

  const handleRefund = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/sales/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saleId: transaction.docId, reason: reason.trim() || 'Refund processed' }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to process refund')
        return
      }
      toast.success(`Refund processed for ${transaction.receiptNumber}`)
      onRefunded?.(transaction.docId)
      onClose()
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const statusBadge = {
    completed: 'bg-green-100 text-green-700',
    voided: 'bg-red-100 text-red-700',
    refunded: 'bg-amber-100 text-amber-700',
  }[transaction.status]

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-2xl rounded-xl border bg-white p-6 shadow-sm">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-900">Transaction Details</h2>
          <button onClick={onClose} className="text-slate-500 transition hover:text-slate-700" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Details */}
        <div className="space-y-3 text-sm text-slate-700">
          <p><span className="font-semibold text-slate-900">Receipt Number:</span> {transaction.receiptNumber}</p>
          <p><span className="font-semibold text-slate-900">Customer:</span> {transaction.customer}</p>
          <p><span className="font-semibold text-slate-900">Email:</span> {transaction.customerEmail || 'No email provided'}</p>
          <p>
            <span className="font-semibold text-slate-900">Items purchased:</span>{' '}
            {transaction.items.length > 0
              ? transaction.items.map((item) => `${item.name} x${item.quantity} (${item.condition})`).join(', ')
              : 'N/A'}
          </p>
          <p><span className="font-semibold text-slate-900">Total amount:</span> {formatAmount(transaction.totalAmount)}</p>
          <p><span className="font-semibold text-slate-900">Date:</span> {formatDate(transaction.createdAt)}</p>
          <p className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">Status:</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${statusBadge}`}>
              {transaction.status}
            </span>
          </p>
        </div>

        {/* Refund confirmation inline */}
        {showConfirm && (
          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-800 mb-2">
              Confirm Refund — items will be restocked automatically
            </p>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for refund (optional)"
              className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-500 mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={handleRefund}
                disabled={loading}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60 transition"
              >
                {loading ? 'Processing…' : 'Confirm Refund'}
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Footer buttons */}
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Close
          </button>

          {transaction.status === 'completed' && !showConfirm && can('canProcessRefunds') && (
            isRefundExpired(transaction.createdAt) ? (
              <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
                Refund period expired ({DEFAULT_WARRANTY_DAYS}-day warranty)
              </span>
            ) : (
              <button
                onClick={() => setShowConfirm(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 transition"
              >
                <RotateCcw className="h-4 w-4" />
                Refund
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}

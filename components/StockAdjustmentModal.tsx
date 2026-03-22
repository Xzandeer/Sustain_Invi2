'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { Product } from '@/components/ProductTable'

type StockAction = 'add' | 'deduct' | 'transfer'

interface StockAdjustmentModalProps {
  product: Product | null
  isOpen: boolean
  onClose: () => void
  onSubmit: (values: {
    action: StockAction
    quantity: number
    targetCondition?: 'New' | 'Refurbished'
    remarks: string
  }) => Promise<void> | void
  submitting?: boolean
}

export default function StockAdjustmentModal({
  product,
  isOpen,
  onClose,
  onSubmit,
  submitting = false,
}: StockAdjustmentModalProps) {
  const [action, setAction] = useState<StockAction>('add')
  const [quantity, setQuantity] = useState('1')
  const [targetCondition, setTargetCondition] = useState<'New' | 'Refurbished'>('Refurbished')
  const [remarks, setRemarks] = useState('')

  useEffect(() => {
    if (!isOpen || !product) return
    setAction('add')
    setQuantity('1')
    setTargetCondition(product.condition === 'New' ? 'Refurbished' : 'New')
    setRemarks('')
  }, [isOpen, product])

  if (!isOpen || !product) return null

  const alternateCondition = product.condition === 'New' ? 'Refurbished' : 'New'

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const parsedQuantity = Math.floor(Number(quantity))
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      return
    }

    await onSubmit({
      action,
      quantity: parsedQuantity,
      targetCondition: action === 'transfer' ? targetCondition : undefined,
      remarks: remarks.trim(),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">Adjust Stock</h2>
            <p className="text-sm text-slate-500">
              {product.name} ({product.condition} variant)
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 transition hover:text-slate-700" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 sm:grid-cols-3">
          <div>
            <p className="text-slate-500">Current Stock</p>
            <p className="font-semibold text-slate-900">{product.quantity}</p>
          </div>
          <div>
            <p className="text-slate-500">Reserved</p>
            <p className="font-semibold text-slate-900">{product.reservedStock}</p>
          </div>
          <div>
            <p className="text-slate-500">Available to Adjust</p>
            <p className="font-semibold text-slate-900">{product.availableStock}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Action</label>
              <select
                value={action}
                onChange={(event) => setAction(event.target.value as StockAction)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              >
                <option value="add">Add Stock</option>
                <option value="deduct">Deduct Stock</option>
                <option value="transfer">Transfer to Another Condition</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Quantity</label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
                required
              />
            </div>
          </div>

          {action === 'transfer' ? (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Transfer To Condition</label>
              <select
                value={targetCondition}
                onChange={(event) => setTargetCondition(event.target.value === 'New' ? 'New' : 'Refurbished')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              >
                <option value={alternateCondition}>{alternateCondition}</option>
              </select>
              <p className="text-xs text-slate-500">
                This moves quantity from the current variant into a separate {alternateCondition.toLowerCase()} variant record.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-900">Remarks</label>
            <textarea
              value={remarks}
              onChange={(event) => setRemarks(event.target.value)}
              placeholder="Optional reason or reference"
              rows={3}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-sky-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Saving...' : 'Apply Adjustment'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

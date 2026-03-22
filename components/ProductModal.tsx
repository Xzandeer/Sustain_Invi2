'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'

export interface ProductFormValues {
  name: string
  categoryId: string
  price: number
  quantity: number
  minStock: number
  condition: 'New' | 'Refurbished'
  reservedStock?: number
  availableStock?: number
}

interface CategoryOption {
  id: string
  name: string
}

interface ProductModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (values: ProductFormValues) => Promise<void> | void
  categories: CategoryOption[]
  initialValues?: ProductFormValues
  submitting?: boolean
}

export default function ProductModal({
  isOpen,
  onClose,
  onSubmit,
  categories,
  initialValues,
  submitting = false,
}: ProductModalProps) {
  const defaultCategory = useMemo(() => categories[0]?.id ?? '', [categories])

  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState(defaultCategory)
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('')
  const [minStock, setMinStock] = useState('')
  const [condition, setCondition] = useState<'New' | 'Refurbished'>('New')

  useEffect(() => {
    if (!isOpen) return

    if (initialValues) {
      setName(initialValues.name)
      setCategoryId(initialValues.categoryId || defaultCategory)
      setPrice(String(initialValues.price))
      setQuantity(String(initialValues.quantity))
      setMinStock(String(initialValues.minStock))
      setCondition(initialValues.condition)
      return
    }

    setName('')
    setCategoryId(defaultCategory)
    setPrice('')
    setQuantity('')
    setMinStock('')
    setCondition('New')
  }, [isOpen, initialValues, defaultCategory])

  if (!isOpen) return null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const parsedPrice = Number(price)
    const parsedQuantity = Math.floor(Number(quantity))
    const parsedMinStock = Math.floor(Number(minStock))
    if (
      !name.trim() ||
      !categoryId ||
      !Number.isFinite(parsedPrice) ||
      !Number.isFinite(parsedMinStock) ||
      parsedPrice <= 0 ||
      (!initialValues && (!Number.isFinite(parsedQuantity) || parsedQuantity < 0)) ||
      parsedMinStock < 0
    ) {
      return
    }

    await onSubmit({
      name: name.trim(),
      categoryId,
      price: parsedPrice,
      quantity: initialValues ? initialValues.quantity : parsedQuantity,
      minStock: parsedMinStock,
      condition,
      reservedStock: initialValues?.reservedStock,
      availableStock: initialValues?.availableStock,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold text-slate-900">{initialValues ? 'Edit Item' : 'Add Inventory Item'}</h2>
          <button onClick={onClose} className="text-slate-500 transition hover:text-slate-700" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Item Name *</label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ceramic Rice Bowl"
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              />
            </div>
            <div className="space-y-2 sm:col-span-1">
              <label className="text-sm font-medium text-slate-900">Category *</label>
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
                required
              >
                <option value="">Select category</option>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Price *</label>
              <input
                type="number"
                min={0.01}
                step="0.01"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Quantity {initialValues ? '' : '*'}</label>
              {initialValues ? (
                <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                  <p><span className="font-medium text-slate-900">Current Stock:</span> {initialValues.quantity}</p>
                  <p><span className="font-medium text-slate-900">Reserved:</span> {initialValues.reservedStock ?? 0}</p>
                  <p><span className="font-medium text-slate-900">Available:</span> {initialValues.availableStock ?? initialValues.quantity}</p>
                </div>
              ) : (
                <input
                  type="number"
                  min={0}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
                />
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Minimum Stock *</label>
              <input
                type="number"
                min={0}
                value={minStock}
                onChange={(event) => setMinStock(event.target.value)}
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Condition *</label>
              {initialValues ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                  <p><span className="font-medium text-slate-900">Current Condition:</span> {initialValues.condition}</p>
                </div>
              ) : (
                <select
                  value={condition}
                  onChange={(event) => setCondition(event.target.value === 'Refurbished' ? 'Refurbished' : 'New')}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
                  required
                >
                  <option value="New">New</option>
                  <option value="Refurbished">Refurbished</option>
                </select>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-sky-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Saving...' : initialValues ? 'Update Item' : 'Create Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

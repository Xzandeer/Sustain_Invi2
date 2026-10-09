'use client'

// Dialog wrapper around the add / edit item form, opened from Inventory.
// Exports ProductFormValues, the shape the Inventory page saves.

import { useEffect, useMemo, useState } from 'react'
import { MAX_STOCK, MAX_PRICE, MAX_CONDITION_NOTES, clampIntegerInput, clampPriceInput } from '@/lib/constants/limits'
import { apiFetch } from '@/lib/apiFetch'
import { X } from 'lucide-react'
import { DEFAULT_WARRANTY_DAYS } from '@/lib/constants/warranty'

export interface ProductFormValues {
  name: string
  categoryId: string
  price: number
  quantity: number
  minStock: number
  condition: 'New' | 'Refurbished'
  reservedStock?: number
  availableStock?: number
  /** One physical unit with its own record - see the Single item checkbox. */
  isSingleItem?: boolean
  /** Free-text description of this item's actual condition. */
  conditionNotes?: string
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
  const [isSingleItem, setIsSingleItem] = useState(false)
  const [conditionNotes, setConditionNotes] = useState('')
  const [policyDays, setPolicyDays] = useState<number>(DEFAULT_WARRANTY_DAYS)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    apiFetch('/api/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d && typeof d.warrantyDays === 'number') setPolicyDays(d.warrantyDays) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    if (initialValues) {
      setName(initialValues.name)
      setCategoryId(initialValues.categoryId || defaultCategory)
      setPrice(String(initialValues.price))
      setQuantity(String(initialValues.quantity))
      setMinStock(String(initialValues.minStock))
      setCondition(initialValues.condition)
      setIsSingleItem(initialValues.isSingleItem === true)
      setConditionNotes(initialValues.conditionNotes ?? '')
      return
    }

    setName('')
    setCategoryId(defaultCategory)
    setPrice('')
    setQuantity('')
    setMinStock('')
    setCondition('New')
    setIsSingleItem(false)
    setConditionNotes('')
  }, [isOpen, initialValues, defaultCategory])

  if (!isOpen) return null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const parsedPrice = Number(price)
    // A single item is exactly one unit, and warning that it is "low" when its
    // only unit is still on the shelf would be noise - so minimum stock is 0.
    const parsedQuantity = isSingleItem ? 1 : Math.floor(Number(quantity))
    const parsedMinStock = isSingleItem ? 0 : Math.floor(Number(minStock))
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
      isSingleItem: initialValues ? initialValues.isSingleItem === true : isSingleItem,
      conditionNotes: conditionNotes.trim().slice(0, MAX_CONDITION_NOTES),
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
              {/* type="text" + inputMode, not type="number". With type="number"
                  the browser hands back an empty string for partial input like
                  "12e", which would wipe the field mid-typing. */}
              <input
                type="text"
                inputMode="decimal"
                maxLength={String(MAX_PRICE).length + 3}
                value={price}
                onChange={(event) => setPrice(clampPriceInput(event.target.value, price))}
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
              ) : isSingleItem ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                  1 <span className="text-xs text-slate-400">(single item)</span>
                </div>
              ) : (
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={String(MAX_STOCK).length}
                  value={quantity}
                  onChange={(event) => setQuantity(clampIntegerInput(event.target.value, quantity))}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
                />
              )}
            </div>
            {!isSingleItem && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Minimum Stock *</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={String(MAX_STOCK).length}
                value={minStock}
                onChange={(event) => setMinStock(clampIntegerInput(event.target.value, minStock))}
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              />
            </div>
            )}
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

            {/* Single item. For big or high-value goods - appliances,
                furniture, electronics - where every unit differs and its own
                condition affects its price. It gets its own record and never
                merges with similar items. Fixed once created: turning an
                existing stock line into a single item would mean deciding
                which of its units it is. */}
            <div className="space-y-2 sm:col-span-2">
              {initialValues ? (
                initialValues.isSingleItem ? (
                  <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                    This is a single item: one unit, tracked on its own.
                  </p>
                ) : null
              ) : (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={isSingleItem}
                    onChange={(event) => setIsSingleItem(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-sky-900"
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-900">Single item</span>
                    <span className="block text-xs text-slate-500">
                      One unique unit with its own condition and price, for example an appliance or a piece of
                      furniture. It will not be combined with similar items.
                    </span>
                  </span>
                </label>
              )}
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium text-slate-900">
                Condition Notes <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <textarea
                value={conditionNotes}
                onChange={(event) => setConditionNotes(event.target.value.slice(0, MAX_CONDITION_NOTES))}
                rows={2}
                placeholder="e.g. small dent on the side, works perfectly"
                className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500"
              />
              <p className="text-right text-[11px] text-slate-400">
                {conditionNotes.length}/{MAX_CONDITION_NOTES}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">Warranty</label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                <p>
                  <span className="font-medium text-slate-900">{policyDays} days</span> refund window
                </p>
                <p className="mt-0.5 text-xs text-slate-500">Store-wide policy applied to all items.</p>
              </div>
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

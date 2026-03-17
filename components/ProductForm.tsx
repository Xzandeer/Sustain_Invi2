'use client'

import { useEffect, useMemo, useState } from 'react'

export interface ProductFormValues {
  name: string
  sku: string
  category: string
  condition: string
  stock: number
}

interface ProductFormProps {
  categories: string[]
  initialValues?: ProductFormValues
  onSubmit: (values: ProductFormValues) => Promise<void> | void
  onCancel: () => void
  submitting?: boolean
}

const CONDITION_OPTIONS = ['Brand New', 'Refurbished']

export default function ProductForm({
  categories,
  initialValues,
  onSubmit,
  onCancel,
  submitting = false,
}: ProductFormProps) {
  const defaultCategory = useMemo(() => categories[0] ?? 'Uncategorized', [categories])

  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [category, setCategory] = useState(defaultCategory)
  const [condition, setCondition] = useState('Brand New')
  const [stock, setStock] = useState('')

  useEffect(() => {
    if (initialValues) {
      setName(initialValues.name)
      setSku(initialValues.sku)
      setCategory(initialValues.category || defaultCategory)
      setCondition(initialValues.condition || 'Brand New')
      setStock(String(initialValues.stock))
      return
    }

    setName('')
    setSku('')
    setCategory(defaultCategory)
    setCondition('Brand New')
    setStock('')
  }, [initialValues, defaultCategory])

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedName = name.trim()
    const parsedStock = Number(stock)

    if (!trimmedName || !Number.isFinite(parsedStock) || parsedStock < 0) {
      return
    }

    await onSubmit({
      name: trimmedName,
      sku: sku.trim(),
      category: category || defaultCategory,
      condition,
      stock: Math.floor(parsedStock),
    })
  }

  const isStockInvalid = stock !== '' && (!Number.isFinite(Number(stock)) || Number(stock) < 0)

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-2">
          <label htmlFor="name" className="text-lg font-medium text-slate-900">
            Product Name *
          </label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Enter product name"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 text-lg text-slate-900 outline-none transition focus:border-sky-700"
            required
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="sku" className="text-lg font-medium text-slate-900">
            SKU
          </label>
          <input
            id="sku"
            value={sku}
            onChange={(event) => setSku(event.target.value)}
            placeholder="Enter SKU (optional)"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 text-lg text-slate-900 outline-none transition focus:border-sky-700"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="category" className="text-lg font-medium text-slate-900">
            Category
          </label>
          <select
            id="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-lg text-slate-900 outline-none transition focus:border-sky-700"
          >
            {categories.length > 0 ? (
              categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))
            ) : (
              <option value="Uncategorized">Uncategorized</option>
            )}
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor="condition" className="text-lg font-medium text-slate-900">
            Condition
          </label>
          <select
            id="condition"
            value={condition}
            onChange={(event) => setCondition(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-lg text-slate-900 outline-none transition focus:border-sky-700"
          >
            {CONDITION_OPTIONS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor="stock" className="text-lg font-medium text-slate-900">
            Stock Quantity *
          </label>
          <input
            id="stock"
            type="number"
            min={0}
            value={stock}
            onChange={(event) => setStock(event.target.value)}
            placeholder="Enter quantity"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 text-lg text-slate-900 outline-none transition focus:border-sky-700"
            required
          />
          {isStockInvalid && <p className="text-sm text-red-600">Stock quantity must be 0 or higher.</p>}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-sky-900 px-5 py-2.5 text-lg font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Saving...' : initialValues ? 'Update Product' : 'Add Product'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-lg font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
